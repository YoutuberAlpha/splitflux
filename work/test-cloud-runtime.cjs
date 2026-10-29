const assert=require("assert/strict");
const fs=require("fs"), os=require("os"), path=require("path");
const {createCloudHandler,captureResponse,arenaOf,LIVE_TAKEOVER_MS}=require("../cloud-runtime.cjs");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"splitflux-cloud-test-"));
const savedEnv={...process.env};
const store={payload:null,tail:Promise.resolve(),failCommit:false};
const copy=value=>value==null?null:JSON.parse(JSON.stringify(value));
function fakePool() {
  // Small stand-ins for the few direct queries about the live server's note.
  return {async query(sql,values){
    const payload=store.payload||{};
    if(sql.startsWith("SELECT payload->>'liveOrigin'"))return {rows:[{origin:payload.liveOrigin??null,epoch:payload.liveEpoch??null,failing:payload.liveFailingSince??null}]};
    if(sql.includes("'{liveFailingSince}'")){if(payload.liveEpoch===values[1]&&!("liveFailingSince" in payload))store.payload={...payload,liveFailingSince:values[0]};return {rows:[]};}
    if(sql.includes("payload-'liveOrigin'")){if(payload.liveEpoch===values[0]){const {liveOrigin,liveEpoch,liveFailingSince,...rest}=payload;store.payload=rest;}return {rows:[]};}
    if(sql.includes("payload-'liveFailingSince'")){if(payload.liveEpoch===values[0]){const {liveFailingSince,...rest}=payload;store.payload=rest;}return {rows:[]};}
    return {rows:[]};
  },async connect(){
    let unlock, pending, locked=false;
    return {async query(sql,values){
      if(sql.includes("FOR UPDATE")) {
        const previous=store.tail;store.tail=new Promise(resolve=>{unlock=resolve;});await previous;locked=true;
        return {rows:[{payload:copy(store.payload)}]};
      }
      if(sql.startsWith("UPDATE")) pending=JSON.parse(values[0]);
      if(sql==="COMMIT") {if(store.failCommit)throw Object.assign(new Error("Simulated database failure"),{code:"TEST_COMMIT"});store.payload=pending;unlock();locked=false;}
      if(sql==="ROLLBACK"&&locked){unlock();locked=false;}
      return {rows:[]};
    },release(){assert.equal(locked,false,"Every request must release the shared row lock");}};
  }};
}
function player(){return {cookies:new Map(),session:null,snapshot:null};}
async function request(handler,who,route,body) {
  const response=captureResponse();
  await handler({method:body?"POST":"GET",url:route,headers:{host:"example.test",cookie:[...who.cookies].map(([k,v])=>`${k}=${v}`).join("; ")},body},response);
  const cookies=response.getHeader("Set-Cookie")||[];
  for(const cookie of cookies){const entry=cookie.split(";")[0],index=entry.indexOf("=");who.cookies.set(entry.slice(0,index),entry.slice(index+1));}
  return {status:response.statusCode,body:JSON.parse(response.body.toString()),response};
}
function credentials(who){return {id:who.session.id,sessionKey:who.session.sessionKey};}
async function state(handler,who,extra={}) {
  const result=await request(handler,who,"/api/state",{...credentials(who),running:true,
    ackRevision:who.snapshot?.self.revision||0,ackBotRevision:who.snapshot?.botRevision||0,
    ackBotMassRevision:who.snapshot?.botMassRevision||0,cells:who.snapshot?.self.cells||[],...extra});
  assert.equal(result.status,200);who.snapshot=result.body;return result;
}
(async()=>{
 try {
  process.env.SPLITFLUX_OWNER_PASSWORD="test-owner-password";
  process.env.NODE_ENV="test";process.env.SPLITFLUX_TEST_WORLD="1";
  const first=createCloudHandler(fakePool(),{directory:path.join(directory,"first")});
  const second=createCloudHandler(fakePool(),{directory:path.join(directory,"second")});
  const owner=player(),guest=player();
  const sessions=await Promise.all([request(first,owner,"/api/session"),request(second,guest,"/api/session")]);
  owner.session=sessions[0].body;guest.session=sessions[1].body;
  assert.equal(arenaOf(store.payload).sessions.length,2,"Concurrent instances must keep both sessions");
  assert.equal(store.payload.arena,undefined,"The arena is saved compressed");
  assert.equal((await request(first,owner,"/api/accounts/login",{...credentials(owner),username:"alpha",password:"test-owner-password"})).status,200);
  await state(second,owner);
  assert.equal(owner.snapshot.isAdmin,true,"Remembered owner login must work on another instance");
  const bot={netId:"fixture-bot",name:"Alex",botTeam:"Alex",x:2000,y:2000,mass:200,alive:true};
  await state(first,owner,{world:{worldSize:5200,bots:[bot],viruses:[],autoSpikes:false}});
  await state(second,guest);
  assert.equal(guest.snapshot.world.bots[0].netId,"fixture-bot");
  assert.equal((await request(second,guest,"/api/team",{...credentials(guest),team:"Alex",enabled:true})).status,200);
  await state(first,guest,{cursor:{x:3000,y:2000},botSplitCommands:["split-a"]});
  await state(second,guest,{cursor:{x:3000,y:2000},botSplitCommands:["split-b"]});
  assert.equal(guest.snapshot.world.bots.filter(bot=>bot.botTeam==="Alex").length,4,"Split commands must persist across instances");
  await state(first,guest,{cursor:{x:3000,y:2000},botSplitCommands:["split-b"]});
  assert.equal(guest.snapshot.world.bots.filter(bot=>bot.botTeam==="Alex").length,4,"Retries must not duplicate a split");
  const paint=await request(second,owner,"/api/admin/paint-spikes",{...credentials(owner),points:[{x:42,y:42}]});
  assert.equal(paint.body.added,1);
  await state(first,owner);assert.equal(owner.snapshot.world.viruses.length,1);
  const recreated=createCloudHandler(fakePool(),{directory:path.join(directory,"recreated")});
  await state(recreated,owner);assert.equal(owner.snapshot.isAdmin,true);
  assert.equal(owner.snapshot.world.viruses.length,1,"Cold starts must preserve the world");
  const stable=JSON.stringify(store.payload);store.failCommit=true;
  const failed=await request(first,player(),"/api/session");
  assert.equal(failed.status,503);assert.equal(failed.response.getHeader("Set-Cookie"),undefined,"A failed commit must not send a successful session cookie");
  assert.equal(JSON.stringify(store.payload),stable,"Failed transactions must not replace committed game data");
  store.failCommit=false;assert.equal((await request(second,player(),"/api/session")).status,200);

  // A live server is running: Vercel passes requests on to it.
  store.payload={...store.payload,liveOrigin:"https://live.example",liveEpoch:"epoch-1"};
  let liveUp=true,forwards=0;
  const viaVercel=createCloudHandler(fakePool(),{directory:path.join(directory,"vercel"),async forwardRequest(){
    forwards++;if(!liveUp)throw new Error("unreachable");
    return {status:200,headers:{"content-type":"application/json"},cookies:[],body:Buffer.from(JSON.stringify({live:true}))};
  }});
  assert.equal((await request(viaVercel,player(),"/api/session")).body.live,true,"Requests go to the live server");
  // It stops answering: players are told it is waking up, and the time it went quiet is noted.
  liveUp=false;
  let waking=await request(viaVercel,player(),"/api/session");
  assert.equal(waking.status,503);assert.match(waking.body.error,/waking up/);
  const quietSince=Number(store.payload.liveFailingSince);assert(quietSince>0,"The first failure is noted");
  // It comes back within the grace time: the note is cleared and nothing changes.
  liveUp=true;await request(viaVercel,player(),"/api/session");
  assert.equal(store.payload.liveFailingSince,undefined,"A working live server clears the note");
  // Down for longer than the grace time: Vercel runs the arena from the database instead.
  liveUp=false;await request(viaVercel,player(),"/api/session");
  const realNow=Date.now;
  try {
    Date.now=()=>realNow()+LIVE_TAKEOVER_MS+1000;
    const takenOver=await request(viaVercel,player(),"/api/session");
    assert.equal(takenOver.status,200,"After the grace time the database answers");assert(takenOver.body.id,"A real session from the database arena");
    assert.equal(store.payload.liveOrigin,undefined,"The live server's note is removed");assert.equal(store.payload.liveEpoch,undefined);
    const before=forwards;
    assert.equal((await request(viaVercel,player(),"/api/session")).status,200);
    assert.equal(forwards,before,"Later requests no longer wait for the dead live server");
  } finally {Date.now=realNow;}
  console.log("PASS: concurrent cloud instances share one arena, owner cookies and keys survive cold starts, teams/splits/spikes persist, failed commits roll back before responding, saves are compressed, a live server that stays down for 150 s is replaced by the database arena.");
 } finally {
  for(const key of Object.keys(process.env))if(!(key in savedEnv))delete process.env[key];
  Object.assign(process.env,savedEnv);
  fs.rmSync(directory,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
