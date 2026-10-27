// Anti-cheat regression tests (bugs 1, 2, 3 and the server half of 5).
// Loads server.cjs in an isolated context with a controllable clock and calls the real request handler.
const assert = require("assert/strict");
const vm = require("vm");
const physics = require("../physics.js");
const {createServer} = require("./server-harness.cjs");

const total = cells => cells.reduce((sum, cell) => sum + cell.mass, 0);
const speedFor = mass => 235 / Math.pow(mass / 25, .18);

(async () => {
  // Bug 1: spawning big is impossible.
  {
    const game = createServer();
    const cheater = await game.player();
    const snap = await cheater.state({cells: [{netId: "a", x: 2600, y: 2600, mass: 1e9, alive: true}]});
    assert(total(snap.self.cells) <= 50, "A new round must start at the normal size, got " + total(snap.self.cells));
  }

  // Bug 1: normal movement and normal eating are never corrected.
  {
    const game = createServer();
    const p = await game.player();
    let snap = await p.state({cells: [{netId: "a", x: 1000, y: 1000, mass: 28, alive: true}]});
    const cell = {...snap.self.cells[0]};
    const startRevision = snap.self.revision;
    let angle = 0;
    let eaten = 0;
    for (let step = 0; step < 200; step++) {
      // Real clients send every 75-300 ms and requests arrive with uneven delay.
      const sendGap = 75 + Math.random() * 225;
      game.advance(sendGap);
      const fromX = cell.x, fromY = cell.y;
      // Full speed while slowly turning, bouncing off the walls.
      angle += .15;
      const travel = speedFor(cell.mass) * sendGap / 1000 * .98;
      cell.x += Math.cos(angle) * travel;
      cell.y += Math.sin(angle * .7) * travel * .6;
      if (cell.x > 4600 || cell.x < 600 || cell.y > 4600 || cell.y < 600) {
        cell.x = Math.max(600, Math.min(4600, cell.x)); cell.y = Math.max(600, Math.min(4600, cell.y)); angle += Math.PI;
      }
      const foodClaims = p.eat(cell, fromX, fromY);
      eaten += foodClaims.length;
      snap = await p.state({cells: [cell], ackRevision: snap.self.revision, foodClaims});
    }
    assert(eaten > 500, "The test player should have eaten plenty of food, ate " + eaten);
    assert.equal(snap.self.revision, startRevision, "Honest movement and eating must never be corrected");
    assert(Math.abs(snap.self.cells[0].mass - cell.mass) < 1e-6, "Server and player must agree on size");
  }

  // Bug 1: teleporting, leaving the map and instant growth are corrected.
  {
    const game = createServer();
    const p = await game.player();
    let snap = await p.state({cells: [{netId: "a", x: 1000, y: 1000, mass: 28, alive: true}]});
    game.advance(100);
    snap = await p.state({cells: [{...snap.self.cells[0], x: 4500, y: 4500}], ackRevision: snap.self.revision});
    const moved = Math.hypot(snap.self.cells[0].x - 1000, snap.self.cells[0].y - 1000);
    assert(moved < 750, "Teleports must be cut back to normal travel, moved " + moved);
    game.advance(100);
    snap = await p.state({cells: [{...snap.self.cells[0], x: -1e9}], ackRevision: snap.self.revision});
    assert(snap.self.cells[0].x >= snap.self.cells[0].radius - 1e-6, "Pieces must stay inside the map");
    const before = total(snap.self.cells);
    game.advance(100);
    snap = await p.state({cells: [{...snap.self.cells[0], mass: 1e10}], ackRevision: snap.self.revision});
    assert(Math.abs(total(snap.self.cells) - before) < 1e-6, "Mass cannot grow without food, got " + total(snap.self.cells));
  }

  // Bug 1: made-up pieces are rejected; honest splits are kept and keep their mass.
  {
    const game = createServer();
    const p = await game.player();
    let snap = await p.state({cells: [{netId: "a", x: 2000, y: 2000, mass: 28, alive: true}]});
    for (let i = 0; i < 40; i++) { game.advance(250); snap = await p.state({cells: [{...snap.self.cells[0], mass: snap.self.cells[0].mass + 5, x: snap.self.cells[0].x + 40}], ackRevision: snap.self.revision}); }
    const parent = snap.self.cells[0];
    game.advance(80);
    snap = await p.state({ackRevision: snap.self.revision, cells: [
      {...parent, mass: parent.mass / 2, massOrigins: {a: .5}},
      {...parent, netId: "child", x: parent.x + 120, mass: parent.mass / 2, massOrigins: {a: .5}},
      {netId: "ghost", x: 100, y: 100, mass: 500, alive: true},
    ]});
    assert.deepEqual(snap.self.cells.map(cell => cell.netId).sort(), ["a", "child"], "Made-up pieces must be dropped");
    assert(Math.abs(total(snap.self.cells) - parent.mass) < 1e-6, "Honest splits keep their mass");
    const many = Array.from({length: 24}, (_, i) => ({...parent, netId: "piece-" + i, mass: parent.mass / 24, massOrigins: {a: 1 / 24, child: 0}}));
    game.advance(80);
    snap = await p.state({ackRevision: snap.self.revision, cells: many});
    assert(snap.self.cells.length <= 16, "At most 16 pieces");
    assert(total(snap.self.cells) <= parent.mass + 1e-6, "Capping pieces must not create mass");
  }

  // Bug 2: a fake acknowledgement no longer brings an eaten player back.
  {
    const game = createServer();
    const p = await game.player();
    let snap = await p.state({cells: [{netId: "a", x: 2000, y: 2000, mass: 28, alive: true}]});
    const mine = snap.self.cells;
    vm.runInContext(`for (const cell of sessions.get(${JSON.stringify(p.session.id)}).cells) cell.alive = false; sessions.get(${JSON.stringify(p.session.id)}).revision++;`, game.context);
    game.advance(80);
    snap = await p.state({cells: mine, ackRevision: 1e12});
    assert.equal(snap.self.cells.length, 0, "An eaten player must stay eaten even with a forged acknowledgement");
    assert.equal(snap.self.dead, true);
  }

  // Bug 2: pieces split off an eaten piece die with it, even if the player also ate food meanwhile.
  {
    const game = createServer();
    const p = await game.player();
    let snap = await p.state({cells: [{netId: "a", x: 2000, y: 2000, mass: 28, alive: true}, ]});
    game.advance(100);
    snap = await p.state({cells: [{...snap.self.cells[0], netId: "a"}], ackRevision: snap.self.revision});
    const lastReply = snap.self.revision;
    const parent = snap.self.cells[0];
    vm.runInContext(`const s = sessions.get(${JSON.stringify(p.session.id)}); s.cells[0].alive = false; s.revision++;`, game.context);
    game.advance(80);
    snap = await p.state({ackRevision: lastReply, cells: [
      {...parent, mass: parent.mass / 2 + 2, massOrigins: {a: .5}},
      {...parent, netId: "kid", x: parent.x + 60, mass: parent.mass / 2 + 2, massOrigins: {a: .5}},
    ]});
    assert.equal(snap.self.cells.length, 0, "Remnants of an eaten piece must not survive");
  }

  // Bug 3: bites must be real, reachable and not already taken; everyone sees the same food.
  {
    const game = createServer();
    const a = await game.player(), b = await game.player();
    let snapA = await a.state({cells: [{netId: "a", x: 1000, y: 1000, mass: 28, alive: true}]});
    let snapB = await b.state({cells: [{netId: "b", x: 4000, y: 4000, mass: 28, alive: true}]});
    assert.equal(a.food.seed, b.food.seed, "Both players get the same food");
    const cell = {...snapA.self.cells[0]};
    // A far-away dot cannot be claimed.
    const far = a.food.dots.findIndex(dot => Math.hypot(dot.x - cell.x, dot.y - cell.y) > 2000);
    const before = cell.mass;
    game.advance(100);
    snapA = await a.state({ackRevision: snapA.self.revision, cells: [{...cell, mass: before + a.food.dots[far].value}],
      foodClaims: [[far, a.food.versions[far], "a"]]});
    assert(Math.abs(total(snapA.self.cells) - before) < 1e-6, "A far-away bite earns nothing");
    assert(snapA.food.changes.some(([index, version]) => index === far && version === a.food.versions[far]), "The player is told the dot is still there");
    // A real bite is confirmed and shows up for the other player.
    let near = 0;
    a.food.dots.forEach((dot, index) => { if (Math.hypot(dot.x - cell.x - 60, dot.y - cell.y) < Math.hypot(a.food.dots[near].x - cell.x - 60, a.food.dots[near].y - cell.y)) near = index; });
    const target = a.food.dots[near];
    const moved = {...snapA.self.cells[0], x: target.x, y: target.y};
    const version = a.food.versions[near];
    const fromX = snapA.self.cells[0].x, fromY = snapA.self.cells[0].y;
    const claims = a.eat(moved, fromX, fromY);
    game.advance(400);
    snapA = await a.state({ackRevision: snapA.self.revision, cells: [moved], foodClaims: claims});
    assert(Math.abs(total(snapA.self.cells) - moved.mass) < 1e-6, "Real bites are credited exactly");
    game.advance(100);
    snapB = await b.state({ackRevision: snapB.self.revision});
    assert.equal(b.food.versions[near], (version + 1) & 255, "Other players see the dot get eaten");
    // The same dot cannot be eaten twice.
    snapB = await b.state({ackRevision: snapB.self.revision, foodClaims: [[near, version, "b"]]});
    assert(Math.abs(total(snapB.self.cells) - 28) < 1e-6, "A dot someone else already ate earns nothing");
  }

  // The owner keeps admin powers (e.g. the X10 size button).
  {
    const game = createServer();
    const owner = await game.player(true);
    let snap = await owner.state({cells: [{netId: "o", x: 2000, y: 2000, mass: 28, alive: true}]});
    game.advance(80);
    snap = await owner.state({cells: [{...snap.self.cells[0], mass: 280000}], ackRevision: snap.self.revision});
    assert.equal(snap.self.cells[0].mass, 280000);
  }

  console.log("PASS: spawn size, honest play untouched, teleports/off-map/growth without food corrected, fake pieces and 16-piece cap enforced, forged acknowledgements and eaten remnants cannot revive a player, shared food bites checked and synced, owner powers kept.");
})().catch(error => { console.error(error); process.exitCode = 1; });
