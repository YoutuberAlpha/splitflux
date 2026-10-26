const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const context = vm.createContext({
  require(name) {
    if (name === "http") return { createServer: () => ({ listen() {} }) };
    if (name === "fs") return { mkdirSync() {}, existsSync: () => true, readFileSync: () => JSON.stringify({ key: "test-key" }) };
    if (name === "./accounts.cjs") return () => ({});
    if (name === "./physics.js") return require("../physics.js");
    if (name === "./moderation.cjs") return () => ({until:()=>0,bannedBotTeams:()=>[]});
    return require(name);
  },
  __dirname: path.join(__dirname, ".."), process: { env: {} }, Buffer, module: { exports: {} }, console,
  setInterval: () => ({ unref() {} }),
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "server.cjs"), "utf8"), context);
const result = vm.runInContext(`
  world = cleanWorld({worldSize: 5200, bots: [], viruses: []});
  const testSession = {id: 'test', running: true, isAdmin: true, lastSeen: Date.now(), revision: 0,
    cells: [cleanCell({netId:'player', x:1000,y:1000,mass:100,alive:true})], feedIds:new Set(), teamedBots:new Set(), color:'#55d6ff', immune:false, spawnProtectedUntil:0};
  sessions.set('test',testSession);
  const bot = cleanCell({netId:'bot',name:'Alex',botTeam:'Alex',x:1060,y:1000,mass:1000,alive:true});
  world.bots = [bot];
  const pellet = {netId:'feed-one',x:1060,y:1000,startX:1060,startY:1000,vx:0,vy:0,value:2.2,r:8,ownerCellId:'player'};
  addSharedEjected(testSession,[pellet]);
  simulateSharedEjected(0);
  const fedMass = bot.mass;
  addSharedEjected(testSession,[pellet]);
  simulateSharedEjected(0);
  const repeatedMass = bot.mass;
  testSession.teamedBots.add('Alex');
  testSession.cells = [cleanCell({netId:'a',x:1060,y:1000,mass:28,alive:true}),cleanCell({netId:'b',x:1060,y:1000,mass:28,alive:true})];
  resolveCollisions();
  const survivors = testSession.cells.filter(cell=>cell.alive).length;
  testSession.teamedBots.clear();
  resolveCollisions();
  ({fedMass,repeatedMass,survivors,afterUnteam:testSession.cells.filter(cell=>cell.alive).length});
`, context);
assert.equal(result.fedMass, 1022);
assert.equal(result.repeatedMass, 1022);
assert.equal(result.survivors, 1);
assert.equal(result.afterUnteam, 0);

const source = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
const updateFeed = source.slice(source.indexOf("function updateEjected(dt)"), source.indexOf("function handleCells()"));
const feedContext = vm.createContext({ BlobPhysics: require("../physics.js"), performance: { now: () => 1000 }, Number, Math,
  clamp: (value, min, max) => Math.max(min, Math.min(max, value)), worldSize:5200,
  distance:(a,b)=>Math.hypot(a.x-b.x,a.y-b.y), safeMass:value=>Math.max(1,value), radiusForMass:mass=>Math.sqrt(mass)*4.2+8, emit() {},
  onlineMode:true, ejected:[{x:100,y:100,vx:10,vy:0,r:8,value:2.2,createdAt:900,ownerCellId:'emitter',ownerUntil:0}],
  playerCells:[{netId:'receiver',x:100,y:100,radius:80,mass:28,alive:true,isPlayer:true}], bots:[],
});
vm.runInContext(updateFeed + "updateEjected(.016);", feedContext);
assert.equal(feedContext.ejected.length, 1);
assert.equal(feedContext.playerCells[0].mass, 28);
assert(feedContext.ejected[0].x > 100);
feedContext.onlineMode = false;
vm.runInContext("updateEjected(0);", feedContext);
assert.equal(feedContext.ejected.length, 0);
assert.equal(feedContext.playerCells[0].mass, 30.2);
console.log("PASS: feeding grows bots exactly once, online animation does not double-consume feed, offline feeding works, teamed bot leaves last blob alive, unteaming restores normal eating.");
