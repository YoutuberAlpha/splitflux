// Hosting batch, bandwidth: updates only carry what the screen draws, the team table and spike list only travel
// when they changed, a pellet is sent once, the player's own pieces only on corrections, no private server notes,
// and the game decodes all of it back into the same bots, spikes and pellets.
const assert = require("assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const physics = require("../physics.js");
const {createServer} = require("./server-harness.cjs");

const piece = (team, i, x, y, mass, color = "#ff8844") =>
  `{netId: "${team}-${i}-0000-uuid-${"x".repeat(20)}", name: "${team}", botTeam: "${team}", x: ${x}, y: ${y}, mass: ${mass}, color: "${color}", accent: "#ffffff", alive: true}`;

(async () => {
  // A busy arena: many bots and spikes, plus another player with several pieces.
  const bots = [];
  for (let team = 0; team < 30; team++) for (let i = 0; i < 2; i++) bots.push(piece("Team" + team, i, 300 + team * 300 + i * 40, 400 + team * 250, 80 + team));
  const spikes = Array.from({length: 60}, (_, i) => `{id: "spike-${i}-${"y".repeat(28)}", x: ${200 + (i % 10) * 900}, y: ${300 + Math.floor(i / 10) * 1500}}`);
  const game = createServer({world: `cleanWorld({worldSize: 10400, autoSpikes: false, bots: [${bots}], viruses: [${spikes}]})`});
  const me = await game.player(), other = await game.player();
  await me.state({cells: [{netId: "mine", x: 5000, y: 5000, mass: 28, alive: true}]});
  await other.state({cells: [{netId: "theirs", x: 6000, y: 6000, mass: 28, alive: true}]});
  game.advance(100);

  const legacy = await me.state();
  const first = await me.state({view: 2});
  const firstSize = JSON.stringify(first).length, legacySize = JSON.stringify(legacy).length;
  assert(firstSize < legacySize * .5, `A compact first update must be under half the old size (${firstSize} vs ${legacySize})`);

  // Bots are short lists; the team table carries names and colours.
  const [id, team, x, y, mass, vx, vy] = first.world.bots[0];
  assert(typeof id === "string" && id.length <= 7, "Bot ids are short fingerprints");
  assert.equal(team, "Team0");
  assert.deepEqual(first.world.teams.Team0, ["Team0", "#ff8844", "#ffffff"]);
  assert(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(vx) && Number.isInteger(vy), "Positions and speeds are whole numbers");
  assert.equal(mass, 80);
  assert.equal(first.world.viruses.length, 60, "The first update has the whole spike list");
  // Nothing private leaves the server.
  const text = JSON.stringify(first);
  for (const secret of ["_travelCredit", "_boostCredit", "_moveFromX", "think", "serverMergeAt", "nextSpikeAt", "targetX", "ownerSessionId"])
    assert(!text.includes(secret), "Compact updates must not include " + secret);
  assert(!JSON.stringify(legacy.self).includes("_travelCredit"), "Even the old format hides anti-cheat notes");

  // With the fingerprints sent back, the next update skips the team table and spike list.
  const ack = {view: 2, ackTeams: first.world.teamsSig, ackSpikes: first.world.spikesSig};
  game.advance(100);
  const steady = await me.state(ack);
  assert.equal(steady.world.teams, undefined, "An unchanged team table is not resent");
  assert.equal(steady.world.viruses, undefined, "An unchanged spike list is not resent");
  assert.equal(steady.self.cells, undefined, "Own pieces only come with a correction");
  assert.equal(steady.players.length, 1);
  assert.equal(steady.players[0].cells[0].length, 6, "Other players' pieces are [id, x, y, mass, vx, vy]");
  const steadySize = JSON.stringify(steady).length;
  assert(steadySize < legacySize * .12, `A steady update must be under 12% of the old size (${steadySize} vs ${legacySize})`);

  // A change (a spike popped, a new bot team) brings the new list back.
  game.run(`world.viruses.pop(); world.bots.push(${piece("Newcomer", 0, 7000, 7000, 40, "#123456")});`);
  game.advance(100);
  const changed = await me.state(ack);
  assert.equal(changed.world.viruses.length, 59, "A changed spike list is resent");
  assert.deepEqual(changed.world.teams.Newcomer, ["Newcomer", "#123456", "#ffffff"], "A changed team table is resent");

  // A server correction brings the player's own pieces back.
  game.run(`sessions.get(${JSON.stringify(me.session.id)}).revision++`);
  const corrected = await me.state({...ack, ackTeams: changed.world.teamsSig, ackSpikes: changed.world.spikesSig});
  assert.equal(corrected.self.cells.length, 1, "Corrections include the pieces");

  // Pellets: sent once, then only their numbers while they are in the air. The feeder sees the real id.
  game.run(`world.ejected.push(
    {...BlobPhysics.createFeed({x: 5000, y: 5000, mass: 300}, 1, 0, null, 10400), netId: "my-own-pellet-id-${"z".repeat(30)}", color: "#55d6ff",
      ownerSessionId: ${JSON.stringify(me.session.id)}, ownerCellId: "mine", ownerUntil: Date.now() + 700, createdAt: Date.now()},
    {...BlobPhysics.createFeed({x: 6000, y: 6000, mass: 300}, 0, 1, null, 10400), netId: "their-pellet-id-${"z".repeat(30)}", color: "#ff0000",
      ownerSessionId: ${JSON.stringify(other.session.id)}, ownerCellId: "theirs", ownerUntil: Date.now() + 700, createdAt: Date.now()});`);
  const withPellets = await me.state(ack);
  assert.equal(withPellets.world.ejected.length, 2);
  assert(withPellets.world.ejected[0].netId.startsWith("my-own-pellet-id"), "The feeder gets their own pellet's real id");
  assert(withPellets.world.ejected[1].netId.length <= 7, "Other people's pellets get a short id");
  const seqs = withPellets.world.ejected.map(pellet => pellet.seq);
  const later = await me.state({...ack, ackEjected: Math.max(...seqs)});
  assert.equal(later.world.ejected.length, 0, "Pellets the game already has are not resent");
  assert.deepEqual(later.world.ejectedLive, seqs, "Their numbers show they are still in the air");
  const otherView = await other.state({view: 2});
  assert(otherView.world.ejected[1].netId.startsWith("their-pellet-id"), "Each feeder sees their own real id");
  assert.equal(otherView.world.ejected[0].netId.length <= 7, true);

  // The owner's arena commands answer in the same compact form.
  const owner = await game.player(true);
  const arena = await game.call("/api/admin/arena", {id: owner.session.id, sessionKey: owner.session.sessionKey, view: 2, autoSpikes: true}, true);
  assert(Array.isArray(arena.body.world.bots[0]) && arena.body.world.teams && arena.body.world.viruses, "Admin answers are compact and complete");

  // ---- The game decodes compact updates back into bots, spikes and pellets. ----
  const source = fs.readFileSync(path.join(__dirname, "..", "multiplayer.js"), "utf8");
  const client = vm.createContext({BlobPhysics: physics, worldSize: 5200, bots: [], viruses: [], lastWorld: null, updateMapSizeLabel() {},
    isAdmin: false, normalizeNetworkCell: cell => cell, mergeNetworkCell: (_, cell) => ({...cell}), ejected: [], ejectedCache: new Map(),
    networkDelay: 0, performance: {now: () => 1000}, Date, rebuildSharedFood() {}, poppedVirusIds: new Map(), autoSpikesOn: false,
    setAutoSpikesLabel() {}, botTeamInfo: new Map(), serverViruses: [], teamsSig: "", spikesSig: "", radiusForMass: m => Math.sqrt(m) * 4.2 + 8});
  vm.runInContext(source.slice(source.indexOf("  // A compact bot is"), source.indexOf("  // Brings the shared food up to date")), client);
  client.first = first.world; client.steady = steady.world; client.pellets = withPellets.world; client.later = later.world;
  vm.runInContext("applyWorld(first)", client);
  const bot = vm.runInContext("bots.find(bot => bot.botTeam === 'Team3')", client);
  assert.equal(bot.name, "Team3"); assert.equal(bot.color, "#ff8844"); assert.equal(bot.alive, true);
  assert.equal(bot.radius, Math.sqrt(83) * 4.2 + 8, "The game works out the radius from the mass");
  assert.equal(client.teamsSig, first.world.teamsSig, "The game remembers which team table it has");
  assert.equal(client.viruses.length, 60);
  vm.runInContext("applyWorld(steady)", client);
  assert.equal(vm.runInContext("bots.find(bot => bot.botTeam === 'Team3').name", client), "Team3", "Names survive updates without the table");
  assert.equal(client.viruses.length, 60, "Spikes stay when the list is not resent");
  vm.runInContext("applyWorld(pellets)", client);
  assert.equal(client.ejected.length, 2);
  assert.equal(vm.runInContext("newestPelletSeq()", client), Math.max(...seqs), "The game tells the server its newest pellet");
  client.later = {...later.world, ejectedLive: [seqs[1]]};  // the first pellet got eaten
  vm.runInContext("applyWorld(later)", client);
  assert.deepEqual(Array.from(client.ejected, pellet => pellet.seq), [seqs[1]], "Eaten pellets disappear, the rest stay");
  // Other players' compact pieces.
  const remote = vm.runInContext("[" + source.slice(source.indexOf("  function decodeRemoteCell("), source.indexOf("  // Tells the server the newest pellet")) + "][0]", client);
  assert.deepEqual({...remote(["abc", 10, 20, 30, 1, 2])}, {netId: "abc", x: 10, y: 20, mass: 30, radius: Math.sqrt(30) * 4.2 + 8, vx: 1, vy: 2, alive: true});

  // About 10 updates a second while playing, slower on the menu and in a hidden tab.
  assert(/document\.hidden \? 3000 : running \? \(roomTransport\.realtime \? 100 : 200\) : 1500/.test(source), "Sync rate: 10/s playing (5/s in backup mode), 1.5 s menu, 3 s hidden");
  assert(/view: 2/.test(source), "The game asks for compact updates");

  console.log(`PASS: compact updates (first ${firstSize} B, steady ${steadySize} B vs old ${legacySize} B), team table and spikes only when changed, own pieces only on corrections, pellets sent once, no private fields, the game decodes everything, 10 updates/s.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
