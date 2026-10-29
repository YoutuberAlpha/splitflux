const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {proxyBackend, forwardRequest, sendForwarded} = require("./backend-proxy.cjs");

const privateFiles = ["admin-key.json", "accounts.json", "bans.json"];

// The arena is saved compressed (roughly a third of the size). Every read and write of it counts against
// the database's monthly data allowance, so smaller saves mean the free plan lasts longer.
function packSnapshot(snapshot) {
  const {arena, ...rest} = snapshot;
  return {...rest, packedArena: zlib.deflateRawSync(JSON.stringify(arena)).toString("base64")};
}
function arenaOf(snapshot) {
  if (typeof snapshot?.packedArena === "string") return JSON.parse(zlib.inflateRawSync(Buffer.from(snapshot.packedArena, "base64")).toString());
  return snapshot?.arena;
}

// Accounts, bans and the login key are the data that can't be rebuilt. Every time they change, a copy goes into
// a backup table (the newest 50 are kept), and a save that would lose an account is refused: there is no way to
// delete accounts in the game, so that could only be a bug.
const BACKUP_TABLE = "CREATE TABLE IF NOT EXISTS splitflux_backups (id bigserial PRIMARY KEY, files jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())";
async function backupFiles(db, files) {
  await db.query("INSERT INTO splitflux_backups (files) VALUES ($1::jsonb)", [JSON.stringify(files)]);
  await db.query("DELETE FROM splitflux_backups WHERE id <= (SELECT id FROM splitflux_backups ORDER BY id DESC OFFSET 50 LIMIT 1)");
}
const filesChanged = (before, after) => JSON.stringify(before || {}) !== JSON.stringify(after || {});
function checkAccountsKept(before, after) {
  const previous = Object.keys(JSON.parse(before?.["accounts.json"] || "{}"));
  const next = JSON.parse(after?.["accounts.json"] || "{}");
  if (previous.some(name => !Object.hasOwn(next, name))) throw new Error("Refusing to save: accounts would be lost");
}

// When the live game server (Render) can't be reached, players see "waking up" while it starts (a free
// server sleeps when nobody plays and takes up to a minute or two to wake). If it is still unreachable after
// 150 s, it is probably down for longer (for example out of its monthly allowance), so Vercel takes over and
// runs the arena from the database. When the live server starts again it claims the arena back.
const LIVE_TIMEOUT_MS = 12_000;
const LIVE_TAKEOVER_MS = 150_000;
const unhealthy = status => status === 502 || status === 503 || status === 504;
const MARK_FAILING = "UPDATE splitflux_arena SET payload=jsonb_set(payload,'{liveFailingSince}',to_jsonb($1::text)) WHERE id=1 AND payload->>'liveEpoch'=$2 AND NOT (payload ? 'liveFailingSince')";
const CLEAR_FAILING = "UPDATE splitflux_arena SET payload=payload-'liveFailingSince' WHERE id=1 AND payload->>'liveEpoch'=$1";
const TAKE_OVER = "UPDATE splitflux_arena SET payload=payload-'liveOrigin'-'liveEpoch'-'liveFailingSince' WHERE id=1 AND payload->>'liveEpoch'=$1";
const LIVE_MARKER = "SELECT payload->>'liveOrigin' AS origin, payload->>'liveEpoch' AS epoch, payload->>'liveFailingSince' AS failing FROM splitflux_arena WHERE id=1";

function createEngine(snapshot, directory) {
  fs.mkdirSync(directory, {recursive:true});
  for (const name of privateFiles) {
    const filename=path.join(directory,name);
    if (snapshot?.files?.[name]) fs.writeFileSync(filename,snapshot.files[name],{mode:0o600});
    else fs.rmSync(filename,{force:true});
  }
  process.env.SPLITFLUX_CLOUD_MODE="1";
  process.env.SPLITFLUX_DATA_DIR=directory;
  delete require.cache[require.resolve("./server.cjs")];
  const engine=require("./server.cjs");
  if (snapshot) engine.importState(arenaOf(snapshot));
  return engine;
}

function captureResponse() {
  const headers = new Map();
  return {
    statusCode:200, headers, body:Buffer.alloc(0), ended:false,
    setHeader(name,value){headers.set(name,value);},
    getHeader(name){return headers.get(name);},
    writeHead(status,values={}){this.statusCode=status;for(const [name,value] of Object.entries(values))this.setHeader(name,value);},
    end(body=""){this.body=Buffer.isBuffer(body)?body:Buffer.from(String(body));this.ended=true;},
  };
}

function createCloudHandler(pool, options={}) {
  let initialization=null, queue=Promise.resolve();
  const directory=options.directory||fs.mkdtempSync(path.join(os.tmpdir(),"splitflux-cloud-"));
  const makeEngine=options.createEngine||createEngine;
  async function initialize() {
    if (!initialization) initialization=(async()=>{
      await pool.query("CREATE TABLE IF NOT EXISTS splitflux_arena (id integer PRIMARY KEY, payload jsonb, updated_at timestamptz NOT NULL DEFAULT now())");
      await pool.query("INSERT INTO splitflux_arena (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
      await pool.query(BACKUP_TABLE);
    })().catch(error=>{initialization=null;throw error;});
    return initialization;
  }
  // Returns true when the live server (or a "waking up" message) answered; false when Vercel took over.
  async function throughLiveServer(request,response,live) {
    let forwarded=null;
    try {forwarded=await (options.forwardRequest||forwardRequest)(request,live.origin,LIVE_TIMEOUT_MS);} catch {}
    if (forwarded && !unhealthy(forwarded.status)) {
      if (live.failing) await pool.query(CLEAR_FAILING,[live.epoch]);
      sendForwarded(response,forwarded);
      return true;
    }
    const failingSince=Number(live.failing)||0;
    if (!failingSince) await pool.query(MARK_FAILING,[String(Date.now()),live.epoch]);
    else if (Date.now()-failingSince>=LIVE_TAKEOVER_MS) {
      await pool.query(TAKE_OVER,[live.epoch]);
      console.error("SPLITFLUX live server unreachable; running the arena from the database");
      return false;
    }
    if (forwarded) sendForwarded(response,forwarded);
    else {
      response.writeHead(503,{"Content-Type":"application/json","Cache-Control":"no-store","Retry-After":"3"});
      response.end(JSON.stringify({error:"The game server is waking up. Please retry shortly."}));
    }
    return true;
  }
  async function dispatch(request,response) {
    let client;
    try {
      await initialize();
      // A quick look at who runs the arena (a few bytes) instead of loading the whole saved arena.
      const live=(await pool.query(LIVE_MARKER)).rows[0];
      if (live?.origin && await throughLiveServer(request,response,live)) return;
      client=await pool.connect();
      // One row lock owns the arena until its state and response are committed together.
      const results=await client.query("BEGIN; SET LOCAL statement_timeout = '8s'; SET LOCAL lock_timeout = '5s'; SELECT payload FROM splitflux_arena WHERE id=1 FOR UPDATE");
      const result=Array.isArray(results)?results[results.length-1]:results;
      const snapshot=result.rows[0].payload;
      if(snapshot?.liveOrigin){
        // A live server started a moment ago; let it answer.
        await client.query("COMMIT");
        await proxyBackend(request,response,snapshot.liveOrigin,LIVE_TIMEOUT_MS);
        return;
      }
      const engine=makeEngine(snapshot,directory);
      engine.advanceArena();
      const captured=captureResponse();
      await engine.handleRequest(request,captured);
      if (!captured.ended) throw new Error("The game did not complete its response");
      const files={};
      for (const name of privateFiles) {
        const filename=path.join(directory,name);
        if (fs.existsSync(filename)) files[name]=fs.readFileSync(filename,"utf8");
      }
      checkAccountsKept(snapshot?.files,files);
      if (filesChanged(snapshot?.files,files)) await backupFiles(client,files);
      const next=packSnapshot({version:1,arena:engine.exportState(),files});
      await client.query("UPDATE splitflux_arena SET payload=$1::jsonb, updated_at=now() WHERE id=1",[JSON.stringify(next)]);
      await client.query("COMMIT");
      for (const [name,value] of captured.headers) response.setHeader(name,value);
      response.writeHead(captured.statusCode);
      response.end(captured.body);
    } catch(error) {
      if(client) {try {await client.query("ROLLBACK");} catch {}}
      console.error("SPLITFLUX cloud request failed",error.code||error.name);
      response.writeHead(503,{"Content-Type":"application/json","Cache-Control":"no-store","Retry-After":"1"});
      response.end(JSON.stringify({error:"The shared arena is temporarily unavailable. Please retry."}));
    } finally {client?.release();}
  }
  return (request,response)=>{
    const job=queue.then(()=>dispatch(request,response));
    queue=job.catch(()=>{});
    return job;
  };
}

module.exports={createCloudHandler,createEngine,captureResponse,packSnapshot,arenaOf,LIVE_TAKEOVER_MS,BACKUP_TABLE,backupFiles,filesChanged,checkAccountsKept};
