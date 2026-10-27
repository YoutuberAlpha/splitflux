const assert=require("assert/strict"),fs=require("fs"),os=require("os"),path=require("path");
const {spawn}=require("child_process");
const {WebSocket}=require("ws");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"splitflux-realtime-test-"));
const base="http://127.0.0.1:11008";
let processHandle;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function client(){return {cookies:new Map(),session:null};}
async function request(who,route,body){
  const response=await fetch(base+route,{method:body?"POST":"GET",headers:{"Content-Type":"application/json",Cookie:[...who.cookies].map(([k,v])=>`${k}=${v}`).join("; ")},body:body?JSON.stringify(body):undefined});
  for(const cookie of response.headers.getSetCookie()){const part=cookie.split(";")[0],split=part.indexOf("=");who.cookies.set(part.slice(0,split),part.slice(split+1));}
  return {status:response.status,body:await response.json()};
}
function credentials(who){return {id:who.session.id,sessionKey:who.session.sessionKey};}
async function socket(who){
  const config=await request(who,"/api/realtime-ticket",credentials(who));assert.equal(config.status,200);assert(config.body.available);
  const ws=new WebSocket(config.body.url,{origin:base});
  ws.on("error",()=>{});
  await new Promise((resolve,reject)=>{ws.once("open",()=>{ws.send(JSON.stringify({type:"auth",ticket:config.body.ticket}));});ws.once("message",raw=>{assert.equal(JSON.parse(raw).type,"ready");resolve();});ws.once("error",reject);});
  return {ws,ticket:config.body.ticket};
}
let sequence=0;
async function state(connection,payload){
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Socket state timed out")),2000);
    connection.ws.once("message",raw=>{clearTimeout(timer);const result=JSON.parse(raw);assert.equal(result.sequence,id);assert.equal(result.status,200);resolve(result.body);});
    connection.ws.send(JSON.stringify({type:"state",sequence:id,payload}));
  });
}
(async()=>{
  const sockets=[];
  try{
    processHandle=spawn(process.execPath,[path.join(__dirname,"..","server.cjs")],{env:{...process.env,NODE_ENV:"test",SPLITFLUX_TEST_TRUST_CLIENT:"1",PORT:"11008",SPLITFLUX_DATA_DIR:directory,SPLITFLUX_OWNER_PASSWORD:"test-owner-password"},stdio:["ignore","pipe","pipe"]});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Server did not start")),10000);processHandle.once("error",reject);processHandle.stdout.on("data",chunk=>{if(chunk.toString().includes("OWNER PC:")){clearTimeout(timer);resolve();}});});
    const first=client(),second=client();
    first.session=(await request(first,"/api/session")).body;second.session=(await request(second,"/api/session")).body;
    const a=await socket(first),b=await socket(second);sockets.push(a.ws,b.ws);
    const cell={netId:"player-a",x:2000,y:2000,mass:300,alive:true};
    let result=await state(a,{running:true,cells:[cell],name:"First",ackRevision:0});
    await state(b,{running:true,cells:[{...cell,netId:"player-b",x:4000,y:4000}],name:"Second",ackRevision:0});
    result=await state(a,{running:true,cells:result.self.cells,ackRevision:result.self.revision});
    assert.equal(result.playerCount,2);assert(result.players.some(player=>player.id===second.session.id));
    result=await state(a,{running:true,cells:result.self.cells,ackRevision:result.self.revision,id:second.session.id,sessionKey:second.session.sessionKey,immune:true,
      ejectedAdditions:[{netId:"socket-feed",ownerCellId:"player-a",dirX:1,dirY:0}]});
    assert.equal(result.self.id,first.session.id,"A socket must not impersonate another session");assert.equal(result.isAdmin,false);
    assert.equal(result.self.cells[0].mass,275,"Socket feeding must charge exactly once");
    const start=performance.now();
    for(let i=0;i<15;i++)result=await state(a,{running:true,cells:result.self.cells,ackRevision:result.self.revision});
    const average=(performance.now()-start)/15;
    const replay=new WebSocket(base.replace("http:","ws:")+"/realtime",{origin:base});sockets.push(replay);replay.on("error",()=>{});
    const rejected=new Promise(resolve=>replay.once("close",code=>resolve(code)));
    replay.on("open",()=>replay.send(JSON.stringify({type:"auth",ticket:a.ticket})));
    assert.equal(await rejected,4001,"Connection tickets must be single-use");
    const closed=new Promise(resolve=>a.ws.once("close",resolve));
    assert.equal((await request(first,"/api/accounts/login",{...credentials(first),username:"alpha",password:"test-owner-password"})).status,200);
    await closed;
    const owner=await socket(first);sockets.push(owner.ws);
    result=await state(owner,{running:false,cells:[]});assert.equal(result.isAdmin,true,"Owner access must survive switching to a socket");
    const ownerClosed=new Promise(resolve=>owner.ws.once("close",resolve));
    assert.equal((await request(first,"/api/accounts/logout",credentials(first))).status,200);await ownerClosed;
    const guest=await socket(first);sockets.push(guest.ws);
    result=await state(guest,{running:false,cells:[]});assert.equal(result.isAdmin,false,"Logout must revoke socket admin access");
    const Transport=require("../transport.js");
    class TestSocket extends WebSocket {constructor(url){super(url,{origin:base});}}
    const transport=Transport.create({WebSocket:TestSocket,fetch:(route,options)=>fetch(base+route,{...options,headers:{...options?.headers,Cookie:[...second.cookies].map(([key,value])=>`${key}=${value}`).join("; ")}})});
    assert.equal(await transport.connect(second.session),true);
    assert.equal(transport.realtime,true);
    const transported=await transport.state({running:false,cells:[]});assert.equal((await transported.json()).self.id,second.session.id);
    transport.reset();assert.equal(transport.realtime,false);
    const forbidden=new WebSocket(base.replace("http:","ws:")+"/realtime",{origin:"https://untrusted.invalid"});sockets.push(forbidden);forbidden.on("error",()=>{});
    await new Promise(resolve=>forbidden.once("unexpected-response",(_,response)=>{assert.equal(response.statusCode,403);response.resume();forbidden.terminate();resolve();}));
    console.log(`PASS: two real-time players, exact feed cost, owner authentication, logout/login socket invalidation, single-use tickets, origin checks, and session isolation. Local mean state round trip: ${average.toFixed(1)} ms.`);
  }finally{
    for(const ws of sockets)ws.terminate();
    if(processHandle&&processHandle.exitCode===null)await new Promise(resolve=>{processHandle.once("exit",resolve);processHandle.kill();});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
