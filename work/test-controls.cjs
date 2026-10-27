// Batch 2 controls: movement follows the mouse only, held keys are released on blur, M needs two presses.
const assert = require("assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const game = fs.readFileSync(path.join(__dirname, "..", "game.js"), "utf8");
const slice = (from, to) => game.slice(game.indexOf(from), game.indexOf(to));

// Keyboard keys that used to steer (A, S, D, arrows) must not override the mouse.
const movement = vm.createContext({
  playerCells: [{x: 1000, y: 1000, mass: 28, alive: true}], pointer: {x: 640 + 300, y: 400}, camera: {zoom: 1}, width: 1280, height: 800,
  keys: {KeyA: true, KeyS: true, KeyD: false, ArrowLeft: true, ArrowUp: true}, feedCooldown: 0, onlineMode: true, offlineBotFeedCooldown: 0,
  followedBotTeam: null, targets: [], feedMass() {}, separatePlayerCells() {},
});
movement.steer = (cell, x, y) => movement.targets.push({x, y});
vm.runInContext(slice("function updatePlayer(dt)", "function aimDirection()") + "updatePlayer(1 / 60);", movement);
assert.equal(movement.targets[0].x, 1300, "Steering must follow the mouse to the right even while A / Left are held");
assert.equal(movement.targets[0].y, 1000, "Up / S keys must not move the blob");

// Switching windows while holding a key must not leave it stuck.
const blur = vm.createContext({keys: {KeyW: true, KeyD: true, ArrowLeft: true}, spikePainting: true, stopMobileFeed() {}});
vm.runInContext(slice("function releaseHeldActions()", 'addEventListener("blur"') + "releaseHeldActions();", blur);
assert.deepEqual(Object.keys(blur.keys), [], "Every held key is released when the window loses focus");

// M once shows a warning; M again within 1.5 s leaves; a slow second press only warns again.
let now = 1000;
const notice = {classList: {toggle() {}, remove() {}}, setAttribute() {}, textContent: ""};
const menu = vm.createContext({running: true, left: 0, performance: {now: () => now}, setTimeout: () => 0, clearTimeout() {},
  document: {querySelector: () => notice, createElement: () => notice, body: {append() {}}}});
menu.returnToMainMenu = () => { menu.left++; };
vm.runInContext(slice("let menuArmedUntil = 0;", "function returnToMainMenu()"), menu);
vm.runInContext('requestMainMenu("Press M again to leave this round");', menu);
assert.equal(menu.left, 0, "One press must not leave the round");
assert.match(notice.textContent, /Press M again/);
now += 800;
vm.runInContext('requestMainMenu("Press M again to leave this round");', menu);
assert.equal(menu.left, 1, "A second press within 1.5 s leaves the round");
now += 5000;
vm.runInContext('requestMainMenu("x"); ', menu);
now += 2000;
vm.runInContext('requestMainMenu("x"); ', menu);
assert.equal(menu.left, 1, "Two presses far apart must not leave the round");

// Plain S is no longer a shortcut; the owner's clear-spikes shortcut is Shift+S.
assert(/e\.code === "KeyS" && e\.shiftKey/.test(game), "Clear spikes needs Shift+S");
console.log("PASS: steering follows the mouse even with A/S/D/arrows held, blur releases every key, M needs two quick presses, clear spikes is Shift+S.");
