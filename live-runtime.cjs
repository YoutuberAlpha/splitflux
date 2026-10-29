const fs=require("fs"),os=require("os"),path=require("path"),crypto=require("crypto"),http=require("http");
const {createEngine,captureResponse,packSnapshot,BACKUP_TABLE,backupFiles,filesChanged,checkAccountsKept}=require("./cloud-runtime.cjs");
const privateFiles=["admin-key.json","accounts.json","bans.json"];

async function createLiveRuntime(pool,options={}) {
  const directory=options.directory||fs.mkdtempSync(path.join(os.tmpdir(),"splitflux-live-"));
  const epoch=crypto.randomUUID(),origin=options.origin||process.env.RENDER_EXTERNAL_URL;
  await pool.query(BACKUP_TABLE);
  const client=await pool.connect();let engine,savedFiles;
  try {
    await client.query("BEGIN");
    const result=await client.query("SELECT payload FROM splitflux_arena WHERE id=1 FOR UPDATE");
    const snapshot=result.rows[0]?.payload;
    if(!snapshot?.files?.["accounts.json"])throw new Error("Initialize the cloud accounts before starting the live server");
    engine=(options.createEngine||createEngine)(snapshot,directory);
    savedFiles=snapshot.files;
    await client.query("UPDATE splitflux_arena SET payload=$1::jsonb,updated_at=now() WHERE id=1",[JSON.stringify({...snapshot,liveEpoch:epoch,liveOrigin:origin,liveFailingSince:undefined})]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  let writes=Promise.resolve(),requests=Promise.resolve(),lost=false,active=false;
  const snapshot=()=>{
    const files={};for(const file of privateFiles){const name=path.join(directory,file);if(fs.existsSync(name))files[file]=fs.readFileSync(name,"utf8");}
    const arena=engine.exportState();
    // Skin pictures (up to 60 KB each) are left out of saves; after a restart the game sends its skin again.
    arena.sessions=arena.sessions.map(session=>({...session,skin:"",skinVersion:0}));
    return packSnapshot({version:1,liveEpoch:epoch,liveOrigin:origin,arena,files});
  };
  function checkpoint(){
    active=false;
    const job=writes.then(async()=>{
      const next=snapshot();
      checkAccountsKept(savedFiles,next.files);
      const result=await pool.query("UPDATE splitflux_arena SET payload=$1::jsonb,updated_at=now() WHERE id=1 AND payload->>'liveEpoch'=$2",[JSON.stringify(next),epoch]);
      if(result.rowCount!==1){lost=true;options.onLost?.();throw new Error("A newer live server owns the arena");}
      if(filesChanged(savedFiles,next.files))await backupFiles(pool,next.files);
      savedFiles=next.files;
    });
    writes=job.catch(()=>{});return job;
  }
  async function handle(request,response){
    if(lost){response.writeHead(503);response.end(JSON.stringify({error:"Server restarting"}));return;}
    active=true;
    const captured=captureResponse();
    await engine.handleRequest(request,captured);
    if(captured.statusCode<400&&["/api/accounts/register","/api/accounts/password","/api/admin/reset-password","/api/admin/ban"].includes(new URL(request.url,"http://game.invalid").pathname))await checkpoint();
    for(const [name,value]of captured.headers)response.setHeader(name,value);
    response.writeHead(captured.statusCode);response.end(captured.body);
  }
  function dispatch(request,response){
    const job=requests.then(()=>handle(request,response));
    requests=job.catch(()=>{});return job;
  }
  const tick=options.timers===false?null:setInterval(()=>{if(!lost)engine.advanceArena();},40);
  // The arena is saved every 30 s while people are playing (each save is ~50-100 KB of outgoing data, which
  // counts against Render's monthly allowance). New accounts and bans are saved straight away (see handle).
  // With nobody playing there is nothing worth saving, so the idle server stays quiet.
  const save=options.timers===false?null:setInterval(()=>{if(active)checkpoint().catch(error=>console.error("Game checkpoint failed",error.code||error.name));},options.saveEveryMs||30000);
  tick?.unref();save?.unref();
  return {engine,dispatch,checkpoint,get active(){return active;},async close(){clearInterval(tick);clearInterval(save);await requests;if(!lost)await checkpoint();}};
}

async function main(){
  const {Pool}=require("pg");
  if(!process.env.DATABASE_URL)throw new Error("Set DATABASE_URL privately before starting the live server");
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000});
  pool.on("error",error=>console.error("Game storage connection failed",error.code||error.name));
  let runtime,realtime;
  const server=http.createServer((request,response)=>runtime.dispatch(request,response).catch(error=>{
    console.error("Live request failed",error.code||error.name);
    if(!response.headersSent)response.writeHead(503,{"Content-Type":"application/json","Cache-Control":"no-store"});
    response.end(JSON.stringify({error:"Unable to complete the request. Please retry."}));
  }));
  runtime=await createLiveRuntime(pool,{onLost(){realtime?.close();server.close();}});
  realtime=runtime.engine.enableRealtime(server,runtime.dispatch);
  server.listen(Number(process.env.PORT)||1000,"0.0.0.0",()=>console.log("SPLITFLUX real-time server ready"));
  const shutdown=async()=>{try{realtime.close();await runtime.close();server.close();await pool.end();}catch{process.exitCode=1;}};
  process.once("SIGTERM",shutdown);process.once("SIGINT",shutdown);
}
if(require.main===module)main().catch(error=>{console.error("Live server startup failed",error.code||error.name);process.exitCode=1;});
module.exports={createLiveRuntime};
