// Batch 2 bots: split pieces regroup and merge, each bot has its own piece limit, a shattered bot
// can't block respawns, and catch-up growth is capped so huge players (or the owner's X10) don't inflate bots.
const assert = require("assert/strict");
const {createServer} = require("./server-harness.cjs");
const piece = (team, i, x, y, mass, extra = "") => `{netId: "${team}-${i}", name: "${team}", botTeam: "${team}", x: ${x}, y: ${y}, mass: ${mass}, alive: true${extra}}`;

(async () => {
  // A bot shattered into 8 scattered pieces pulls itself back together once its merge time is over.
  {
    const scattered = Array.from({length: 8}, (_, i) => piece("Alex", i, 600 + (i % 4) * 1100, 800 + Math.floor(i / 4) * 2600, 300, ", serverMergeAt: 1"));
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [], bots: [${scattered}]})`});
    game.run("targetBotTeams = 1; serverFallbackActive = true");
    game.tick(25_000);
    const alex = game.run("world.bots.filter(bot => bot.botTeam === 'Alex').map(bot => bot.mass)");
    assert(alex.length <= 2, "Scattered pieces must regroup and merge, still " + alex.length + " pieces");
    // Merging keeps the mass; only the slow decay of big blobs (over 400) takes a little: ~2,300 left after 25 s.
    assert(alex.reduce((sum, mass) => sum + mass, 0) >= 2250, "Merging keeps the mass");
  }

  // Each bot has its own 16-piece limit: a full bot can't split, but a different bot still can,
  // even with lots of pieces on the map (the old shared limit of 96 blocked everyone).
  {
    const alex = Array.from({length: 16}, (_, i) => piece("Alex", i, 300 + i * 40, 300, 40));
    const others = Array.from({length: 80}, (_, i) => piece("Team" + i, 0, 300 + (i % 20) * 240, 2000 + Math.floor(i / 20) * 300, 30));
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [], bots: [${[...alex, ...others, piece("Bob", 0, 4000, 4500, 400)]}]})`});
    assert.equal(game.run("splitServerBot(world.bots.find(bot => bot.netId === 'Alex-0'), null, 6)"), 0, "A bot at 16 pieces cannot split");
    assert(game.run("splitServerBot(world.bots.find(bot => bot.netId === 'Bob-0'), null, 6)") > 0, "Another bot can still split");
  }

  // Six bots shattered into 96 pieces no longer stop new bots from joining.
  {
    const shattered = [];
    for (let team = 0; team < 6; team++) for (let i = 0; i < 16; i++) shattered.push(piece("Shard" + team, i, 200 + i * 300, 300 + team * 800, 20, ", serverMergeAt: 9e15"));
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [], bots: [${shattered}]})`});
    game.run("serverFallbackActive = true");
    game.tick(1_000);
    const teams = game.run("new Set(world.bots.map(bot => bot.botTeam)).size");
    assert(teams > 6, "New bots must still join when existing bots are shattered, teams: " + teams);
  }

  // Catch-up growth follows players, but stops at 42% of 2,500 even if someone is 100,000 mass.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [], bots: [${piece("Lone", 0, 600, 600, 30)}]})`});
    game.run("targetBotTeams = 1; serverFallbackActive = true");
    const owner = await game.player(true);
    let snap = await owner.state({cells: [{netId: "huge", x: 4600, y: 4600, mass: 100000, alive: true}]});
    assert.equal(game.run("assistReferenceMass()"), 2500);
    for (let i = 0; i < 40; i++) {
      game.tick(4_000);
      snap = await owner.state({ackRevision: snap.self.revision});
    }
    const mass = game.run("world.bots[0].mass");
    assert(mass > 900 && mass < 1100, "Bot catch-up growth must stop near 1,050, got " + mass);
  }

  console.log("PASS: shattered bots regroup and merge, 16-piece limit per bot (others can still split), shattered bots don't block new bots, catch-up growth capped at 42% of 2,500.");
})().catch(error => { console.error(error); process.exitCode = 1; });
