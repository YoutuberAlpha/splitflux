const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const physics = require("../physics.js");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function flight(fps) {
  const pellet = { x:100, y:100, vx:1200, vy:0, r:8 };
  for (let i = 0; i < fps; i++) physics.moveBoost(pellet, 1 / fps, 5200);
  return pellet.x;
}
assert(Math.abs(flight(30) - flight(240)) < .000001);
function feedFlight(fps, mass) {
  const pellet = physics.createFeed({x:1000,y:1000,mass},1,0);
  const start = pellet.x;
  for (let i = 0; i < fps; i++) physics.moveFeed(pellet,1/fps,5200);
  assert(Math.hypot(pellet.vx,pellet.vy)<.000001,'Feed must come to a complete stop');
  const stoppedAt = pellet.x;
  physics.moveFeed(pellet,2,5200);
  assert(Math.abs(pellet.x-stoppedAt)<.000001,'Stopped feed must not creep farther');
  return pellet.x-start;
}
assert(Math.abs(feedFlight(30,300)-feedFlight(240,300))<.000001);
assert(feedFlight(60,300)<160,'Ordinary feed range should be much shorter');
assert(feedFlight(60,300)>feedFlight(60,28),'Feed range should still scale with blob size');
assert(feedFlight(60,1000000)<=360.000001,'Very large blobs should not fire feed across the map');
assert(physics.catchesFeed({x:200,y:100,radius:12}, {x:300,y:100,r:8}, 100, 100));
assert.deepEqual(physics.direction(0,0), {x:1,y:0});

const source = fs.readFileSync(path.join(__dirname,"..","multiplayer.js"),"utf8");
const correctionFunction = source.slice(source.indexOf("  function applyOwnCells("), source.indexOf("  function mergeNetworkCell("));
const local = vm.createContext({ running:true, normalizeNetworkCell:cell=>({...cell}), radiusForMass:physics.radius,
  playerCells:[{netId:'parent',mass:50,x:110,y:100,alive:true}, {netId:'new-child',mass:50,x:150,y:100,alive:true}], player:null });
vm.runInContext(correctionFunction,local);
vm.runInContext("applyOwnCells([{netId:'parent',mass:97.5,x:100,y:100,alive:true}], [{netId:'parent',mass:100}]);",local);
assert.equal(local.playerCells.length,2);
assert.equal(local.playerCells.reduce((sum,cell)=>sum+cell.mass,0),97.5);
assert.equal(local.playerCells[0].x,110);
local.playerCells = [{netId:'parent',mass:100,x:100,y:100,alive:true}];
vm.runInContext("applyOwnCells([{netId:'parent',mass:50,x:100,y:100,alive:true},{netId:'merged',mass:52.2,x:100,y:100,alive:true}], [{netId:'parent',mass:50},{netId:'merged',mass:50}]);",local);
assert.equal(local.playerCells.length,1);
assert(Math.abs(local.playerCells[0].mass-102.2)<.000001);

const directory = fs.mkdtempSync(path.join(os.tmpdir(),"tricksplit-feed-"));
const base = "http://127.0.0.1:11003";
let server;
(async()=>{
  try {
    server = spawn(process.execPath,[path.join(__dirname,"..","server.cjs")],{env:{...process.env,PORT:'11003',SPLITFLUX_OWNER_PASSWORD:'test-owner-password',SPLITFLUX_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Server startup timed out')),10000);
      server.once('error',reject);
      server.once('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited '+code));});
      server.stdout.on('data',data=>{if(data.toString().includes('OWNER PC:')){clearTimeout(timeout);resolve();}});
    });
    const session=await (await fetch(base+'/api/session')).json();
    const login=await fetch(base+'/api/accounts/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...session,username:'alpha',password:'test-owner-password'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    let snapshot;
    const cell=(netId,x,mass)=>({netId,x,y:1000,mass,radius:physics.radius(mass),alive:true,color:'#55d6ff',launchX:0,launchY:0});
    async function update(cells, additions=[], bots=[]) {
      const response=await fetch(base+'/api/state',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({
        id:session.id,sessionKey:session.sessionKey,running:true,cells,world:{worldSize:5200,bots,viruses:[]},
        ackRevision:snapshot?.self.revision||0,ackBotRevision:snapshot?.botRevision||0,ackBotMassRevision:snapshot?.botMassRevision||0,ejectedAdditions:additions,
      })});
      assert.equal(response.status,200);
      snapshot=await response.json();
      return snapshot;
    }
    await update([cell('sender',1000,300),cell('recipient',1220,28)]);
    const command={netId:'original-feed',ownerCellId:'sender',dirX:1,dirY:0,x:5000,y:5000,vx:0,vy:0};
    await update([cell('sender',1000,300),cell('recipient',1220,28)],[command]);
    assert.equal(snapshot.self.cells.find(c=>c.netId==='sender').mass,297.5);
    assert(snapshot.world.ejected[0].x<1200,'Server must spawn at sender, ignoring advanced client pellet position');
    await delay(450);
    await update(snapshot.self.cells,[command]);
    assert.equal(snapshot.self.cells.find(c=>c.netId==='recipient').mass,30.2);
    assert.equal(snapshot.self.cells.find(c=>c.netId==='sender').mass,297.5);
    assert.equal(snapshot.world.ejected.length,0,'Acknowledged pellet must not be respawned on retry');

    // A bot feed must survive the owner's next stale bot snapshot.
    const bot={...cell('bot',1250,600),name:'Alex',botTeam:'Alex',targetX:1250,targetY:1000};
    await update([cell('sender',1000,300)],[],[bot]);
    await update(snapshot.self.cells,[{netId:'bot-feed',ownerCellId:'sender',dirX:1,dirY:0}],[bot]);
    await delay(180);
    await update(snapshot.self.cells,[],[bot]);
    assert(Math.abs(snapshot.world.bots[0].mass-602.2)<.000001,'Stale owner world must not erase feed growth');
    const secondBot={...cell('bot-two',2000,50),name:'Maya',botTeam:'Maya'};
    await update(snapshot.self.cells,[],[...snapshot.world.bots,secondBot]);
    async function follow(team) {
      const response=await fetch(base+'/api/follow-bot',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({id:session.id,sessionKey:session.sessionKey,team})});
      assert.equal(response.status,200);
      return response.json();
    }
    assert.equal((await follow('Alex')).followedBotTeam,'Alex');
    assert.equal((await follow('Maya')).followedBotTeam,'Maya');
    await update(snapshot.self.cells,[],snapshot.world.bots);
    assert.equal(snapshot.followedBotTeam,'Maya');
    assert.equal((await follow(null)).followedBotTeam,null);
    assert.equal((await fetch(base+'/physics.js')).status,200);
    assert.equal((await fetch(base+'/licenses/MultiOgar-LICENSE.md')).status,200);
    assert.equal((await fetch(base+'/licenses/agar-io-clone-LICENSE.txt')).status,200);
    console.log('PASS: real HTTP feed commands, exact cost and growth, retry deduplication, stale bot snapshots, splitting/merging during feed correction, swept collisions, and 30/240 FPS equivalence.');
  } finally {
    if(server && server.exitCode===null) await new Promise(resolve=>{server.once('exit',resolve);server.kill();});
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
