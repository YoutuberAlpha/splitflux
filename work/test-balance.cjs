// Batch 2 balance: big blobs slowly shrink (players and bots), and new players spawn away from
// anything that could reach them during 5 seconds of protection, which bots respect.
const assert = require("assert/strict");
const {createServer} = require("./server-harness.cjs");

(async () => {
  // A 5,000-mass player loses 0.2%/s of the mass above 400; a 300-mass player doesn't shrink.
  {
    const game = createServer();
    game.run("targetBotTeams = 0");
    const big = await game.player(), small = await game.player();
    let bigSnap = await big.state({cells: [{netId: "big", x: 1000, y: 1000, mass: 28, alive: true}]});
    let smallSnap = await small.state({cells: [{netId: "small", x: 4000, y: 4000, mass: 28, alive: true}]});
    game.run(`sessions.get(${JSON.stringify(big.session.id)}).cells[0].mass = 5000; sessions.get(${JSON.stringify(small.session.id)}).cells[0].mass = 300;`);
    for (let i = 0; i < 10; i++) {
      game.tick(1_000);
      bigSnap = await big.state({ackRevision: bigSnap.self.revision});
      smallSnap = await small.state({ackRevision: smallSnap.self.revision});
    }
    const expected = 400 + 4600 * Math.exp(-.002 * 10);
    assert(Math.abs(bigSnap.self.cells[0].mass - expected) < 15, `Expected about ${expected.toFixed(0)}, got ${bigSnap.self.cells[0].mass.toFixed(0)}`);
    assert.equal(smallSnap.self.cells[0].mass, 300, "Blobs under 400 mass don't shrink");
  }

  // A 20,000-mass bot shrinks the same way when nobody is around.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [], bots: [{netId: "giant", name: "Chloe", botTeam: "Chloe", x: 2600, y: 2600, mass: 20000, alive: true}]})`});
    game.run("targetBotTeams = 1; serverFallbackActive = true");
    game.tick(60_000);
    const expected = 400 + 19600 * Math.exp(-.002 * 60);
    assert(Math.abs(game.run("world.bots[0].mass") - expected) < 60, "Giant bots must slowly shrink");
  }

  // A newcomer asking to spawn next to a giant is moved outside the giant's 5-second reach and protected for 5 s.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [], bots: [{netId: "giant", name: "Chloe", botTeam: "Chloe", x: 2600, y: 2600, mass: 20000, alive: true}]})`});
    game.run("targetBotTeams = 1");
    const p = await game.player();
    const snap = await p.state({cells: [{netId: "new", x: 2650, y: 2600, mass: 28, alive: true}]});
    const at = snap.self.cells[0];
    const giantReach = Math.sqrt(20000) * 4.2 + 8 + 235 / Math.pow(20000 / 25, .18) * 5 + 150;
    assert(Math.hypot(at.x - 2600, at.y - 2600) >= giantReach, "Spawn must be outside the giant's reach");
    const left = game.run(`sessions.get(${JSON.stringify(p.session.id)}).spawnProtectedUntil - Date.now()`);
    assert(left > 4900 && left <= 5000, "Spawn protection lasts 5 seconds");
  }

  // Bots don't hunt protected newcomers, but do once protection ends.
  {
    const game = createServer({world: `cleanWorld({worldSize: 5200, autoSpikes: false, viruses: [], bots: []})`});
    game.run("targetBotTeams = 1; serverFallbackActive = true");
    const p = await game.player();
    const snap = await p.state({cells: [{netId: "new", x: 1500, y: 1500, mass: 28, alive: true}]});
    const at = snap.self.cells[0];
    const placeHunter = () => game.run(`world.bots = [{netId: "hunter", name: "Maya", botTeam: "Maya", x: ${at.x + 300}, y: ${at.y}, mass: 2000,
      radius: Math.sqrt(2000) * 4.2 + 8, alive: true, vx: 0, vy: 0, launchX: 0, launchY: 0, think: 0, splitCooldown: 9, targetX: 9999, targetY: 9999, serverMergeAt: 0}];
      simulateServerBots(.001); [world.bots[0].targetX, world.bots[0].targetY]`);
    let target = placeHunter();
    assert(Math.hypot(target[0] - at.x, target[1] - at.y) > 50, "Bots must not chase a protected newcomer");
    game.advance(5_100);
    target = placeHunter();
    assert(Math.hypot(target[0] - at.x, target[1] - at.y) < 5, "Bots hunt normally after protection ends");
  }

  console.log("PASS: big players and bots shrink 0.2%/s above 400 (small ones don't), spawns avoid a giant's 5-second reach, 5 s protection, bots ignore protected newcomers until it ends.");
})().catch(error => { console.error(error); process.exitCode = 1; });
