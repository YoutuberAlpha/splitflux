// Shared test helper: loads the real server.cjs in an isolated sandbox with a fake clock,
// so tests can call the real request handler, create players, and fast-forward time.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const physics = require("../physics.js");
const {captureResponse} = require("../cloud-runtime.cjs");

function createServer({world = "cleanWorld({worldSize: 5200, bots: [], viruses: []})"} = {}) {
  let clock = 1_000_000;
  class TestDate extends Date { static now() { return clock; } }
  const context = vm.createContext({
    require(name) {
      if (name === "http") return {createServer: () => ({listen() {}})};
      if (name === "fs") return {mkdirSync() {}, existsSync: () => true, readFileSync: () => JSON.stringify({key: "test-key"}), writeFileSync() {}, renameSync() {}};
      if (name === "./accounts.cjs") return () => ({
        fromRequest: request => request.headers["x-test-owner"] ? {username: "alpha", role: "owner", isAdmin: true} : null,
        remember() {}, forget() {},
      });
      if (name === "./moderation.cjs") return () => ({device: () => "device", until: () => 0, bannedBotTeams: () => []});
      if (name === "./physics.js") return physics;
      return require(name);
    },
    __dirname: path.join(__dirname, ".."), process: {env: {}}, Buffer, module: {exports: {}}, console,
    setInterval: () => ({unref() {}}), Date: TestDate, URL, Math, JSON,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "server.cjs"), "utf8"), context);
  vm.runInContext(`world = ${world};`, context);
  const handleRequest = context.module.exports.handleRequest;
  async function call(route, body, owner = false) {
    const response = captureResponse();
    await handleRequest({method: body ? "POST" : "GET", url: route, headers: {host: "test", ...(owner ? {"x-test-owner": "1"} : {})}, body}, response);
    return {status: response.statusCode, body: JSON.parse(response.body.toString() || "{}")};
  }
  async function player(owner = false) {
    const session = (await call("/api/session")).body;
    const who = {session, owner, snapshot: null, food: null};
    who.state = async (extra = {}) => {
      const result = await call("/api/state", {id: session.id, sessionKey: session.sessionKey, running: true, name: "T", color: "#55d6ff",
        ackRevision: who.snapshot?.self.revision || 0, cells: who.cells || [],
        foodSeed: who.food?.seed ?? null, ackFoodRevision: who.food?.revision ?? -1, ...extra}, owner);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      who.snapshot = result.body;
      // Compact updates only include the player's own pieces when the server changed them.
      if (result.body.self.cells) who.cells = result.body.self.cells;
      applyFood(who, result.body.food);
      return result.body;
    };
    // Eats every shared dot the piece passes over on its way from (fromX, fromY), like the real game.
    who.eat = (cell, fromX, fromY) => {
      const claims = [];
      const reach = physics.radius(cell.mass);
      for (let i = 0; i < who.food.dots.length; i++) {
        const dot = who.food.dots[i];
        if (Math.abs(dot.x - cell.x) > reach + 400 && Math.abs(dot.x - fromX) > reach + 400) continue;
        if (pathDistance(dot.x, dot.y, fromX, fromY, cell.x, cell.y) >= physics.radius(cell.mass) + dot.r) continue;
        claims.push([i, who.food.versions[i], cell.netId]);
        cell.mass += dot.value;
        who.food.versions[i] = (who.food.versions[i] + 1) & 255;
        who.food.dots[i] = physics.food.at(who.food.seed, i, who.food.versions[i], 5200);
      }
      return claims;
    };
    who.server = () => vm.runInContext(`sessions.get(${JSON.stringify(session.id)})`, context);
    return who;
  }
  const run = code => vm.runInContext(code, context);
  // Moves the fake clock forward and lets the arena simulate that time, like the real server loop.
  const tick = (ms, step = 40) => { for (let done = 0; done < ms; done += step) { clock += step; run("advanceArena()"); } };
  return {call, player, advance: ms => { clock += ms; }, tick, run, context};
}

function applyFood(who, sync) {
  if (!sync) return;
  if (typeof sync.full === "string") {
    const versions = new Uint8Array(Buffer.from(sync.full, "base64"));
    who.food = {seed: sync.seed, revision: sync.revision, versions,
      dots: Array.from(versions, (version, index) => physics.food.at(sync.seed, index, version, 5200))};
    return;
  }
  for (const [index, version] of sync.changes) {
    who.food.versions[index] = version;
    who.food.dots[index] = physics.food.at(who.food.seed, index, version, 5200);
  }
  who.food.revision = sync.revision;
}
function pathDistance(x, y, fromX, fromY, toX, toY) {
  const dx = toX - fromX, dy = toY - fromY, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - fromX) * dx + (y - fromY) * dy) / length)) : 0;
  return Math.hypot(x - fromX - dx * t, y - fromY - dy * t);
}

module.exports = {createServer, applyFood, pathDistance};
