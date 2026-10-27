const fs = require("fs");
const os = require("os");
const path = require("path");

const privateFiles = ["admin-key.json", "accounts.json", "bans.json"];

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
  if (snapshot) engine.importState(snapshot.arena);
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
    })().catch(error=>{initialization=null;throw error;});
    return initialization;
  }
  async function dispatch(request,response) {
    let client;
    try {
      await initialize();
      client=await pool.connect();
      // One row lock owns the arena until its state and response are committed together.
      const results=await client.query("BEGIN; SET LOCAL statement_timeout = '8s'; SET LOCAL lock_timeout = '5s'; SELECT payload FROM splitflux_arena WHERE id=1 FOR UPDATE");
      const result=Array.isArray(results)?results[results.length-1]:results;
      const snapshot=result.rows[0].payload;
      if(snapshot?.liveOrigin){
        await client.query("COMMIT");
        await require("./backend-proxy.cjs").proxyBackend(request,response,snapshot.liveOrigin);
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
      const next={version:1,arena:engine.exportState(),files};
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

module.exports={createCloudHandler,createEngine,captureResponse};
