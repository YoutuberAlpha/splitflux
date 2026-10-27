const assert=require("assert/strict"),fs=require("fs"),os=require("os"),path=require("path");
const {createEngine,captureResponse}=require("../cloud-runtime.cjs");
const {createLiveRuntime}=require("../live-runtime.cjs");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"splitflux-live-test-")),savedEnv={...process.env};
const copy=value=>JSON.parse(JSON.stringify(value));
let payload,queries=0;
const pool={
  async connect(){let pending;return {async query(sql,values){queries++;
    if(sql.includes("SELECT"))return {rows:[{payload:copy(payload)}]};
    if(sql.startsWith("UPDATE"))pending=JSON.parse(values[0]);
    if(sql==="COMMIT")payload=pending;
    return {rows:[]};
  },release(){}};},
  async query(sql,values){queries++;
    if(values[1]!==payload.liveEpoch)return {rowCount:0};
    payload=JSON.parse(values[0]);return {rowCount:1};
  },
};
async function request(runtime,who,route,body){
  const response=captureResponse();
  await runtime.dispatch({method:body?"POST":"GET",url:route,headers:{host:"test.invalid",cookie:[...who.cookies].map(([key,value])=>`${key}=${value}`).join("; ")},body},response);
  for(const cookie of response.getHeader("Set-Cookie")||[]){const part=cookie.split(";")[0],index=part.indexOf("=");who.cookies.set(part.slice(0,index),part.slice(index+1));}
  return {status:response.statusCode,body:JSON.parse(response.body.toString()),response};
}
const credentials=who=>({id:who.session.id,sessionKey:who.session.sessionKey});
(async()=>{
  let first,second;
  try{
    process.env.SPLITFLUX_OWNER_PASSWORD="test-owner-password";
    const seed=path.join(directory,"seed"),engine=createEngine(null,seed),files={};
    for(const name of ["accounts.json","admin-key.json"])files[name]=fs.readFileSync(path.join(seed,name),"utf8");
    payload={version:1,arena:engine.exportState(),files};
    let lost=false;
    first=await createLiveRuntime(pool,{directory:path.join(directory,"first"),origin:"https://game.example",timers:false,onLost(){lost=true;}});
    const owner={cookies:new Map()};owner.session=(await request(first,owner,"/api/session")).body;
    await request(first,owner,"/api/accounts/login",{...credentials(owner),username:"alpha",password:"test-owner-password"});
    const before=queries;
    for(let i=0;i<20;i++)assert.equal((await request(first,owner,"/api/state",{...credentials(owner),running:false,cells:[]})).status,200);
    assert.equal(queries,before,"Live state requests must make zero database queries");
    const guest={cookies:new Map()};guest.session=(await request(first,guest,"/api/session")).body;
    const registered=await request(first,guest,"/api/accounts/register",{...credentials(guest),username:"test_guest",password:"test-guest-password"});
    assert.equal(registered.status,200);
    assert(JSON.parse(payload.files["accounts.json"]).test_guest,"Registration must be committed before responding");
    const key=payload.files["admin-key.json"];
    second=await createLiveRuntime(pool,{directory:path.join(directory,"second"),origin:"https://game.example",timers:false});
    assert.equal(payload.files["admin-key.json"],key,"Restarts must preserve the login signing key");
    assert.equal((await request(second,owner,"/api/state",{...credentials(owner),running:false,cells:[]})).body.isAdmin,true,"Existing remembered owner access must survive migration/restart");
    const committed=JSON.stringify(payload);
    await assert.rejects(first.checkpoint(),/newer live server/);
    assert.equal(lost,true);assert.equal(JSON.stringify(payload),committed,"An obsolete server must not overwrite newer accounts or arena state");
    assert.equal((await request(first,owner,"/health")).status,503);
    console.log("PASS: live input bypasses the database, new accounts save before success, signing keys and owner cookies survive restart, and old servers cannot overwrite a newer arena.");
  }finally{
    await first?.close();await second?.close();
    for(const key of Object.keys(process.env))if(!(key in savedEnv))delete process.env[key];Object.assign(process.env,savedEnv);
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
