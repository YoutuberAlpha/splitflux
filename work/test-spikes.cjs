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
    assert(spikes.every(spike => typeof spike.id === "string" && spike.id.length > 8));
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

  // A player's pop is checked by the server.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, bots: [], viruses: [{id: "far", x: 4000, y: 4000}]})`});
    const p = await game.player();
    let snap = await p.state({cells: [{netId: "a", x: 1000, y: 1000, mass: 28, alive: true}]});
    const at = snap.self.cells[0];
    // Pretend this player has already grown to 200 (the server's own record) and a spike sits right beside it.
    game.run(`sessions.get(${JSON.stringify(p.session.id)}).cells[0].mass = 200;
      world.viruses.push({id: "near", x: ${at.x + 80}, y: ${at.y}, r: 42, angle: 0}, {id: "small", x: 3000, y: 3000, r: 42, angle: 0});`);
    game.advance(100);
    snap = await p.state({ackRevision: snap.self.revision, cells: [{...snap.self.cells[0], mass: 200}], virusPops: ["far", "near"]});
    const left = game.run("world.viruses.map(spike => spike.id)");
    assert(!left.includes("near"), "A real pop removes the spike for everyone");
    assert(left.includes("far"), "A spike nowhere near the player cannot be popped");
    // A 50-mass player cannot pop a spike, even standing on it.
    const small = await game.player();
    const smallSnap = await small.state({cells: [{netId: "s", x: 2000, y: 2000, mass: 28, alive: true}]});
    const smallAt = smallSnap.self.cells[0];
    game.run(`world.viruses.find(spike => spike.id === "small").x = ${smallAt.x}; world.viruses.find(spike => spike.id === "small").y = ${smallAt.y};`);
    game.advance(100);
    await small.state({ackRevision: smallSnap.self.revision, cells: smallSnap.self.cells, virusPops: ["small"]});
    assert(game.run("world.viruses.some(spike => spike.id === 'small')"), "Pieces under 90 mass cannot pop spikes");
  }

  // The player's own game hides a spike it just popped until the server confirms, and shows the AUTO SPIKES state.
  {
    const source = fs.readFileSync(path.join(__dirname, "..", "multiplayer.js"), "utf8");
    const context = vm.createContext({BlobPhysics: physics, worldSize: 5200, bots: [], viruses: [], lastWorld: null, updateMapSizeLabel() {},
      isAdmin: false, normalizeNetworkCell: cell => cell, mergeNetworkCell: (_, cell) => cell, ejected: [], ejectedCache: new Map(),
      networkDelay: 0, performance: {now: () => 1000}, Date, rebuildSharedFood() {},
      poppedVirusIds: new Map([["popped", 3000]]), autoSpikesOn: true, labels: []});
    context.setAutoSpikesLabel = on => { context.labels.push(on); context.autoSpikesOn = on; };
    vm.runInContext(source.slice(source.indexOf("  function applyWorld("), source.indexOf("  // Brings the shared food up to date")), context);
    vm.runInContext("applyWorld({worldSize: 5200, autoSpikes: false, viruses: [{id: 'popped', x: 1, y: 1, r: 42}, {id: 'other', x: 9, y: 9, r: 42}]})", context);
    assert.deepEqual(Array.from(context.viruses, spike => spike.id), ["other"], "A just-popped spike must not flash back");
    assert.deepEqual(context.labels, [false], "The owner's AUTO SPIKES label follows the server");
  }

  console.log("PASS: spikes grow back (22, spread out), remove-all keeps them gone until AUTO SPIKES is switched on, only the owner controls it, bots that can't split leave spikes alone, player pops are checked (near + big enough), popped spikes don't flash back.");
})().catch(error => { console.error(error); process.exitCode = 1; });
