const assert=require('assert/strict');
const {spawn}=require('child_process');
const fs=require('fs'), os=require('os'), path=require('path');
const physics=require('../physics.js');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for (const position of [{x:1000,y:1000},{x:1100,y:800},{x:1300,y:1200}]) {
  const target={x:1800,y:900};
  const pellet=physics.createFeed({...position,mass:100},target.x-position.x,target.y-position.y,target);
  for(let frame=0;frame<120;frame++)physics.moveFeed(pellet,1/120,5200);
  const dx=target.x-position.x,dy=target.y-position.y;
  const px=pellet.x-position.x,py=pellet.y-position.y;
  assert(Math.abs(dx*py-dy*px)<.00001,'Every source must aim at the actual cursor');
  assert(Math.hypot(px,py)<=physics.radius(100)+10+360,'A distant cursor must not turn feeding into a cross-map projectile');
}
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'splitflux-features-'));
let processHandle;
const base='http://127.0.0.1:11004';
function client(){return {jar:new Map(),session:null,snapshot:null};}
async function request(who,route,body) {
  const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:[...who.jar].map(([key,value])=>`${key}=${value}`).join('; ')},body:body?JSON.stringify(body):undefined});
  for(const cookie of response.headers.getSetCookie()) {const entry=cookie.split(';')[0],index=entry.indexOf('=');who.jar.set(entry.slice(0,index),entry.slice(index+1));}
  const contentType=response.headers.get('content-type')||'';
  return {status:response.status,body:contentType.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer())};
}
async function session(who){const result=await request(who,'/api/session');if(result.status===200)who.session=result.body;return result;}
function credentials(who){return {id:who.session.id,sessionKey:who.session.sessionKey};}
async function state(who,extra={}) {
  const result=await request(who,'/api/state',{...credentials(who),running:true,cells:who.snapshot?.self.cells||[],ackRevision:who.snapshot?.self.revision||0,ackBotRevision:who.snapshot?.botRevision||0,ackBotMassRevision:who.snapshot?.botMassRevision||0,...extra});
  if(result.status===200)who.snapshot=result.body;
  return result;
}
(async()=>{
 try {
  processHandle=spawn(process.execPath,[path.join(__dirname,'..','server.cjs')],{env:{...process.env,NODE_ENV:'test',SPLITFLUX_TEST_WORLD:'1',PORT:'11004',SPLITFLUX_DATA_DIR:directory,SPLITFLUX_OWNER_PASSWORD:'test-owner-password'},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timeout')),10000);processHandle.once('error',reject);processHandle.once('exit',code=>{clearTimeout(timer);reject(new Error('Early exit '+code));});processHandle.stdout.on('data',data=>{if(data.toString().includes('OWNER PC:')){clearTimeout(timer);resolve();}});});
  const health=await request(client(),'/health');
  assert.equal(health.status,200);assert.deepEqual(health.body,{status:'ok'});
  const owner=client(),guest=client();await session(owner);await session(guest);
  assert.equal((await request(owner,'/api/accounts/login',{...credentials(owner),username:'alpha',password:'test-owner-password'})).status,200);
  await state(owner);
  const bot={netId:'bot',name:'Alex',botTeam:'Alex',x:2000,y:2000,mass:200,radius:physics.radius(200),alive:true,launchX:0,launchY:0};
  await state(owner,{world:{worldSize:5200,bots:[bot],viruses:[]}});
  assert.equal((await request(guest,'/api/admin/paint-spikes',{...credentials(guest),points:[{x:500,y:500}]})).status,403);
  const paint=await request(owner,'/api/admin/paint-spikes',{...credentials(owner),points:[{x:500,y:500},{x:500,y:500},{x:700,y:500}]});
  assert.equal(paint.status,200);assert.equal(paint.body.added,2);
  assert.equal((await request(owner,'/api/team',{...credentials(owner),team:'Alex',enabled:true})).body.followedBotTeam,'Alex');
  await state(owner,{cursor:{x:2500,y:2000},botSplitCommands:['split-one']});
  assert.equal(owner.snapshot.world.bots.filter(bot=>bot.botTeam==='Alex').length,2,JSON.stringify({admin:owner.snapshot.isAdmin,follow:owner.snapshot.followedBotTeam,commands:owner.snapshot.acceptedBotSplitCommands,bots:owner.snapshot.world.bots.map(bot=>({team:bot.botTeam,mass:bot.mass,alive:bot.alive}))}));
  await state(owner,{cursor:{x:2500,y:2000},botSplitCommands:['split-one']});
  assert.equal(owner.snapshot.world.bots.filter(bot=>bot.botTeam==='Alex').length,2,'Split command retries must not split twice');
  const massBefore=owner.snapshot.world.bots.reduce((sum,bot)=>sum+bot.mass,0);
  await state(owner,{cursor:{x:3000,y:2000},botFeeding:true});await wait(100);await state(owner,{botFeeding:false});
  assert(owner.snapshot.world.bots.reduce((sum,bot)=>sum+bot.mass,0)<massBefore,'R feed command must eject teammate mass');
  for (const command of ['split-two','split-three','split-four']) await state(owner,{cursor:{x:3500,y:2000},botSplitCommands:[command]});
  assert.equal(owner.snapshot.world.bots.filter(bot=>bot.botTeam==='Alex').length,16,'Teammate commands must keep splitting below the AI minimum mass');
  await state(owner,{running:false});
  await state(owner,{running:true});
  assert.equal(owner.snapshot.followedBotTeam,'Alex','Returning through the menu must not silently stop teammate control');
  const skin='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await state(owner,{skin});await state(guest);
  assert(guest.snapshot.players.find(player=>player.id===owner.session.id).skinVersion>0);
  const image=await request(guest,'/api/skins/'+owner.session.id);assert.equal(image.status,200);assert(image.body.length>20);
  assert.equal((await request(guest,'/api/admin/ban',{...credentials(guest),targetId:owner.session.id,durationMs:1000})).status,403);
  assert.equal((await request(owner,'/api/admin/ban',{...credentials(owner),targetId:owner.session.id,durationMs:1000})).status,403);
  const ban=await request(owner,'/api/admin/ban',{...credentials(owner),targetId:guest.session.id,durationMs:1000});assert.equal(ban.status,200);
  assert.equal((await state(guest)).status,403);assert.equal((await session(guest)).status,403,'Ban must survive rejoining with same browser');
  await wait(1100);assert.equal((await session(guest)).status,200,'Timed ban must expire');
  const stored=fs.readFileSync(path.join(directory,'bans.json'),'utf8');assert(stored.includes('device:'));
  console.log('PASS: cursor convergence, automatic teammate follow, exactly-once bot split, bot feeding, cached shared skins, owner-only spike painting, owner protection, timed bans, rejoin enforcement, and expiration.');
 } finally {
  if(processHandle&&processHandle.exitCode===null)await new Promise(resolve=>{processHandle.once('exit',resolve);processHandle.kill();});
  fs.rmSync(directory,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
