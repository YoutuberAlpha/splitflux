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
const moving={netId:'moving',x:150,y:100,vx:300,vy:0,r:8,value:2.2,feedDrag:1000,createdAt:900,_serverConfirmed:true};
const visual=vm.createContext({BlobPhysics:physics,worldSize:5200,bots:[],viruses:[],lastWorld:null,
  updateMapSizeLabel(){},isAdmin:false,normalizeNetworkCell:cell=>cell,mergeNetworkCell:(_,cell)=>cell,
  ejected:[moving],ejectedCache:new Map([['moving',moving]]),networkDelay:.08,performance:{now:()=>1000},Date});
vm.runInContext(source.slice(source.indexOf('  function applyWorld('),source.indexOf('  function applyBotMassOnly(')),visual);
vm.runInContext("applyWorld({worldSize:5200,bots:[],viruses:[],ejected:[{netId:'moving',x:120,y:100,vx:450,vy:0,r:8,value:2.2,feedDrag:1000,createdAt:Date.now()}]});",visual);
assert.equal(visual.ejected[0].x,150,'Delayed snapshots must not rewind feed animation');
assert.equal(visual.ejected[0].vx,300,'Delayed snapshots must not restart feed velocity');
const correctionFunction = source.slice(source.indexOf("  function applyOwnCells("), source.indexOf("  function mergeNetworkCell("));
const local = vm.createContext({ running:true, normalizeNetworkCell:cell=>({...cell}), radiusForMass:physics.radius,
  playerCells:[{netId:'parent',mass:50,x:110,y:100,alive:true,_syncMassWeights:{parent:.5}}, {netId:'new-child',mass:50,x:150,y:100,alive:true,_syncMassWeights:{parent:.5}}], player:null });
vm.runInContext(correctionFunction,local);
vm.runInContext("applyOwnCells([{netId:'parent',mass:97.5,x:100,y:100,alive:true}], [{netId:'parent',mass:100}]);",local);
assert.equal(local.playerCells.length,2);
assert.equal(local.playerCells.reduce((sum,cell)=>sum+cell.mass,0),97.5);
assert.equal(local.playerCells[0].x,110);
local.playerCells = [{netId:'parent',mass:100,x:100,y:100,alive:true,_syncMassWeights:{parent:1,merged:1}}];
vm.runInContext("applyOwnCells([{netId:'parent',mass:50,x:100,y:100,alive:true},{netId:'merged',mass:52.2,x:100,y:100,alive:true}], [{netId:'parent',mass:50},{netId:'merged',mass:50}]);",local);
assert.equal(local.playerCells.length,1);
assert(Math.abs(local.playerCells[0].mass-102.2)<.000001);

const game = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
const splitCode = game.slice(game.indexOf('function aimDirection()'), game.indexOf('function feedMass()'));
const feedCode = game.slice(game.indexOf('function feedMass()'),game.indexOf('function separatePlayerCells()'));
const serializeCode = source.slice(source.indexOf('  function cellForNetwork('),source.indexOf('  function normalizeNetworkCell('));
for (const [split, count] of [['splitPlayer',2],['quadSplitPlayer',4],['tripleSplitPlayer',3],['fiveSplitPlayer',5],['sixSplitPlayer',6],['squareSplitPlayer',4]]) {
  const race = vm.createContext({BlobPhysics:physics,running:true,width:1000,height:1000,pointer:{x:900,y:500},worldSize:10000,
    performance:{now:()=>1000},radiusForMass:physics.radius,emit(){},clamp:(v,min,max)=>Math.max(min,Math.min(max,v)),
    boundCell:(v,r)=>Math.max(r,Math.min(10000-r,v)),normalizeNetworkCell:cell=>({...cell}),
    playerCells:[{netId:'parent',x:5000,y:5000,mass:1000,radius:physics.radius(1000),alive:true,_syncMassWeights:{parent:1}}],player:null});
  vm.runInContext(splitCode + correctionFunction, race);
  vm.runInContext(`${split}(); ${split}();
    playerCells.forEach(cell=>{cell.x+=1200;});
    applyOwnCells([{netId:'parent',mass:250,x:5000,y:5000,alive:true}],[{netId:'parent',mass:1000}]);`,race);
  assert.equal(race.playerCells.length,count*count,'Delayed feed response must preserve all new pieces');
  for (const cell of race.playerCells) {
    assert(Math.abs(cell.mass-250/(count*count))<.000001,'Feed cost must be divided across every descendant, not crush the parent');
    assert(cell.x>6000,'A pre-split response must not teleport the parent backward');
    assert(Number.isFinite(cell.launchX||0));
  }
  // Recombining descendants must retain the complete pending correction exactly once.
  vm.runInContext(`const first=playerCells[0];
    for(const other of playerCells.slice(1)){combineMassCorrections(first,other);first.mass+=other.mass;}
    playerCells=[first];
    applyOwnCells([{netId:'parent',mass:1022,x:5000,y:5000,alive:true}],[{netId:'parent',mass:1000}]);`,race);
  assert(Math.abs(race.playerCells[0].mass-272)<.000001);
}

for (const split of ['splitPlayer','quadSplitPlayer','tripleSplitPlayer','fiveSplitPlayer','sixSplitPlayer','squareSplitPlayer']) {
  const prediction=vm.createContext({BlobPhysics:physics,running:true,onlineMode:true,width:1000,height:1000,pointer:{x:900,y:500},
    worldSize:10000,performance:{now:()=>1000},Date,session:{id:'test'},pendingFeedCommands:new Map(),ejected:[],feedCooldown:0,
    cursorWorldPosition:()=>({x:8000,y:5000}),radiusForMass:physics.radius,emit(){},normalizeNetworkCell:cell=>({...cell}),
    clamp:(v,min,max)=>Math.max(min,Math.min(max,v)),boundCell:(v,r)=>Math.max(r,Math.min(10000-r,v)),
    playerCells:[{netId:'parent',x:5000,y:5000,mass:1000,radius:physics.radius(1000),alive:true}],player:null});
  vm.runInContext(splitCode+feedCode+serializeCode+correctionFunction,prediction);
  vm.runInContext(`for(let i=0;i<8;i++){feedCooldown=0;feedMass();}
    const sent=playerCells.map(cellForNetwork);
    const accepted=[...pendingFeedCommands.keys()];
    playerCells[0]._syncMassWeights={parent:1};`,prediction);
  assert.equal(prediction.playerCells[0].mass,800,'Feeding must shrink locally immediately, not in network-sized bursts');
  vm.runInContext(`${split}(); ${split}();
    playerCells.forEach(cell=>cell.x+=2000);
    settleFeedPredictions(accepted);
    applyOwnCells([{...sent[0],mass:800}],sent);`,prediction);
  assert(Math.abs(prediction.playerCells.reduce((sum,c)=>sum+c.mass,0)-800)<1e-6,'Acknowledgement must not deduct predicted food twice');
  assert(prediction.playerCells.every(c=>c.x>6900),'Feeding must not rewind movement during a slow response');
  assert(prediction.playerCells.every(c=>Object.keys(c._pendingFeedCosts).length===0));
}

// With high speed, a delayed feed response must not be mistaken for a server teleport.
local.playerCells=[{netId:'fast',mass:975,x:9000,y:1000,radius:physics.radius(975),alive:true,_syncMassWeights:{fast:1}}];
vm.runInContext("applyOwnCells([{netId:'fast',mass:1000,x:1000,y:1000,alive:true}],[{netId:'fast',mass:1000,x:1000,y:1000}]);",local);
assert.equal(local.playerCells[0].x,9000);

const smoothing=vm.createContext({performance:{now:()=>275},Number,Math});
vm.runInContext(source.slice(source.indexOf('  function mergeNetworkCell('),source.indexOf('  function applyWorld('))+
  source.slice(source.indexOf('  function smoothNetworkCell('),source.indexOf('  function smoothNetworkEntities(')),smoothing);
smoothing.cell={x:0,y:0,mass:100,radius:50,vx:100,vy:0,_netTargetX:30,_netTargetY:0,_netTargetMass:100,_netTargetRadius:50,
  _netSpacing:100,_netSamples:[{time:0,x:0,y:0},{time:100,x:10,y:0},{time:200,x:20,y:0},{time:300,x:30,y:0}]};
vm.runInContext('smoothNetworkCell(cell,1/60);',smoothing);
assert(Math.abs(smoothing.cell.x-15.5)<1e-6,'Remote movement must interpolate between snapshots instead of jumping to each packet');

const directory = fs.mkdtempSync(path.join(os.tmpdir(),"tricksplit-feed-"));
const base = "http://127.0.0.1:11003";
let server;
(async()=>{
  try {
    server = spawn(process.execPath,[path.join(__dirname,"..","server.cjs")],{env:{...process.env,NODE_ENV:'test',SPLITFLUX_TEST_WORLD:'1',PORT:'11003',SPLITFLUX_OWNER_PASSWORD:'test-owner-password',SPLITFLUX_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
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
    assert.equal(snapshot.self.cells.find(c=>c.netId==='sender').mass,275);
    assert(snapshot.world.ejected[0].x<1200,'Server must spawn at sender, ignoring advanced client pellet position');
    await delay(450);
    await update(snapshot.self.cells,[command]);
    assert.equal(snapshot.self.cells.find(c=>c.netId==='recipient').mass,50);
    assert.equal(snapshot.self.cells.find(c=>c.netId==='sender').mass,275);
    assert.equal(snapshot.world.ejected.length,0,'Acknowledged pellet must not be respawned on retry');

    // A bot feed must survive the owner's next stale bot snapshot.
    const bot={...cell('bot',1250,600),name:'Alex',botTeam:'Alex',targetX:1250,targetY:1000};
    await update([cell('sender',1000,300)],[],[bot]);
    await update(snapshot.self.cells,[{netId:'bot-feed',ownerCellId:'sender',dirX:1,dirY:0}],[bot]);
    await delay(180);
    await update(snapshot.self.cells,[],[bot]);
    assert(Math.abs(snapshot.world.bots[0].mass-622)<.000001,'Stale owner world must not erase feed growth');
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
