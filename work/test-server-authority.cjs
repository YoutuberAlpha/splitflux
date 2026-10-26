const assert = require('assert/strict');
const {spawn} = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'splitflux-authority-'));
const jar = new Map();
let child, session, snapshot;
async function request(route, body) {
  const response = await fetch('http://127.0.0.1:11006'+route, {
    method:body?'POST':'GET',headers:{'Content-Type':'application/json',Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},
    body:body?JSON.stringify(body):undefined,
  });
  for (const cookie of response.headers.getSetCookie()) {
    const entry=cookie.split(';')[0], index=entry.indexOf('=');jar.set(entry.slice(0,index),entry.slice(index+1));
  }
  const result = await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
}
function credentials(){return {id:session.id,sessionKey:session.sessionKey};}
async function state(extra={}) {
  snapshot=await request('/api/state',{...credentials(),running:true,name:'TEST',color:'#55d6ff',
    cells:[{netId:'test-player',x:5100,y:5100,mass:28,alive:true}],
    ackRevision:snapshot?.self.revision||0,ackBotRevision:snapshot?.botRevision||0,
    ackBotMassRevision:snapshot?.botMassRevision||0,...extra});return snapshot;
}
(async()=>{
  try {
    child=spawn(process.execPath,[path.join(__dirname,'..','server.cjs')],{
      env:{...process.env,PORT:'11006',NODE_ENV:'test',SPLITFLUX_TEST_WORLD:'0',SPLITFLUX_OWNER_PASSWORD:'test-owner-password',SPLITFLUX_DATA_DIR:directory},stdio:['ignore','pipe','pipe'],
    });
    await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Startup timeout: '+output)),10000);
      child.stderr.on('data',data=>{output+=data;});child.once('error',reject);
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+output));});
      child.stdout.on('data',data=>{if(data.toString().includes('OWNER PC:')){clearTimeout(timer);resolve();}});
    });
    session=await request('/api/session');
    await request('/api/accounts/login',{...credentials(),username:'alpha',password:'test-owner-password'});
    await state();const before=new Map(snapshot.world.bots.map(bot=>[bot.netId,{x:bot.x,y:bot.y}]));
    await delay(180);await state({world:{worldSize:5200,bots:[],viruses:[]}});
    assert(snapshot.world.bots.length>=24,'An old browser snapshot must not erase server bots');
    assert(snapshot.world.bots.some(bot=>before.has(bot.netId)&&Math.hypot(bot.x-before.get(bot.netId).x,bot.y-before.get(bot.netId).y)>.1),'Bots must keep moving with an owner connected');
    await request('/api/admin/arena',{...credentials(),clearSpikes:true});
    await request('/api/admin/paint-spikes',{...credentials(),points:[{x:42,y:42}]});
    await state({world:{worldSize:5200,bots:[],viruses:[]}});
    assert(snapshot.world.viruses.some(virus=>virus.x===42&&virus.y===42),'Stale browser worlds must not erase painted spikes');
    const enlarged=await request('/api/admin/arena',{...credentials(),mapScale:2});assert.equal(enlarged.world.worldSize,10400);
    await state({world:{worldSize:5200,bots:[],viruses:[]}});assert.equal(snapshot.world.worldSize,10400);
    console.log('PASS: server-owned bots move with owners online, stale clients cannot erase bots/spikes or reset the map, admin map commands work.');
  } finally { if(child&&child.exitCode===null) {child.kill();await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(directory,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
