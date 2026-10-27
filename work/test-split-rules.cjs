// Bug 5: split rules on the player's side (minimum piece size and the 16-piece limit).
const assert = require("assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const physics = require("../physics.js");
const game = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
const splitCode = game.slice(game.indexOf("function aimDirection()"), game.indexOf("function feedMass()"));
function play(mass) {
  const context = vm.createContext({BlobPhysics: physics, running: true, width: 1000, height: 1000, pointer: {x: 900, y: 500}, worldSize: 10000,
    performance: {now: () => 1000}, radiusForMass: physics.radius, emit() {}, clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
    boundCell: (v, r) => Math.max(r, Math.min(10000 - r, v)),
    playerCells: [{netId: "start", x: 5000, y: 5000, mass, radius: physics.radius(mass), alive: true}], player: null});
  vm.runInContext(splitCode, context);
  return context;
}
const sum = cells => cells.reduce((total, cell) => total + cell.mass, 0);

let p = play(28);
for (let i = 0; i < 7; i++) vm.runInContext("splitPlayer()", p);
assert.equal(p.playerCells.length, 1, "A starting cell (28 mass) is too small to split");

p = play(36);
vm.runInContext("splitPlayer(); splitPlayer();", p);
assert.equal(p.playerCells.length, 2, "35+ mass splits once, but the halves are too small to split again");

for (const trick of ["splitPlayer", "quadSplitPlayer", "tripleSplitPlayer", "fiveSplitPlayer", "sixSplitPlayer", "squareSplitPlayer"]) {
  p = play(5000);
  for (let i = 0; i < 10; i++) vm.runInContext(trick + "()", p);
  assert(p.playerCells.length <= 16, trick + " must respect the 16-piece limit, got " + p.playerCells.length);
  assert(Math.abs(sum(p.playerCells) - 5000) < 1e-6, trick + " must keep the total mass");
  assert(p.playerCells.every(cell => cell.mass >= 17.5 - 1e-9), trick + " must not make pieces under 17.5 mass");
}

p = play(60);
vm.runInContext("sixSplitPlayer()", p);
assert.equal(p.playerCells.length, 3, "A trick split makes only as many pieces as the mass allows (60 / 17.5 = 3)");

console.log("PASS: cells under 35 mass cannot split, pieces never drop below 17.5 mass, every trick split stops at 16 pieces and keeps total mass.");
