const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const physics = require("../physics.js");
const game = fs.readFileSync(path.join(__dirname,"..","game.js"),"utf8");
const splitCode = game.slice(game.indexOf("function aimDirection()"),game.indexOf("function feedMass()"));
for(const [name,count] of [['splitPlayer',2],['quadSplitPlayer',4],['tripleSplitPlayer',3],['fiveSplitPlayer',5],['sixSplitPlayer',6],['squareSplitPlayer',4]]) {
  const context=vm.createContext({BlobPhysics:physics, running:true,width:1000,height:1000,pointer:{x:900,y:500},worldSize:10000,
    performance:{now:()=>1000}, radiusForMass:physics.radius, emit(){},clamp:(v,min,max)=>Math.max(min,Math.min(max,v)),
    boundCell:(v,r)=>Math.max(r,Math.min(10000-r,v)),playerCells:[{netId:'original',x:5000,y:5000,mass:20000,radius:physics.radius(20000),alive:true}],player:null});
  vm.runInContext(splitCode+`;${name}();`,context);
  assert.equal(context.playerCells.length,count);
  assert(Math.abs(context.playerCells.reduce((sum,cell)=>sum+cell.mass,0)-20000)<.00001);
  assert.equal(new Set(context.playerCells.map(cell=>cell.netId)).size,count);
  for(const cell of context.playerCells) {
    assert(Math.hypot(cell.x-5000,cell.y-5000)<physics.radius(20000)*.15,'Every split must begin inside the parent');
  }
  const child=context.playerCells[count-1];
  const start=Math.hypot(child.x-5000,child.y-5000);
  for(let i=0;i<20;i++) physics.moveBoost(child,1/60,10000,'launchX','launchY',child.radius);
  assert(Math.hypot(child.x-5000,child.y-5000)>start+100,'Child must emerge through continuous movement');
}
const context=vm.createContext({require(name){
  if(name==='http')return {createServer:()=>({listen(){}})};
  if(name==='fs')return {mkdirSync(){},existsSync:()=>true,readFileSync:()=>JSON.stringify({key:'test-key'})};
  if(name==='./accounts.cjs')return ()=>({});
  if(name==='./physics.js')return physics;
  if(name==='./moderation.cjs')return ()=>({until:()=>0,bannedBotTeams:()=>[]});
  return require(name);
},__dirname:path.join(__dirname,'..'),process:{env:{}},Buffer,module:{exports:{}},console,setInterval:()=>({unref(){}})});
vm.runInContext(fs.readFileSync(path.join(__dirname,'..','server.cjs'),'utf8'),context);
const result=vm.runInContext(`
world=cleanWorld({worldSize:5200,bots:[{netId:'bot',botTeam:'Alex',name:'Alex',x:2000,y:2000,mass:40,alive:true}],viruses:[]});
sessions.set('controller',{running:true,lastSeen:Date.now(),isAdmin:false,cells:[],followedBotTeam:'Alex',cursor:{x:3000,y:2000},teamedBots:new Set()});
simulateServerBots(.04);
const movedRight=world.bots.find(bot=>bot.netId==='bot').x>2000;
sessions.get('controller').followedBotTeam='Maya';
({movedRight,controlled:botControllers().map(entry=>entry.team)});
`,context);
assert.equal(result.movedRight,true);
assert.equal(result.controlled.length,1);
assert.equal(result.controlled[0],'Maya');
const split=vm.runInContext(`
world=cleanWorld({worldSize:5200,bots:[{netId:'small',botTeam:'Alex',name:'Alex',x:1000,y:1000,mass:20,alive:true}],viruses:[]});
splitServerBot(world.bots[0],{x:2000,y:1000,mass:0},1,true);
({pieces:world.bots.length,mass:world.bots.reduce((sum,bot)=>sum+bot.mass,0),parentBoost:world.bots[0].launchX,childBoost:world.bots[1].launchX});
`,context);
assert.equal(split.pieces,2);assert.equal(split.mass,20);
assert.equal(split.parentBoost,0);assert(split.childBoost>0,'Only the child should launch out of the parent');
const groupSplit=vm.runInContext(`
world=cleanWorld({worldSize:5200,bots:Array.from({length:96},(_,i)=>({netId:'piece-'+i,botTeam:i<16?'Alex':'Other-'+i,name:'Bot',x:1000+i*20,y:1000,mass:20,alive:true})),viruses:[]});
const error=splitTeammate({followedBotTeam:'Alex',cursor:{x:4000,y:1000}});
({error,count:world.bots.filter(bot=>bot.botTeam==='Alex').length,mass:world.bots.filter(bot=>bot.botTeam==='Alex').reduce((sum,bot)=>sum+bot.mass,0)});
`,context);
assert.equal(groupSplit.error,null);assert.equal(groupSplit.count,32,'All teammate pieces must split even when the normal AI cap is full');assert.equal(groupSplit.mass,320);
let keyHandler, selected=null, toggles=0, remerges=0;
const shortcuts=vm.createContext({addEventListener:(type,handler)=>{keyHandler=handler;},
  HTMLInputElement:class {},HTMLTextAreaElement:class {},HTMLSelectElement:class {},running:true,
  followedBotTeam:null,teamedBots:new Set(),camera:{zoom:1},bots:[{name:'Alex',botTeam:'Alex',alive:true,x:100,y:100,radius:30}],
  keys:{},instantlyRemerge:()=>{remerges++;},cursorWorldPosition:()=>({x:100,y:100}),showBotTeam:bot=>{selected=bot.botTeam;},toggleSelectedBotTeam:()=>{toggles++;},showArenaError:error=>{throw error;}});
vm.runInContext(game.slice(game.indexOf('\naddEventListener("keydown", e => {'),game.indexOf('\naddEventListener("keyup", e => {')),shortcuts);
keyHandler({code:'KeyT',target:{},repeat:false,preventDefault(){}});
assert.equal(selected,null);assert.equal(toggles,0,'T must not start teaming');
shortcuts.followedBotTeam='Alex';shortcuts.teamedBots.add('Alex');shortcuts.bots=[];
keyHandler({code:'KeyT',target:{},repeat:false,preventDefault(){}});
assert.equal(toggles,0,'T must not stop teaming either');
assert.equal(shortcuts.keys.KeyT,true,'Holding T must feed the selected teammate');
keyHandler({code:'KeyR',target:{},repeat:false,preventDefault(){}});
assert.equal(remerges,1,'R must remerge even with a teammate');
let keyUpHandler;
shortcuts.addEventListener=(type,handler)=>{keyUpHandler=handler;};
const keyUpStart=game.indexOf('\naddEventListener("keyup", e => {');
vm.runInContext(game.slice(keyUpStart,game.indexOf('\n',keyUpStart+1)),shortcuts);
keyUpHandler({code:'KeyT'});
assert.equal(shortcuts.keys.KeyT,false,'Releasing T must stop bot feeding');
console.log('PASS: all six split formations start inside the parent and launch outward, preserve mass and IDs; server cursor following moves the selected bot and holds only one selection.');
