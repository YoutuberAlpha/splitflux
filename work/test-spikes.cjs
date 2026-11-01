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

  // A player's pop is checked by the server: the piece must have been 90+ mass, hit the spike (not just come near
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
    // Not splitting at all doesn't pop anything.
    snap = await p.state({ackRevision: snap.self.revision, cells: [{...snap.self.cells[0], mass: 200}], virusPops: ["edge", "under", "far"]});
    let left = game.run("world.viruses.map(spike => spike.id)");
    assert(left.includes("edge") && left.includes("under") && left.includes("far"), "No split, no pop: " + left);
    // A real pop: the piece hits "under" and becomes 15 equal blobs (one in the middle, a ring of 14).
    const masses = physics.spikes.popMasses(200, 63);
    assert.deepEqual(masses.map(mass => +mass.toFixed(2)), Array(15).fill(13.33), "200 mass becomes 15 blobs of 13.33");
    // Like the real game, each piece says which share of the old piece it came from (massOrigins).
    const kept = {...snap.self.cells[0], mass: masses[0], massOrigins: {a: 1 / 15}};
    const shards = masses.slice(1).map((mass, i) => ({netId: "shard-" + i, ...physics.spikes.shardLaunch(kept, i, masses.length - 1, 0, physics.radius(masses[0])),
      mass, alive: true, massOrigins: {a: mass / 200}}));
    game.advance(100);
    const before = snap.self.revision;
    snap = await p.state({ackRevision: snap.self.revision, cells: [kept, ...shards], virusPops: ["under", "edge", "far"]});
    left = game.run("world.viruses.map(spike => spike.id)");
    assert(!left.includes("under"), "A real pop removes the spike for everyone");
    assert(left.includes("edge"), "One split = one pop: a second spike in the same hit stays");
    assert(left.includes("far"), "A spike nowhere near the player cannot be popped");
    assert.equal(snap.self.revision, before, "A real pop is never corrected");
    assert.equal(snap.self.cells?.length ?? game.run(`sessions.get(${JSON.stringify(p.session.id)}).cells.length`), 15);
    // A 50-mass player cannot pop a spike, even standing on it.
    const small = await game.player();
    const smallSnap = await small.state({cells: [{netId: "s", x: 2000, y: 2000, mass: 28, alive: true}]});
    const smallAt = smallSnap.self.cells[0];
    game.run(`world.viruses.find(spike => spike.id === "small").x = ${smallAt.x}; world.viruses.find(spike => spike.id === "small").y = ${smallAt.y};`);
    game.advance(100);
    await small.state({ackRevision: smallSnap.self.revision, cells: smallSnap.self.cells, virusPops: ["small"]});
    assert(game.run("world.viruses.some(spike => spike.id === 'small')"), "Pieces under 90 mass cannot pop spikes");
  }

  // A pop goes past the normal 16-piece limit (16 pieces + a pop = 30), but only for a pop the server accepts.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, bots: [], viruses: []})`});
    const p = await game.player();
    let snap = await p.state({cells: [{netId: "a", x: 1000, y: 1000, mass: 28, alive: true}]});
    const id = JSON.stringify(p.session.id);
    // The server's record: 16 pieces of 150 mass in a row, and a spike right on piece 0.
    game.run(`const base = sessions.get(${id}).cells[0];
      sessions.get(${id}).cells = Array.from({length: 16}, (_, i) => ({...base, netId: "p" + i, x: 800 + i * 140, y: 1500, mass: 150}));
      world.viruses.push({id: "spike", x: 820, y: 1500, r: 42, angle: 0});`);
    const pieces = game.run(`sessions.get(${id}).cells.map(cell => ({...cell}))`).map(cell => ({...cell, massOrigins: {[cell.netId]: 1}}));
    game.advance(100);
    snap = await p.state({ackRevision: snap.self.revision, cells: pieces});
    const masses = physics.spikes.popMasses(150, physics.spikes.maxPieces - 16);
    assert.equal(masses.length, 15, "Even at 16 pieces a pop makes 15 blobs");
    const popped = [{...pieces[0], mass: masses[0], massOrigins: {p0: 1 / 15}},
      ...masses.slice(1).map((mass, i) => ({...pieces[0], netId: "s" + i, ...physics.spikes.shardLaunch(pieces[0], i, 14, 0, physics.radius(mass)), mass, massOrigins: {p0: 1 / 15}}))];
    game.advance(100);
    const before = snap.self.revision;
    snap = await p.state({ackRevision: snap.self.revision, cells: [...popped, ...pieces.slice(1)], virusPops: ["spike"]});
    assert.equal(game.run(`sessions.get(${id}).cells.length`), 30, "16 pieces + a pop = 30 pieces");
    assert.equal(snap.self.revision, before, "and the server doesn't correct it");
    assert.equal(game.run("world.viruses.length"), 0);
    // Splitting past the limit without a real pop is squeezed back (the mass is kept).
    const now = game.run(`sessions.get(${id}).cells.map(cell => ({...cell}))`).map(cell => ({...cell, massOrigins: {[cell.netId]: 1}}));
    const fake = Array.from({length: 14}, (_, i) => ({...now[1], netId: "fake" + i, mass: now[1].mass / 15, massOrigins: {[now[1].netId]: 1 / 15}}));
    game.advance(100);
    snap = await p.state({ackRevision: snap.self.revision, cells: [...now.slice(0, 1), {...now[1], mass: now[1].mass / 15}, ...now.slice(2), ...fake], virusPops: ["nothing-here"]});
    assert.equal(game.run(`sessions.get(${id}).cells.length`), 30, "No real pop, no extra pieces");
    assert(Math.abs(game.run(`sessions.get(${id}).cells.reduce((sum, cell) => sum + cell.mass, 0)`) - 16 * 150) < 1e-6, "No mass lost");
  }

  // Bots follow the same rules: hitting a spike pops it into equal pieces; just missing it doesn't.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [{id: "covered", x: 2030, y: 2000}, {id: "touched", x: 3095, y: 3000},
      {id: "missed", x: 4000, y: 1350}],
      bots: [{netId: "big", name: "Alex", botTeam: "Alex", x: 2000, y: 2000, mass: 400, alive: true},
        {netId: "side", name: "Bea", botTeam: "Bea", x: 3000, y: 3000, mass: 400, alive: true},
        {netId: "far", name: "Cy", botTeam: "Cy", x: 4000, y: 1220, mass: 400, alive: true}]})`});
    game.run("simulateServerBots(.001)");
    const ids = game.run("world.viruses.map(spike => spike.id)");
    assert(!ids.includes("covered"), "A bot on top of a spike pops it");
    assert(!ids.includes("touched"), "A bot running into a spike's edge pops it");
    assert(ids.includes("missed"), "A bot that only comes near a spike doesn't");
    const alex = game.run("world.bots.filter(bot => bot.botTeam === 'Alex').map(bot => +bot.mass.toFixed(1)).sort((a, b) => b - a)");
    assert.deepEqual(Array.from(alex), Array(15).fill(26.7), "The bot becomes 15 equal pieces");
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
    assert.deepEqual(Array.from(run("viruses.map(v => v.id)")), ["edge"], "One hit = one pop: the next spike waits a moment");
    assert.deepEqual(Array.from(run("virusPops")), ["mid"]);
    const pieces = run("playerCells.map(c => ({mass: c.mass, x: c.x, y: c.y, w: c._syncMassWeights}))");
    assert.equal(pieces.length, 15, "A popped blob becomes 15 blobs");
    assert(pieces.every(piece => Math.abs(piece.mass - 20) < 1e-9), "all the same mass");
    const angles = pieces.slice(1).map(piece => Math.atan2(piece.y - 1000, piece.x - 1000)).sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) assert(Math.abs(angles[i] - angles[i - 1] - Math.PI * 2 / 14) < 1e-6, "Shards are evenly spaced");
    assert(Math.abs(pieces.reduce((sum, piece) => sum + (piece.w?.me || 0), 0) - 1) < 1e-9, "The server's mass bookkeeping still adds up");
    assert(Math.abs(pieces[0].w.me - 1 / 15) < 1e-9, "and follows each piece's real share");
    // Hitting a spike's edge pops it; coming close without hitting it doesn't.
    run(`playerCells = [{netId: "me", x: 1000, y: 1000, mass: 300, radius: ${physics.radius(300)}, alive: true, virusImmuneUntil: 0}];
      viruses = [{id: "near", x: 1000, y: 1115, r: 42}]; virusPops = []; handleViruses();`);
    assert.equal(run("viruses.length"), 1, "Coming close doesn't pop");
    run(`viruses = [{id: "hit", x: 1000, y: 1100, r: 42}]; handleViruses();`);
    assert.equal(run("viruses.length"), 0, "Running into the spike's edge pops it");
    assert.equal(run("playerCells.length"), 15, "and splits the blob into 15");
    // At the normal 16-piece limit a pop still makes 15 blobs (16 -> 30)...
    run(`playerCells = Array.from({length: 16}, (_, i) => ({netId: "p" + i, x: 3000 + i * 200, y: 3000, mass: 300, radius: ${physics.radius(300)}, alive: true, virusImmuneUntil: 0}));
      viruses = [{id: "full", x: 3000, y: 3000, r: 42}]; virusPops = []; handleViruses();`);
    assert.equal(run("viruses.length"), 0, "A pop at 16 pieces still happens");
    assert.equal(run("playerCells.length"), 30);
    // ...but at the 64-piece safety limit nothing pops and the spike stays.
    run(`playerCells = Array.from({length: 64}, (_, i) => ({netId: "q" + i, x: 300 + (i % 16) * 200, y: 3000 + Math.floor(i / 16) * 200, mass: 300, radius: ${physics.radius(300)}, alive: true, virusImmuneUntil: 0}));
      viruses = [{id: "max", x: 300, y: 3000, r: 42}]; virusPops = []; handleViruses();`);
    assert.equal(run("viruses.length"), 1, "At 64 pieces the spike stays");
    assert.equal(run("playerCells.length"), 64);
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

  console.log("PASS: a 90+ piece pops a spike when it hits it (coming close does nothing), needs a real split, one hit = one pop, a pop always makes 15 equal blobs (even past 16 pieces, up to the 64 safety limit) with the server checking it, even ring of shards for players and bots, server checks every pop; spikes grow back (22, spread out), remove-all keeps them gone until AUTO SPIKES is switched on, only the owner controls it, bots that can't split leave spikes alone, player pops are checked (near + big enough), popped spikes don't flash back.");
})().catch(error => { console.error(error); process.exitCode = 1; });
