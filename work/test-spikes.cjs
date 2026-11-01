// Batch 2 spikes: they grow back, the owner can switch that off, bots only remove a spike when they
// really split, and a player's pop counts only if one of their big-enough pieces passed over it.
const assert = require("assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const physics = require("../physics.js");
const {createServer} = require("./server-harness.cjs");

(async () => {
  // Spikes grow back to 22 on the normal map, spread out, each with an id.
  {
    const game = createServer();
    game.tick(40_000);
    const spikes = game.run("world.viruses");
    assert.equal(spikes.length, 22, "An empty map must grow back to 22 spikes");
    assert(spikes.every(spike => typeof spike.id === "string" && spike.id.length >= 8), "Every spike has an id");
    for (const a of spikes) for (const b of spikes) if (a !== b) assert(Math.hypot(a.x - b.x, a.y - b.y) >= 200, "Spikes must not grow on top of each other");
  }

  // "Remove all spikes" keeps them gone; the AUTO SPIKES switch brings regrowth back.
  {
    const game = createServer();
    game.tick(10_000);
    const owner = await game.player(true);
    const credentials = {id: owner.session.id, sessionKey: owner.session.sessionKey};
    let result = await game.call("/api/admin/arena", {...credentials, clearSpikes: true}, true);
    assert.equal(result.status, 200);
    assert.equal(result.body.world.viruses.length, 0);
    assert.equal(result.body.world.autoSpikes, false, "Removing all spikes turns regrowth off");
    game.tick(10_000);
    assert.equal(game.run("world.viruses.length"), 0, "Removed spikes must stay removed");
    result = await game.call("/api/admin/arena", {...credentials, autoSpikes: true}, true);
    assert.equal(result.body.world.autoSpikes, true);
    game.tick(6_000);
    assert(game.run("world.viruses.length") >= 3, "Turning AUTO SPIKES back on makes them grow again");
    const guest = await game.player();
    result = await game.call("/api/admin/arena", {id: guest.session.id, sessionKey: guest.session.sessionKey, autoSpikes: false});
    assert.equal(result.status, 403, "Only the owner can change spikes");
  }

  // A bot that cannot split (its piece limit is full) passes through a spike instead of deleting it.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [{id: "spike", x: 2000, y: 2000}],
      bots: [{netId: "big", name: "Alex", botTeam: "Alex", x: 2000, y: 2000, mass: 400, alive: true},
        ...Array.from({length: 15}, (_, i) => ({netId: "alex-" + i, name: "Alex", botTeam: "Alex", x: 300 + i * 30, y: 300, mass: 20, alive: true})),
        ...Array.from({length: 80}, (_, i) => ({netId: "other-" + i, name: "B" + i, botTeam: "B" + i, x: 400 + (i % 20) * 200, y: 4000 + Math.floor(i / 20) * 200, mass: 20, alive: true}))]})`});
    game.run("simulateServerBots(.04)");
    assert.equal(game.run("world.viruses.length"), 1, "The spike must stay when the bot could not split");
    assert.equal(game.run("world.bots.filter(bot => bot.botTeam === 'Alex').length"), 16);
  }

  // A player's pop is checked by the server: the piece must have been 90+ mass, covered the spike (not just touched
  // it), and actually split. Spikes far away, under small pieces, or "popped" without splitting stay.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, bots: [], viruses: [{id: "far", x: 4000, y: 4000}]})`});
    const p = await game.player();
    let snap = await p.state({cells: [{netId: "a", x: 1000, y: 1000, mass: 28, alive: true}]});
    const at = snap.self.cells[0];
    // Pretend this player has already grown to 200 (the server's own record).
    game.run(`sessions.get(${JSON.stringify(p.session.id)}).cells[0].mass = 200;
      world.viruses.push({id: "edge", x: ${at.x + 75}, y: ${at.y}, r: 42, angle: 0}, {id: "under", x: ${at.x + 25}, y: ${at.y}, r: 42, angle: 0},
        {id: "small", x: 3000, y: 3000, r: 42, angle: 0});`);
    game.advance(100);
    // Just touching a spike's edge (or not splitting at all) doesn't pop it.
    snap = await p.state({ackRevision: snap.self.revision, cells: [{...snap.self.cells[0], mass: 200}], virusPops: ["edge", "under", "far"]});
    let left = game.run("world.viruses.map(spike => spike.id)");
    assert(left.includes("edge") && left.includes("under") && left.includes("far"), "No split, no pop: " + left);
    // A real pop: the piece covers "under", keeps half its mass and sends out a ring of shards.
    const masses = physics.spikes.popMasses(200, 15);
    assert.deepEqual(masses.map(mass => +mass.toFixed(2)), [100, 20, 20, 20, 20, 20], "200 mass keeps 100, five shards of 20");
    // Like the real game, each piece says which share of the old piece it came from (massOrigins).
    const kept = {...snap.self.cells[0], mass: masses[0], massOrigins: {a: .5}};
    const shards = masses.slice(1).map((mass, i) => ({netId: "shard-" + i, ...physics.spikes.shardLaunch(kept, i, masses.length - 1, 0, physics.radius(masses[0])),
      mass, alive: true, massOrigins: {a: mass / 200}}));
    game.advance(100);
    const before = snap.self.revision;
    snap = await p.state({ackRevision: snap.self.revision, cells: [kept, ...shards], virusPops: ["under", "edge", "far"]});
    left = game.run("world.viruses.map(spike => spike.id)");
    assert(!left.includes("under"), "A real pop removes the spike for everyone");
    assert(left.includes("edge"), "A spike that was only touched stays (one split = one pop)");
    assert(left.includes("far"), "A spike nowhere near the player cannot be popped");
    assert.equal(snap.self.revision, before, "A real pop is never corrected");
    // A 50-mass player cannot pop a spike, even standing on it.
    const small = await game.player();
    const smallSnap = await small.state({cells: [{netId: "s", x: 2000, y: 2000, mass: 28, alive: true}]});
    const smallAt = smallSnap.self.cells[0];
    game.run(`world.viruses.find(spike => spike.id === "small").x = ${smallAt.x}; world.viruses.find(spike => spike.id === "small").y = ${smallAt.y};`);
    game.advance(100);
    await small.state({ackRevision: smallSnap.self.revision, cells: smallSnap.self.cells, virusPops: ["small"]});
    assert(game.run("world.viruses.some(spike => spike.id === 'small')"), "Pieces under 90 mass cannot pop spikes");
  }

  // Bots follow the same rules: covering pops (half kept, ring of shards), touching doesn't.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [{id: "covered", x: 2030, y: 2000}, {id: "touched", x: 3095, y: 3000}],
      bots: [{netId: "big", name: "Alex", botTeam: "Alex", x: 2000, y: 2000, mass: 400, alive: true},
        {netId: "side", name: "Bea", botTeam: "Bea", x: 3000, y: 3000, mass: 400, alive: true}]})`});
    game.run("simulateServerBots(.001)");
    const ids = game.run("world.viruses.map(spike => spike.id)");
    assert(!ids.includes("covered"), "A bot covering a spike pops it");
    assert(ids.includes("touched"), "A bot touching a spike's edge doesn't");
    const alex = game.run("world.bots.filter(bot => bot.botTeam === 'Alex').map(bot => +bot.mass.toFixed(1)).sort((a, b) => b - a)");
    assert.deepEqual(Array.from(alex), [200, ...Array(7).fill(28.6)], "The bot keeps half; 7 shards share the rest");
  }

  // The game's own pop: shards in an even ring, nothing at 16 pieces, brushing does nothing, small pieces go under.
  {
    const game = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
    const slice = (from, to) => game.slice(game.indexOf(from), game.indexOf(to));
    const context = vm.createContext({BlobPhysics: physics, MAX_PLAYER_CELLS: 16, worldSize: 5200, onlineMode: true, botImmunity: false,
      virusPops: [], poppedVirusIds: new Map(), performance: {now: () => 5000}, Math, Object, Array, Number,
      clamp: (v, a, b) => Math.max(a, Math.min(b, v)), radiusForMass: physics.radius, emit() {}, bots: [], playerCells: [], viruses: []});
    vm.runInContext(slice("function shareMassCorrection(", "function splitBot("), context);
    const run = code => vm.runInContext(code, context);
    run(`playerCells = [{netId: "me", x: 1000, y: 1000, mass: 300, radius: ${physics.radius(300)}, alive: true, virusImmuneUntil: 0, _syncMassWeights: {me: 1}}];
      viruses = [{id: "edge", x: 1080, y: 1000, r: 42}, {id: "mid", x: 1040, y: 1000, r: 42}]; handleViruses();`);
    assert.deepEqual(Array.from(run("viruses.map(v => v.id)")), ["edge"], "Only the covered spike pops");
    assert.deepEqual(Array.from(run("virusPops")), ["mid"]);
    const pieces = run("playerCells.map(c => ({mass: c.mass, x: c.x, y: c.y, w: c._syncMassWeights}))");
    assert.equal(pieces.length, 8); assert.equal(pieces[0].mass, 150);
    assert(pieces.slice(1).every(piece => Math.abs(piece.mass - 150 / 7) < 1e-9), "7 equal shards share the other half");
    const angles = pieces.slice(1).map(piece => Math.atan2(piece.y - 1000, piece.x - 1000)).sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) assert(Math.abs(angles[i] - angles[i - 1] - Math.PI * 2 / 7) < 1e-6, "Shards are evenly spaced");
    assert(Math.abs(pieces.reduce((sum, piece) => sum + (piece.w?.me || 0), 0) - 1) < 1e-9, "The server's mass bookkeeping still adds up");
    assert(Math.abs(pieces[0].w.me - .5) < 1e-9, "and follows each piece's real share");
    // 16 pieces: no room to split, so the spike stays and nothing happens.
    run(`playerCells = Array.from({length: 16}, (_, i) => ({netId: "p" + i, x: 3000 + i * 200, y: 3000, mass: 300, radius: ${physics.radius(300)}, alive: true, virusImmuneUntil: 0}));
      viruses = [{id: "full", x: 3000, y: 3000, r: 42}]; virusPops = []; handleViruses();`);
    assert.equal(run("viruses.length"), 1, "At 16 pieces the spike stays");
    assert.equal(run("playerCells.length"), 16); assert.equal(run("virusPops.length"), 0);
    // Draw order: pieces under 90 mass are drawn under spikes, bigger ones over them.
    const render = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
    assert(/layers\.push\(\{ virus, mass: BlobPhysics\.spikes\.popMass - \.001 \}\)/.test(render), "Spikes are drawn between small and big pieces");
  }
  // The player's own game hides a spike it just popped until the server confirms, and shows the AUTO SPIKES state.
  {
    const source = fs.readFileSync(path.join(__dirname, "..", "multiplayer.js"), "utf8");
    const context = vm.createContext({BlobPhysics: physics, worldSize: 5200, bots: [], viruses: [], lastWorld: null, updateMapSizeLabel() {},
      isAdmin: false, normalizeNetworkCell: cell => cell, mergeNetworkCell: (_, cell) => cell, ejected: [], ejectedCache: new Map(),
      networkDelay: 0, performance: {now: () => 1000}, Date, rebuildSharedFood() {},
      poppedVirusIds: new Map([["popped", 3000]]), autoSpikesOn: true, labels: [],
      botTeamInfo: new Map(), serverViruses: [], teamsSig: "", spikesSig: "", radiusForMass: mass => Math.sqrt(mass) * 4.2 + 8});
    context.setAutoSpikesLabel = on => { context.labels.push(on); context.autoSpikesOn = on; };
    vm.runInContext(source.slice(source.indexOf("  // A compact bot is"), source.indexOf("  // Brings the shared food up to date")), context);
    vm.runInContext("applyWorld({worldSize: 5200, autoSpikes: false, viruses: [{id: 'popped', x: 1, y: 1, r: 42}, {id: 'other', x: 9, y: 9, r: 42}]})", context);
    assert.deepEqual(Array.from(context.viruses, spike => spike.id), ["other"], "A just-popped spike must not flash back");
    assert.deepEqual(context.labels, [false], "The owner's AUTO SPIKES label follows the server");
  }

  console.log("PASS: pops need a 90+ piece covering the spike and a real split (touching does nothing, 16 pieces does nothing), half kept + even ring of shards for players and bots, server checks every pop; spikes grow back (22, spread out), remove-all keeps them gone until AUTO SPIKES is switched on, only the owner controls it, bots that can't split leave spikes alone, player pops are checked (near + big enough), popped spikes don't flash back.");
})().catch(error => { console.error(error); process.exitCode = 1; });
