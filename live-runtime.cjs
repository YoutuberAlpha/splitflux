const fs=require("fs"),os=require("os"),path=require("path"),crypto=require("crypto"),http=require("http");
const {createEngine,captureResponse}=require("./cloud-runtime.cjs");
const privateFiles=["admin-key.json","accounts.json","bans.json"];

async function createLiveRuntime(pool,options={}) {
  const directory=options.directory||fs.mkdtempSync(path.join(os.tmpdir(),"splitflux-live-"));
  const epoch=crypto.randomUUID(),origin=options.origin||process.env.RENDER_EXTERNAL_URL;
  const client=await pool.connect();let engine;
  try {
    await client.query("BEGIN");
    const result=await client.query("SELECT payload FROM splitflux_arena WHERE id=1 FOR UPDATE");
    const snapshot=result.rows[0]?.payload;
    if(!snapshot?.files?.["accounts.json"])throw new Error("Initialize the cloud accounts before starting the live server");
    engine=(options.createEngine||createEngine)(snapshot,directory);
    await client.query("UPDATE splitflux_arena SET payload=$1::jsonb,updated_at=now() WHERE id=1",[JSON.stringify({...snapshot,liveEpoch:epoch,liveOrigin:origin})]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  let writes=Promise.resolve(),requests=Promise.resolve(),lost=false;
  const snapshot=()=>{
    const files={};for(const file of privateFiles){const name=path.join(directory,file);if(fs.existsSync(name))files[file]=fs.readFileSync(name,"utf8");}
    return {version:1,liveEpoch:epoch,liveOrigin:origin,arena:engine.exportState(),files};
  };
  function checkpoint(){
    const job=writes.then(async()=>{
      const result=await pool.query("UPDATE splitflux_arena SET payload=$1::jsonb,updated_at=now() WHERE id=1 AND payload->>'liveEpoch'=$2",[JSON.stringify(snapshot()),epoch]);
      if(result.rowCount!==1){lost=true;options.onLost?.();throw new Error("A newer live server owns the arena");}
    });
    writes=job.catch(()=>{});return job;
  }
  async function handle(request,response){
    if(lost){response.writeHead(503);response.end(JSON.stringify({error:"Server restarting"}));return;}
    const captured=captureResponse();
    await engine.handleRequest(request,captured);
    if(captured.statusCode<400&&["/api/accounts/register","/api/admin/ban"].includes(new URL(request.url,"http://game.invalid").pathname))await checkpoint();
    for(const [name,value]of captured.headers)response.setHeader(name,value);
    response.writeHead(captured.statusCode);response.end(captured.body);
  }
  function dispatch(request,response){
    const job=requests.then(()=>handle(request,response));
    requests=job.catch(()=>{});return job;
  }
  const tick=options.timers===false?null:setInterval(()=>{if(!lost)engine.advanceArena();},40);
  const save=options.timers===false?null:setInterval(()=>checkpoint().catch(error=>console.error("Game checkpoint failed",error.code||error.name)),5000);
  tick?.unref();save?.unref();
  return {engine,dispatch,checkpoint,async close(){clearInterval(tick);clearInterval(save);await requests;if(!lost)await checkpoint();}};
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
