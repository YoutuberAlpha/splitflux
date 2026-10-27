const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const BlobPhysics = require("./physics.js");

const root = __dirname;
const cloudMode = process.env.SPLITFLUX_CLOUD_MODE === "1";
const port = Number(process.env.PORT) || 1000;
const adminPassword = process.env.SPLITFLUX_OWNER_PASSWORD || process.env.TRICKSPLIT_ADMIN_PASSWORD;
const dataDirectory = process.env.SPLITFLUX_DATA_DIR || process.env.TRICKSPLIT_DATA_DIR || path.join(root, ".tricksplit-data");
fs.mkdirSync(dataDirectory, { recursive: true });
const adminKeyPath = path.join(dataDirectory, "admin-key.json");
if (!fs.existsSync(adminKeyPath)) {
  fs.writeFileSync(adminKeyPath, JSON.stringify({ key: crypto.randomBytes(32).toString("hex") }), { mode: 0o600, flag: "wx" });
}
const rememberedAdminKey = JSON.parse(fs.readFileSync(adminKeyPath, "utf8")).key;
const accounts = require("./accounts.cjs")(dataDirectory, rememberedAdminKey, adminPassword);
const moderation = require("./moderation.cjs")(dataDirectory, rememberedAdminKey);

const sessions = new Map();
let realtime=null;
let ownerId = null;
let world = null;
// Shared food: one seed for the arena plus how many times each slot was eaten (0-255).
// Positions come from BlobPhysics.food.at(), so only these small numbers are stored and sent.
let foodState = null;
let worldRevision = 0;
let botRevision = 0;
let botMassRevision = 0;
let serverBotCounter = 0;
let serverFallbackActive = false;
let botRespawnBlockedUntil = 0;
let targetBotTeams = 24;
let botPieceCap = 96;

// Player anti-cheat limits. The client predicts its own movement for smooth play,
// but the server decides what is physically possible before trusting it.
// Food is dense, so a new cell (28 mass) can eat a little before its first update reaches the server.
const SPAWN_MASS_LIMIT = 50;
const MAX_PLAYER_CELLS = 16;
const PLAYER_BASE_SPEED = 235;
// The smallest piece the rules can make is a spike burst (90 mass into 7 = ~12.9).
// Speed is never computed below this, so made-up tiny pieces cannot zip across the map.
const MIN_SPEED_MASS = 12;
const FOOD_COUNT = BlobPhysics.food.count;
const FOOD_LOG_LIMIT = 1500;
const MAX_FOOD_CLAIMS = 600;
// Only isolated tests that are not about anti-cheat may skip these checks.
const trustClientForTests = process.env.NODE_ENV === "test" && process.env.SPLITFLUX_TEST_TRUST_CLIENT === "1";
foodState = createFoodState();

// Sign-in protection against password guessing (bug 4). Wrong passwords are counted per account
// (works even if an attacker keeps clearing cookies), per browser, and across the whole server.
const SIGN_IN_WINDOW_MS = 15 * 60_000;
const ACCOUNT_FREE_FAILURES = 5;
const DEVICE_FREE_FAILURES = 10;
const SERVER_FAILURE_LIMIT = 100;
const SERVER_FAILURE_WINDOW_MS = 10 * 60_000;
const DEVICE_REGISTRATIONS_PER_HOUR = 3;
const SERVER_REGISTRATIONS_PER_HOUR = 40;
let signInGuard = createSignInGuard();

const SERVER_BOT_NAMES = [
  "Alex", "Maya", "Jordan", "Sofia", "Ethan", "Chloe", "Noah", "Ava",
  "Liam", "Emma", "Lucas", "Mia", "Leo", "Zoe", "Owen", "Ruby",
  "Jack", "Ella", "Henry", "Lily", "Sam", "Grace", "Daniel", "Nora",
];
const SERVER_BOT_COLORS = ["#ff4f7b", "#b6ff4a", "#55d6ff", "#9b7bff", "#ffb547", "#38e6b0", "#ff6e52", "#e865ff"];

const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/owner": ["index.html", "text/html; charset=utf-8"],
  "/mobile": ["index.html", "text/html; charset=utf-8"],
  "/mobile/": ["index.html", "text/html; charset=utf-8"],
  "/mobile-owner": ["index.html", "text/html; charset=utf-8"],
  "/mobile-owner/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/game.js": ["game.js", "text/javascript; charset=utf-8"],
  "/physics.js": ["physics.js", "text/javascript; charset=utf-8"],
  "/feeding.js": ["feeding.js", "text/javascript; charset=utf-8"],
  "/THIRD-PARTY-NOTICES.txt": ["THIRD-PARTY-NOTICES.txt", "text/plain; charset=utf-8"],
  "/licenses/MultiOgar-LICENSE.md": ["licenses/MultiOgar-LICENSE.md", "text/plain; charset=utf-8"],
  "/licenses/agar-io-clone-LICENSE.txt": ["licenses/agar-io-clone-LICENSE.txt", "text/plain; charset=utf-8"],
  "/multiplayer.js": ["multiplayer.js", "text/javascript; charset=utf-8"],
  "/transport.js": ["transport.js", "text/javascript; charset=utf-8"],
};

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function number(value, fallback = 0, min = -1e12, max = 1e12) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function cleanText(value, fallback, maxLength = 20) {
  return String(value || fallback).replace(/[<>]/g, "").slice(0, maxLength);
}

function cleanCell(raw, fallbackName = "PLAYER") {
  const mass = number(raw.mass, 1, 0.000001, 1e10);
  const splitLineUntilEpoch = number(raw.splitLineUntilEpoch, 0, 0, 1e15);
  const splitLineUntil = splitLineUntilEpoch || number(raw.splitLineUntil);
  return {
    netId: cleanText(raw.netId, crypto.randomUUID(), 80),
    name: cleanText(raw.name, fallbackName, 20),
    x: number(raw.x),
    y: number(raw.y),
    vx: number(raw.vx),
    vy: number(raw.vy),
    mass,
    radius: Math.sqrt(mass) * 4.2 + 8,
    color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : "#55d6ff",
    accent: cleanText(raw.accent, "#ffffff", 30),
    alive: raw.alive !== false,
    boost: number(raw.boost),
    mergeAt: number(raw.mergeAt),
    launchX: number(raw.launchX),
    launchY: number(raw.launchY),
    botTeam: raw.botTeam ? cleanText(raw.botTeam, "", 40) : null,
    splitCooldown: number(raw.splitCooldown),
    splitLineX: number(raw.splitLineX),
    splitLineY: number(raw.splitLineY),
    splitLineUntil,
    splitLineUntilEpoch: splitLineUntil,
    invulnerableUntil: number(raw.invulnerableUntil),
    virusImmuneUntil: number(raw.virusImmuneUntil),
    targetX: number(raw.targetX),
    targetY: number(raw.targetY),
    think: number(raw.think),
    serverMergeAt: number(raw.serverMergeAt),
  };
}

function cleanCells(value, fallbackName, limit) {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set();
  return value.slice(0, limit).map(rawCell => {
    const cell = cleanCell(rawCell || {}, fallbackName);
    if (usedIds.has(cell.netId)) cell.netId = crypto.randomUUID();
    usedIds.add(cell.netId);
    return cell;
  });
}

function cleanWorld(raw) {
  return {
    worldSize: number(raw.worldSize, 5200, 5200, 1e9),
    bots: cleanCells(raw.bots, "BOT", 220),
    viruses: Array.isArray(raw.viruses) ? raw.viruses.slice(0, 200).map(virus => ({
      x: number(virus.x),
      y: number(virus.y),
      r: number(virus.r, 42, 1, 1000),
      angle: number(virus.angle),
    })) : [],
    ejected: [],
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function createSignInGuard() {
  return { accounts: Object.create(null), devices: Object.create(null), failures: [], registrations: [] };
}

function importSignInGuard(saved) {
  const guard = createSignInGuard();
  if (!saved || typeof saved !== "object") return guard;
  for (const key of ["accounts", "devices"]) Object.assign(guard[key], saved[key] && typeof saved[key] === "object" ? saved[key] : {});
  if (Array.isArray(saved.failures)) guard.failures = saved.failures.filter(Number.isFinite);
  if (Array.isArray(saved.registrations)) guard.registrations = saved.registrations.filter(entry => entry && Number.isFinite(entry.time));
  return guard;
}

function pruneSignInGuard(now) {
  for (const map of [signInGuard.accounts, signInGuard.devices]) {
    for (const [key, entry] of Object.entries(map)) {
      if (now - entry.first > SIGN_IN_WINDOW_MS && now >= (entry.lockedUntil || 0)) delete map[key];
    }
  }
  signInGuard.failures = signInGuard.failures.filter(time => now - time < SERVER_FAILURE_WINDOW_MS);
  signInGuard.registrations = signInGuard.registrations.filter(entry => now - entry.time < 3_600_000);
}

function signInKey(username) {
  return String(username || "").trim().toLowerCase().slice(0, 40);
}

// Milliseconds until this sign-in may be tried again (0 = allowed now).
function signInWait(username, deviceId, now) {
  pruneSignInGuard(now);
  const waits = [signInGuard.accounts[signInKey(username)]?.lockedUntil, signInGuard.devices[deviceId]?.lockedUntil]
    .map(until => (Number(until) || 0) - now);
  if (signInGuard.failures.length >= SERVER_FAILURE_LIMIT) waits.push(signInGuard.failures[0] + SERVER_FAILURE_WINDOW_MS - now);
  return Math.max(0, ...waits);
}

function recordSignInFailure(username, deviceId, now) {
  signInGuard.failures.push(now);
  const lock = (map, key, free, longest) => {
    const entry = map[key] || (map[key] = { first: now, failures: 0, lockedUntil: 0 });
    entry.failures++;
    // After the free tries, each extra wrong password doubles the wait: 1, 2, 4 ... minutes.
    if (entry.failures >= free) entry.lockedUntil = now + Math.min(longest, 60_000 * 2 ** (entry.failures - free));
  };
  lock(signInGuard.accounts, signInKey(username), ACCOUNT_FREE_FAILURES, 60 * 60_000);
  lock(signInGuard.devices, deviceId, DEVICE_FREE_FAILURES, 15 * 60_000);
}

function recordSignInSuccess(username, deviceId) {
  delete signInGuard.accounts[signInKey(username)];
  delete signInGuard.devices[deviceId];
}

function registrationWait(deviceId, now) {
  pruneSignInGuard(now);
  const mine = signInGuard.registrations.filter(entry => entry && entry.device === deviceId);
  if (mine.length >= DEVICE_REGISTRATIONS_PER_HOUR) return mine[0].time + 3_600_000 - now;
  if (signInGuard.registrations.length >= SERVER_REGISTRATIONS_PER_HOUR) return signInGuard.registrations[0].time + 3_600_000 - now;
  return 0;
}

function tryAgainMessage(wait) {
  const minutes = Math.ceil(wait / 60_000);
  return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function createFoodState() {
  return { seed: crypto.randomInt(1, 2 ** 31), versions: new Uint8Array(FOOD_COUNT), revision: 0, log: [] };
}

function exportFoodState() {
  return { seed: foodState.seed, versions: Buffer.from(foodState.versions).toString("base64"), revision: foodState.revision, log: foodState.log };
}

function importFoodState(saved) {
  if (!saved || !Number.isInteger(saved.seed) || typeof saved.versions !== "string") return createFoodState();
  const versions = new Uint8Array(FOOD_COUNT);
  versions.set(Buffer.from(saved.versions, "base64").subarray(0, FOOD_COUNT));
  return { seed: saved.seed, versions, revision: Number(saved.revision) || 0, log: Array.isArray(saved.log) ? saved.log.slice(-FOOD_LOG_LIMIT) : [] };
}

function eatFoodSlot(index) {
  const version = (foodState.versions[index] + 1) & 255;
  foodState.versions[index] = version;
  foodState.revision++;
  foodState.log.push([index, version]);
  if (foodState.log.length > FOOD_LOG_LIMIT) foodState.log.splice(0, foodState.log.length - FOOD_LOG_LIMIT);
}

// What a player needs to bring their copy of the food up to date.
function foodSyncFor(body, rejected) {
  const ack = Number(body.ackFoodRevision);
  const behind = foodState.revision - ack;
  if (body.foodSeed !== foodState.seed || !Number.isInteger(ack) || behind < 0 || behind > foodState.log.length) {
    return { seed: foodState.seed, revision: foodState.revision, full: Buffer.from(foodState.versions).toString("base64") };
  }
  const changes = behind ? foodState.log.slice(foodState.log.length - behind) : [];
  for (const index of rejected) changes.push([index, foodState.versions[index]]);
  return { seed: foodState.seed, revision: foodState.revision, changes };
}

function distanceToPath(x, y, fromX, fromY, toX, toY) {
  const dx = toX - fromX, dy = toY - fromY, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((x - fromX) * dx + (y - fromY) * dy) / length)) : 0;
  return Math.hypot(x - fromX - dx * t, y - fromY - dy * t);
}

// Each claim is [slot, version the player saw, piece id]. A bite counts only if that dot still exists
// and lies on the path a piece actually travelled since the last update. Returns the mass earned.
function claimFood(paths, rawClaims, rejected) {
  if (!Array.isArray(rawClaims) || !paths.length) return 0;
  const size = world ? world.worldSize : 5200;
  const byId = new Map(paths.map(path => [path.id, path]));
  let earned = 0;
  for (const claim of rawClaims.slice(0, MAX_FOOD_CLAIMS)) {
    if (!Array.isArray(claim)) continue;
    const index = Number(claim[0]), version = Number(claim[1]);
    if (!Number.isInteger(index) || index < 0 || index >= FOOD_COUNT || !Number.isInteger(version)) continue;
    if (foodState.versions[index] !== (version & 255)) { rejected.add(index); continue; }
    const dot = BlobPhysics.food.at(foodState.seed, index, version, size);
    const named = byId.get(String(claim[2]));
    const reaches = path => distanceToPath(dot.x, dot.y, path.fromX, path.fromY, path.toX, path.toY) <= path.radius + dot.r + path.margin;
    if (!(named && reaches(named)) && !paths.some(reaches)) { rejected.add(index); continue; }
    eatFoodSlot(index);
    earned += dot.value;
  }
  return earned;
}

function safeMass(value) {
  return Math.max(1, Number.isFinite(Number(value)) ? Number(value) : 1);
}

function radiusForMass(value) {
  return Math.sqrt(safeMass(value)) * 4.2 + 8;
}

function consume(big, small) {
  big.mass += small.mass * 0.72;
  big.radius = Math.sqrt(big.mass) * 4.2 + 8;
  small.alive = false;
}

function ensureSafeOnlineSpawn(session) {
  if (!session.cells.length) return;
  const size = world ? world.worldSize : 5200;
  const totalMass = session.cells.reduce((sum, cell) => sum + cell.mass, 0) || 1;
  const center = {
    x: session.cells.reduce((sum, cell) => sum + cell.x * cell.mass, 0) / totalMass,
    y: session.cells.reduce((sum, cell) => sum + cell.y * cell.mass, 0) / totalMass,
  };
  const groupRadius = Math.max(...session.cells.map(cell => (
    Math.hypot(cell.x - center.x, cell.y - center.y) + cell.radius
  )));
  const avoidCells = [];
  for (const other of sessions.values()) {
    if (other.id === session.id || !other.running) continue;
    avoidCells.push(...other.cells.filter(cell => cell.alive));
  }
  if (world) avoidCells.push(...world.bots.filter(bot => bot.alive));
  const viruses = world ? world.viruses : [];

  function clearanceAt(x, y) {
    let clearance = Infinity;
    for (const cell of avoidCells) {
      clearance = Math.min(clearance, Math.hypot(x - cell.x, y - cell.y) - groupRadius - cell.radius);
    }
    for (const virus of viruses) {
      clearance = Math.min(clearance, Math.hypot(x - virus.x, y - virus.y) - groupRadius - virus.r);
    }
    return clearance;
  }

  if (clearanceAt(center.x, center.y) >= 220) {
    session.spawnProtectedUntil = Date.now() + 2500;
    return;
  }

  const margin = Math.min(size / 2, Math.max(100, groupRadius + 100));
  let best = { x: size / 2, y: size / 2, clearance: -Infinity };
  for (let attempt = 0; attempt < 180; attempt++) {
    const x = margin + Math.random() * Math.max(1, size - margin * 2);
    const y = margin + Math.random() * Math.max(1, size - margin * 2);
    const clearance = clearanceAt(x, y);
    if (clearance > best.clearance) best = { x, y, clearance };
    if (clearance >= 220) break;
  }
  const dx = best.x - center.x;
  const dy = best.y - center.y;
  for (const cell of session.cells) {
    cell.x = Math.max(cell.radius, Math.min(size - cell.radius, cell.x + dx));
    cell.y = Math.max(cell.radius, Math.min(size - cell.radius, cell.y + dy));
  }
  session.revision++;
  session.positionGraceUntil = Date.now() + 1500;
  session.spawnProtectedUntil = Date.now() + 2500;
}

function ownerIsDrivingWorld() {
  const now = Date.now();
  return [...sessions.values()].some(session => (
    session.isAdmin && session.running && now - session.lastSeen < 750
  ));
}

function activePlayerCells() {
  return [...sessions.values()]
    .filter(session => session.running)
    .flatMap(session => session.cells.filter(cell => cell.alive));
}

function botControllers() {
  return [...sessions.values()].filter(session => session.running && session.followedBotTeam && session.cursor && Date.now() - session.lastSeen < 1500)
    .map(session => ({ team: session.followedBotTeam, x: session.cursor.x, y: session.cursor.y }));
}

function playerBanUntil(session) {
  if (session.account?.isAdmin) return 0;
  return moderation.until([`device:${session.deviceId}`, ...(session.account ? [`account:${session.account.username}`] : [])]);
}

function stopBannedPlayer(session) {
  session.running = false;
  session.cells = [];
  session.followedBotTeam = null;
  session.forceMenuVersion++;
}

function simulateBotFeeding() {
  if (!world) return;
  const now = Date.now();
  for (const session of sessions.values()) {
    if (!session.running || !session.botFeeding || !session.followedBotTeam || !session.cursor || now - session.lastSeen > 1500 || now - (session.lastBotFeed || 0) < 60) continue;
    session.lastBotFeed = now;
    for (const bot of world.bots.filter(bot => bot.alive && (bot.botTeam || bot.name) === session.followedBotTeam)) {
      if (bot.mass <= BlobPhysics.minFeedMass || world.ejected.length >= 700) continue;
      bot.mass -= BlobPhysics.feedCost;
      bot.radius = radiusForMass(bot.mass);
      const pellet = BlobPhysics.createFeed(bot, session.cursor.x - bot.x, session.cursor.y - bot.y, session.cursor,world.worldSize);
      world.ejected.push({ ...pellet, netId: crypto.randomUUID(), color: bot.color, ownerCellId: bot.netId, ownerUntil: now + 700, createdAt: now });
      botMassRevision++;
      worldRevision++;
    }
  }
}

function addSharedEjected(session, additions) {
  if (!world || !session.running || !Array.isArray(additions) || !additions.length) return;
  const existingIds = new Set(world.ejected.map(pellet => pellet.netId));
  for (const raw of additions.slice(0, 80)) {
    const netId = cleanText(raw.netId, crypto.randomUUID(), 100);
    if (existingIds.has(netId) || session.feedIds.has(netId)) continue;
    if (world.ejected.length >= 700) break;
    session.feedIds.add(netId);
    let owner = session.cells.find(cell => cell.alive && cell.netId === raw.ownerCellId);
    if (Array.isArray(raw.debits)) {
      const debits = new Map();
      for (const debit of raw.debits.slice(0,256)) {
        if (typeof debit.netId !== "string" || !Number.isFinite(debit.cost) || debit.cost <= 0) continue;
        debits.set(debit.netId,(debits.get(debit.netId)||0)+debit.cost);
      }
      const total = [...debits.values()].reduce((sum,cost)=>sum+cost,0);
      const payers = [...debits].map(([id,cost])=>({cell:session.cells.find(cell=>cell.alive&&cell.netId===id),cost}));
      if (Math.abs(total-BlobPhysics.feedCost)>1e-6 || payers.some(({cell,cost})=>!cell||cell.mass-cost<.0000001)) continue;
      owner = owner || payers[0]?.cell;
      if (!owner) continue;
      for (const {cell,cost} of payers) {cell.mass-=cost;cell.radius=radiusForMass(cell.mass);}
    } else {
      if (!owner || owner.mass <= BlobPhysics.minFeedMass) continue;
      owner.mass -= BlobPhysics.feedCost;
      owner.radius = radiusForMass(owner.mass);
    }
    session.revision++;
    const target = Number.isFinite(raw.targetX) && Number.isFinite(raw.targetY)
      ? { x: number(raw.targetX, owner.x, 0, world.worldSize), y: number(raw.targetY, owner.y, 0, world.worldSize) } : null;
    const source = {...owner};
    if (Number.isFinite(raw.sourceX) && Number.isFinite(raw.sourceY) && Math.hypot(raw.sourceX-owner.x,raw.sourceY-owner.y) < owner.radius*2+150) {
      source.x=raw.sourceX; source.y=raw.sourceY;
      source.mass=number(raw.sourceMass,owner.mass,owner.mass,owner.mass+BlobPhysics.feedCost*80);
    }
    const launch = BlobPhysics.createFeed(source, target ? target.x - source.x : number(raw.dirX, number(raw.vx)), target ? target.y - source.y : number(raw.dirY, number(raw.vy)), target,world.worldSize);
    world.ejected.push({
      ...launch,
      netId,
      startX: launch.x,
      startY: launch.y,
      color: session.color,
      ownerSessionId: session.id,
      ownerCellId: cleanText(raw.ownerCellId, "", 100),
      ownerUntil: Date.now() + 700,
      createdAt: Date.now(),
    });
    existingIds.add(netId);
    session.feedIds.add(netId);
    if (world.ejected.length >= 700) break;
  }
}

function simulateSharedEjected(dt) {
  if (!world || !world.ejected.length) return false;
  if (world.ejected.length > 700) world.ejected.splice(0, world.ejected.length - 700);
  const now = Date.now();
  const ownerDriving = ownerIsDrivingWorld();
  const playerEntries = [];
  for (const session of sessions.values()) {
    if (!session.running) continue;
    for (const cell of session.cells) {
      if (cell.alive) playerEntries.push({ cell, session });
    }
  }
  let changed = false;
  let botChanged = false;
  for (let index = world.ejected.length - 1; index >= 0; index--) {
    const pellet = world.ejected[index];
    if (
      !pellet ||
      !Number.isFinite(pellet.x) ||
      !Number.isFinite(pellet.y) ||
      !Number.isFinite(pellet.vx) ||
      !Number.isFinite(pellet.vy) ||
      !Number.isFinite(pellet.value) ||
      !Number.isFinite(pellet.r) ||
      pellet.r <= 0
    ) {
      world.ejected.splice(index, 1);
      changed = true;
      continue;
    }
    const previousX = pellet.x, previousY = pellet.y;
    BlobPhysics.moveFeed(pellet, dt, world.worldSize);
    changed = true;

    let eaten = false;
    for (const entry of playerEntries) {
      if (entry.session.id === pellet.ownerSessionId && entry.cell.netId === pellet.ownerCellId && now < pellet.ownerUntil) continue;
      if (!BlobPhysics.catchesFeed(entry.cell, pellet, previousX, previousY)) continue;
      entry.cell.mass = safeMass(entry.cell.mass) + Math.max(.1, Math.min(BlobPhysics.feedValue, safeMass(pellet.value)));
      entry.cell.radius = radiusForMass(entry.cell.mass);
      entry.session.revision++;
      eaten = true;
      break;
    }
    if (!eaten) {
      const bot = world.bots.find(candidate => candidate.alive && (candidate.netId !== pellet.ownerCellId || now >= pellet.ownerUntil) && BlobPhysics.catchesFeed(candidate, pellet, previousX, previousY));
      if (bot) {
        bot.mass = safeMass(bot.mass) + Math.max(.1, Math.min(BlobPhysics.feedValue, safeMass(pellet.value)));
        bot.radius = radiusForMass(bot.mass);
        botChanged = true;
        eaten = true;
      }
    }
    if (eaten || now - pellet.createdAt > 7000) world.ejected.splice(index, 1);
  }
  if (changed) worldRevision++;
  if (botChanged) botMassRevision++;
  if (botChanged && !ownerDriving) botRevision++;
  return changed;
}

function splitServerBot(bot, target, burstPieces = 1, commanded = false) {
  const limit = commanded ? Math.max(512,botPieceCap) : botPieceCap;
  if (!world || !bot.alive || bot.mass < (commanded ? .000002 : 44) || world.bots.length >= limit) return;
  const pieces = Math.max(1, Math.min(burstPieces, limit - world.bots.length));
  const pieceMass = bot.mass / (pieces + 1);
  if (target && pieces === 1 && pieceMass < target.mass * 1.18) return;
  bot.mass = pieceMass;
  bot.radius = Math.sqrt(pieceMass) * 4.2 + 8;
  bot.splitCooldown = pieces === 1 ? 1.15 + Math.random() * 1.2 : 3;
  bot.serverMergeAt = Date.now() + 15000;
  const baseAngle = target ? Math.atan2(target.y - bot.y, target.x - bot.x) : Math.random() * Math.PI * 2;
  const targetDistance = target ? distance(bot, target) : 0;
  const targetLaunchSpeed = target ? Math.max(680, Math.min(980, targetDistance * 1.25)) : 480;
  if (target) {
    const dirX = Math.cos(baseAngle);
    const dirY = Math.sin(baseAngle);
    const splitLineUntil = Date.now() + 900;
    bot.vx = dirX * 160;
    bot.vy = dirY * 160;
    bot.launchX = 0;
    bot.launchY = 0;
    bot.targetX = Math.max(0, Math.min(world.worldSize, bot.x + dirX * 1800));
    bot.targetY = Math.max(0, Math.min(world.worldSize, bot.y + dirY * 1800));
    bot.splitLineX = dirX;
    bot.splitLineY = dirY;
    bot.splitLineUntil = splitLineUntil;
    bot.splitLineUntilEpoch = splitLineUntil;
    bot.think = Math.max(bot.think || 0, .42);
  }
  for (let index = 0; index < pieces; index++) {
    const angle = pieces === 1 ? baseAngle : baseAngle + Math.PI * 2 * index / pieces;
    const launchSpeed = target ? targetLaunchSpeed : 480;
    const child = {
      ...bot,
      netId: crypto.randomUUID(),
      x: bot.x + Math.cos(angle) * bot.radius * 1.3,
      y: bot.y + Math.sin(angle) * bot.radius * 1.3,
      vx: target ? bot.vx : bot.vx,
      vy: target ? bot.vy : bot.vy,
      launchX: Math.cos(angle) * launchSpeed,
      launchY: Math.sin(angle) * launchSpeed,
      targetX: target ? bot.targetX : bot.x + Math.cos(angle) * 500,
      targetY: target ? bot.targetY : bot.y + Math.sin(angle) * 500,
      splitLineX: target ? bot.splitLineX : 0,
      splitLineY: target ? bot.splitLineY : 0,
      splitLineUntil: target ? bot.splitLineUntil : 0,
      splitLineUntilEpoch: target ? bot.splitLineUntilEpoch : 0,
      think: target ? bot.think : 0,
      splitCooldown: pieces === 1 ? .95 + Math.random() * .9 : 3,
      serverMergeAt: bot.serverMergeAt,
    };
    world.bots.push(child);
  }
}

function splitTeammate(session) {
  const pieces=world.bots.filter(bot=>bot.alive&&(bot.botTeam||bot.name)===session.followedBotTeam);
  if (pieces.length*2>256 || world.bots.length+pieces.length>Math.max(512,botPieceCap)) return "Bot split limit reached. Wait for the pieces to merge.";
  for (const bot of pieces) splitServerBot(bot,{...session.cursor,mass:0},1,true);
  botRevision++;
  return null;
}

function serverBotShouldSplitFor(bot, prey, preyDistance) {
  if (!prey || bot.splitCooldown > 0) return false;
  const splitMass = bot.mass / 2;
  if (splitMass < Math.max(24, prey.mass * 1.18)) return false;
  const splitRadius = Math.sqrt(splitMass) * 4.2 + 8;
  const reach = splitRadius * 2.2 + 560;
  if (preyDistance > reach || preyDistance < bot.radius * .55) return false;
  const confidence = Math.max(0, Math.min(1, (reach - preyDistance) / reach + (splitMass / Math.max(1, prey.mass) - 1.18) * .55));
  return Math.random() < Math.min(.9, .34 + confidence * .5);
}

function spawnServerBot() {
  if (!world) return;
  const players = activePlayerCells();
  const livingTeams = new Set(world.bots.filter(bot => bot.alive).map(bot => bot.botTeam));
  let name = SERVER_BOT_NAMES[serverBotCounter++ % SERVER_BOT_NAMES.length];
  while (livingTeams.has(name)) name = `${SERVER_BOT_NAMES[serverBotCounter++ % SERVER_BOT_NAMES.length]} ${Math.floor(serverBotCounter / SERVER_BOT_NAMES.length) + 1}`;
  const largestPlayer = Math.max(28, ...players.map(cell => cell.mass));
  const mass = 18 + Math.random() * Math.max(24, largestPlayer * .12);
  const radius = Math.sqrt(mass) * 4.2 + 8;
  let best = { x: world.worldSize / 2, y: world.worldSize / 2, clearance: -Infinity };
  const avoid = [...players, ...world.bots.filter(bot => bot.alive)];
  for (let attempt = 0; attempt < 80; attempt++) {
    const x = radius + 80 + Math.random() * Math.max(1, world.worldSize - (radius + 80) * 2);
    const y = radius + 80 + Math.random() * Math.max(1, world.worldSize - (radius + 80) * 2);
    let clearance = Infinity;
    for (const cell of avoid) clearance = Math.min(clearance, Math.hypot(x - cell.x, y - cell.y) - radius - cell.radius);
    if (clearance > best.clearance) best = { x, y, clearance };
    if (clearance > 220) break;
  }
  world.bots.push({
    netId: crypto.randomUUID(),
    name,
    x: best.x,
    y: best.y,
    vx: 0,
    vy: 0,
    mass,
    radius,
    color: SERVER_BOT_COLORS[Math.floor(Math.random() * SERVER_BOT_COLORS.length)],
    accent: "#ffffff",
    alive: true,
    boost: 0,
    mergeAt: 0,
    launchX: 0,
    launchY: 0,
    botTeam: name,
    splitCooldown: 2 + Math.random() * 4,
    invulnerableUntil: 0,
    virusImmuneUntil: 0,
    targetX: Math.random() * world.worldSize,
    targetY: Math.random() * world.worldSize,
    think: 0,
    serverMergeAt: 0,
  });
}

function resolveServerBotCollisions() {
  if (!world) return;
  const now = Date.now();
  for (let i = 0; i < world.bots.length; i++) {
    const a = world.bots[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < world.bots.length; j++) {
      const b = world.bots[j];
      if (!b.alive) continue;
      const separation = distance(a, b);
      if (a.botTeam === b.botTeam) {
        if (now >= a.serverMergeAt && now >= b.serverMergeAt && separation < a.radius + b.radius * .65) {
          const big = a.mass >= b.mass ? a : b;
          const small = big === a ? b : a;
          big.mass += small.mass;
          big.radius = Math.sqrt(big.mass) * 4.2 + 8;
          big.serverMergeAt = 0;
          small.alive = false;
        }
        if (a.alive && b.alive && (now<a.serverMergeAt || now<b.serverMergeAt) && separation<a.radius+b.radius) {
          const dx=separation ? (b.x-a.x)/separation : 1;
          const dy=separation ? (b.y-a.y)/separation : 0;
          const push=Math.min(30,(a.radius+b.radius-separation)*.2);
          a.x-=dx*push;a.y-=dy*push;b.x+=dx*push;b.y+=dy*push;
        }
        continue;
      }
      const big = a.mass >= b.mass ? a : b;
      const small = big === a ? b : a;
      if (big.mass > small.mass * 1.18 && separation < big.radius - small.radius * .28) consume(big, small);
    }
  }
  world.bots = world.bots.filter(bot => bot.alive);
}

function simulateServerBots(dt) {
  if (!world) return false;
  if (process.env.NODE_ENV === "test" && process.env.SPLITFLUX_TEST_WORLD === "1" && ownerIsDrivingWorld()) return false;
  if (!serverFallbackActive) {
    const now = Date.now();
    const teamCounts = new Map();
    for (const bot of world.bots) teamCounts.set(bot.botTeam, (teamCounts.get(bot.botTeam) || 0) + 1);
    for (const bot of world.bots) {
      if (teamCounts.get(bot.botTeam) > 1 && !bot.serverMergeAt) bot.serverMergeAt = now + 15000;
    }
    serverFallbackActive = true;
  }
  const size = world.worldSize;
  const players = activePlayerCells();
  const allTargets = [...players, ...world.bots];
  const largestPlayer = Math.max(28, ...players.map(cell => cell.mass));
  const controllers = new Map(botControllers().map(entry => [entry.team, entry]));

  for (const bot of world.bots) {
    if (!bot.alive) continue;
    bot.splitCooldown = Math.max(0, bot.splitCooldown - dt);
    const controller = controllers.get(bot.botTeam || bot.name);
    const splitLineActive = !controller && Date.now() < (bot.splitLineUntil || 0);
    if (controller) {
      bot.splitLineUntil = 0;
      bot.targetX = controller.x;
      bot.targetY = controller.y;
    } else if (splitLineActive) {
      bot.targetX = Math.max(0, Math.min(size, bot.x + (Number(bot.splitLineX) || 0) * 1800));
      bot.targetY = Math.max(0, Math.min(size, bot.y + (Number(bot.splitLineY) || 0) * 1800));
    } else {
      bot.think -= dt;
    }
    if (bot.mass < largestPlayer * .42) {
      bot.mass += Math.min(largestPlayer * .42 - bot.mass, Math.max(.5, largestPlayer * .005) * dt);
      bot.radius = Math.sqrt(bot.mass) * 4.2 + 8;
    }
    if (!controller && !splitLineActive && bot.think <= 0) {
      bot.think = .18 + Math.random() * .3;
      let threat = null;
      let prey = null;
      let threatDistance = Infinity;
      let preyDistance = Infinity;
      for (const other of allTargets) {
        if (!other.alive || other === bot || (other.botTeam && other.botTeam === bot.botTeam)) continue;
        const separation = distance(bot, other);
        if (other.mass > bot.mass * 1.2 && separation < threatDistance && separation < 760) {
          threat = other;
          threatDistance = separation;
        }
        const splitMass = bot.mass / 2;
        if ((bot.mass > other.mass * 1.25 || splitMass > other.mass * 1.18) && separation < preyDistance && separation < 820) {
          prey = other;
          preyDistance = separation;
        }
      }
      let nearbyVirus = null;
      let virusDistance = Infinity;
      if (bot.mass > 90) {
        for (const virus of world.viruses) {
          const separation = distance(bot, virus);
          if (separation < virusDistance) {
            nearbyVirus = virus;
            virusDistance = separation;
          }
        }
      }
      if (nearbyVirus && virusDistance < bot.radius + 140) {
        bot.targetX = bot.x + (bot.x - nearbyVirus.x) * 3;
        bot.targetY = bot.y + (bot.y - nearbyVirus.y) * 3;
      } else if (threat) {
        bot.targetX = bot.x + (bot.x - threat.x) * 2;
        bot.targetY = bot.y + (bot.y - threat.y) * 2;
      } else if (prey) {
        bot.targetX = prey.x;
        bot.targetY = prey.y;
        if (serverBotShouldSplitFor(bot, prey, preyDistance)) {
          splitServerBot(bot, prey);
        }
      } else if (Math.hypot(bot.targetX - bot.x, bot.targetY - bot.y) < 100 || Math.random() < .08) {
        bot.targetX = Math.random() * size;
        bot.targetY = Math.random() * size;
      }
    }

    const dx = bot.targetX - bot.x;
    const dy = bot.targetY - bot.y;
    const length = Math.hypot(dx, dy) || 1;
    const speed = controller && length < 8 ? 0 : 235 / Math.pow(bot.mass / 25, .18);
    const ease = Math.min(1, dt * 5.5);
    if (splitLineActive) {
      bot.vx = dx / length * speed;
      bot.vy = dy / length * speed;
    } else {
      bot.vx += (dx / length * speed - bot.vx) * ease;
      bot.vy += (dy / length * speed - bot.vy) * ease;
    }
    bot.x = Math.max(bot.radius, Math.min(size - bot.radius, bot.x + bot.vx * dt));
    bot.y = Math.max(bot.radius, Math.min(size - bot.radius, bot.y + bot.vy * dt));
    BlobPhysics.moveBoost(bot, dt, size, "launchX", "launchY", bot.radius);
  }

  for (let index = world.viruses.length - 1; index >= 0; index--) {
    const virus = world.viruses[index];
    const bot = world.bots.find(candidate => (
      candidate.alive && candidate.mass > 90 && distance(candidate, virus) < candidate.radius + virus.r * .65
    ));
    if (!bot) continue;
    splitServerBot(bot, null, Math.min(6, botPieceCap - world.bots.length));
    world.viruses.splice(index, 1);
  }

  resolveServerBotCollisions();
  resolveCollisions();
  const livingTeams = new Set(world.bots.filter(bot => bot.alive).map(bot => bot.botTeam));
  if (Date.now() >= botRespawnBlockedUntil && livingTeams.size < targetBotTeams && world.bots.length < botPieceCap) spawnServerBot();
  worldRevision++;
  botRevision++;
  return true;
}

function acceptClientCells(session, rawCells, ackRevision) {
  const incoming=cleanCells(rawCells,session.name,256);
  // A client can only acknowledge a revision this server actually sent it.
  // Claiming a newer one used to make the server forget that the player was eaten.
  if (ackRevision>(Number(session.lastReplyRevision)||0)) ackRevision=-1;
  if (ackRevision>=session.revision) return incoming;
  if (session.lastReplyCells && ackRevision>=session.lastReplyRevision) {
    const current=new Map(session.cells.map(cell=>[cell.netId,cell]));
    const raw=new Map((Array.isArray(rawCells)?rawCells:[]).map(cell=>[cell.netId,cell]));
    // Intake since the acknowledged reply must not discard newer movement or splits.
    for (const previous of session.lastReplyCells) {
      const serverCell=current.get(previous.netId);
      const delta=(serverCell?.alive?serverCell.mass:0)-previous.mass;
      if (!delta) continue;
      const weights=incoming.map(cell=>number(raw.get(cell.netId)?.massOrigins?.[previous.netId],cell.netId===previous.netId?1:0,0,1));
      const total=weights.reduce((sum,weight)=>sum+weight,0);
      for (let i=0;i<incoming.length;i++) {
        incoming[i].mass+=delta*weights[i]/Math.max(1,total);
      }
    }
    for(const cell of incoming) {
      cell.alive=cell.alive&&cell.mass>.000001;
      cell.mass=Math.max(.000001,cell.mass);cell.radius=radiusForMass(cell.mass);
    }
    return incoming;
  }
  // A lost reply needs a fresh acknowledgement, but movement can still advance safely.
  const positions=new Map(incoming.map(cell=>[cell.netId,cell]));
  return session.cells.map(cell=>{
    const pose=positions.get(cell.netId);
    return pose?{...cell,x:pose.x,y:pose.y,vx:pose.vx,vy:pose.vy}:cell;
  });
}

function cellRadius(mass) {
  return Math.sqrt(Math.max(.000001, mass)) * 4.2 + 8;
}

function playerSpeedFor(mass) {
  return PLAYER_BASE_SPEED / Math.pow(Math.max(.000001, mass) / 25, .18);
}

// Pieces that grow or get pushed apart can poke slightly past the wall for a frame before the
// game clamps them, so small overshoots are fixed quietly; only real escapes count as a correction.
function keepInsideWorld(cell, size) {
  const x = cell.x, y = cell.y;
  if (cell.radius * 2 >= size) { cell.x = size / 2; cell.y = size / 2; }
  else {
    cell.x = Math.max(cell.radius, Math.min(size - cell.radius, cell.x));
    cell.y = Math.max(cell.radius, Math.min(size - cell.radius, cell.y));
  }
  return Math.hypot(cell.x - x, cell.y - y) > 40 + cell.radius * .5;
}

// Checks a guest/player update against what the game rules allow:
// - a new round starts at the normal starting size,
// - pieces stay inside the map and cannot move faster than their speed (plus split boosts),
// - new pieces must come from a living piece (an eaten piece cannot come back),
// - total mass can only grow by the shared food the server confirms each piece reached,
// - at most MAX_PLAYER_CELLS pieces.
// Any correction bumps the session revision so the player's game snaps to the server's version.
function validateClientCells(session, previousCells, cells, rawCells, spawning, now, rawClaims = [], rejectedFood = new Set()) {
  const size = world ? world.worldSize : 5200;
  let corrected = false;
  const alive = cells.filter(cell => cell && cell.alive && Number.isFinite(cell.mass) && cell.mass > 0);
  const elapsed = Math.min(2, Math.max(0, (now - (Number(session.lastValidatedAt) || now)) / 1000));
  session.lastValidatedAt = now;

  if (spawning) {
    const group = alive.slice(0, MAX_PLAYER_CELLS);
    if (!group.length) return [];
    const total = group.reduce((sum, cell) => sum + cell.mass, 0);
    const scale = total > SPAWN_MASS_LIMIT ? SPAWN_MASS_LIMIT / total : 1;
    if (scale !== 1 || group.length !== alive.length) corrected = true;
    const anchor = group[0];
    for (const cell of group) {
      cell.mass *= scale;
      cell.radius = cellRadius(cell.mass);
      if (cell !== anchor && Math.hypot(cell.x - anchor.x, cell.y - anchor.y) > 400) {
        cell.x = anchor.x; cell.y = anchor.y; corrected = true;
      }
      if (keepInsideWorld(cell, size)) corrected = true;
      cell._travelCredit = 0;
      cell._boostCredit = 0;
    }
    // Bites taken before this first update are removed from the map; the size cap above already
    // covers the mass they were worth.
    claimFood(group.map(cell => ({ id: cell.netId, fromX: cell.x, fromY: cell.y, toX: cell.x, toY: cell.y, radius: cell.radius, margin: 60 })), rawClaims, rejectedFood);
    if (corrected) session.revision++;
    return group;
  }

  const previous = new Map();
  for (const cell of previousCells || []) if (cell && cell.alive) previous.set(cell.netId, cell);
  if (!previous.size) {
    // Every piece was eaten (or never existed); nothing the client sends can bring it back.
    if (alive.length) session.revision++;
    return [];
  }
  const origins = new Map();
  for (const raw of Array.isArray(rawCells) ? rawCells : []) {
    if (raw && typeof raw === "object" && raw.massOrigins && typeof raw.massOrigins === "object") {
      origins.set(cleanText(raw.netId, "", 80), raw.massOrigins);
    }
  }

  const entries = [];
  const splitParents = new Set();
  for (const cell of alive) {
    let ref = previous.get(cell.netId), isNew = false;
    if (!ref) {
      isNew = true;
      let living = 0, lost = 0, best = null, bestWeight = 0;
      for (const [id, value] of Object.entries(origins.get(cell.netId) || {})) {
        const weight = Number(value);
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const parent = previous.get(id);
        if (parent) {
          living += weight;
          if (weight > bestWeight) { best = parent; bestWeight = weight; }
        } else lost += weight;
      }
      // Made-up pieces, and pieces mostly made of an eaten piece, are rejected.
      if (!best || lost > living) { corrected = true; continue; }
      ref = best;
      splitParents.add(best.netId);
    }
    entries.push({ cell, ref, isNew });
  }

  if (entries.length > MAX_PLAYER_CELLS) {
    // Keep existing pieces first, then the biggest new ones. Extra mass goes back to the
    // largest kept piece so an old client that over-splits does not lose size.
    entries.sort((a, b) => (a.isNew - b.isNew) || (b.cell.mass - a.cell.mass));
    const dropped = entries.splice(MAX_PLAYER_CELLS);
    const extra = dropped.reduce((sum, entry) => sum + entry.cell.mass, 0);
    const largest = entries.reduce((best, entry) => entry.cell.mass > best.cell.mass ? entry : best, entries[0]);
    largest.cell.mass += extra;
    corrected = true;
  }

  const grace = now < (Number(session.positionGraceUntil) || 0);
  const severalPieces = entries.length > 1 || previous.size > 1;
  for (const entry of entries) {
    const { cell, ref, isNew } = entry;
    // How big this piece really is as far as the server knows: its share of the pieces it came from.
    let trusted = 0;
    for (const [id, value] of Object.entries(origins.get(cell.netId) || {})) {
      const weight = Number(value), origin = previous.get(id);
      if (origin && Number.isFinite(weight) && weight > 0) trusted += origin.mass * Math.min(1, weight);
    }
    if (!(trusted > 0)) trusted = isNew ? ref.mass / 2 : ref.mass;
    // Speed and reach use the trusted size: claiming to be tiny does not make a piece faster,
    // and claiming to be huge does not let it reach far-away food.
    const speed = playerSpeedFor(Math.max(MIN_SPEED_MASS, Math.min(cell.mass, trusted), trusted * .25));
    const reachRadius = cellRadius(Math.min(cell.mass, trusted * 1.2 + 30));
    cell.radius = reachRadius;
    // Movement allowance builds up over real time, so sending updates faster gains nothing.
    // Extra allowance for pieces pulling together / pushing apart only applies with several pieces.
    let travelCredit = Math.min((Number(ref._travelCredit) || 0) + (speed * 1.3 + (severalPieces ? 320 : 0)) * elapsed, speed * 1.2 + 150);
    let boostCredit = (Number(ref._boostCredit) || 0) * Math.exp(-elapsed / 1.2);
    const parentRadius = Number(ref.radius) || cellRadius(ref.mass);
    if (isNew) boostCredit += 400 * Math.max(1, parentRadius / 70) + parentRadius * 2 + 120;
    else if (splitParents.has(cell.netId)) boostCredit += parentRadius * 2 + 120;
    const dx = cell.x - ref.x, dy = cell.y - ref.y;
    const distance = Math.hypot(dx, dy);
    let moved = Number.isFinite(distance) ? distance : 0;
    if (grace) {
      travelCredit = 0;
      boostCredit = 0;
    } else {
      const allowed = travelCredit + boostCredit;
      if (moved > allowed + 1) {
        const keep = allowed / moved;
        cell.x = ref.x + dx * keep;
        cell.y = ref.y + dy * keep;
        moved = allowed;
        corrected = true;
      }
      const fromTravel = Math.min(moved, travelCredit);
      travelCredit -= fromTravel;
      boostCredit = Math.max(0, boostCredit - (moved - fromTravel));
    }
    if (keepInsideWorld(cell, size)) corrected = true;
    cell._travelCredit = travelCredit;
    cell._boostCredit = boostCredit;
    // The stretch of map this piece covered since the last update. Pieces of one player jostle
    // sideways as they push apart and pull together, hence the wider margin when there are several.
    // While the server itself is moving the player (spawn spot, map resize) the route is unknown,
    // so use a circle instead.
    const radius = reachRadius;
    entry.paths = grace
      ? [{ id: cell.netId, fromX: cell.x, fromY: cell.y, toX: cell.x, toY: cell.y, radius, margin: 60 + speed * elapsed }]
      : [{ id: cell.netId, fromX: ref.x, fromY: ref.y, toX: cell.x, toY: cell.y, radius, margin: 14 + radius * (severalPieces ? .35 : .1) }];
    // Pieces that merged into this one ate food on their own way in.
    for (const id of Object.keys(origins.get(cell.netId) || {})) {
      const merged = previous.get(id);
      if (merged && merged !== ref) entry.paths.push({ id, fromX: merged.x, fromY: merged.y, toX: cell.x, toY: cell.y,
        radius: reachRadius, margin: 14 + reachRadius * .35 });
    }
  }

  // Mass is exactly what the server already knew plus the food it just confirmed.
  // (Being eaten, eating others and feeding are applied by the server itself.)
  const earned = claimFood(entries.flatMap(entry => entry.paths), rawClaims, rejectedFood);
  const kept = entries.map(entry => entry.cell);
  const previousTotal = [...previous.values()].reduce((sum, cell) => sum + cell.mass, 0);
  const total = kept.reduce((sum, cell) => sum + cell.mass, 0);
  const expected = previousTotal + earned;
  const tolerance = .05 + expected * 1e-6;
  if (total > 0 && Math.abs(total - expected) > tolerance) {
    const scale = expected / total;
    for (const cell of kept) cell.mass *= scale;
    // Reporting less than the server knows only happens after a lost reply; no snap needed then.
    if (total > expected) corrected = true;
  }
  for (const cell of kept) cell.radius = cellRadius(cell.mass);
  if (corrected) session.revision++;
  return kept;
}

// The owner's own size is trusted, but bites still have to be near one of their pieces.
function claimFoodForOwner(previousCells, cells, rawClaims, rejectedFood) {
  const previous = new Map((previousCells || []).map(cell => [cell.netId, cell]));
  const paths = cells.filter(cell => cell.alive).map(cell => {
    const from = previous.get(cell.netId) || cell;
    return { id: cell.netId, fromX: from.x, fromY: from.y, toX: cell.x, toY: cell.y, radius: cell.radius, margin: 120 };
  });
  claimFood(paths, rawClaims, rejectedFood);
}

function collisionDistance(a,b,now) {
  const ax=a._moveUntil>now?a._moveFromX:a.x, ay=a._moveUntil>now?a._moveFromY:a.y;
  const bx=b._moveUntil>now?b._moveFromX:b.x, by=b._moveUntil>now?b._moveFromY:b.y;
  const x=ax-bx,y=ay-by,dx=(a.x-b.x)-x,dy=(a.y-b.y)-y;
  const length=dx*dx+dy*dy;
  const t=length?Math.max(0,Math.min(1,-(x*dx+y*dy)/length)):0;
  return Math.hypot(x+dx*t,y+dy*t);
}

function resolveCollisions() {
  const active = [...sessions.values()].filter(session => session.running);
  const now = Date.now();
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (active[i].spawnProtectedUntil > now || active[j].spawnProtectedUntil > now) continue;
      for (const a of active[i].cells) for (const b of active[j].cells) {
        if (!a.alive || !b.alive) continue;
        const big = a.mass >= b.mass ? a : b;
        const small = big === a ? b : a;
        if (big.mass > small.mass * 1.18 && collisionDistance(big, small,now) < big.radius - small.radius * 0.28) {
          consume(big, small);
          active[i].revision++;
          active[j].revision++;
        }
      }
    }
  }

  if (!world) return;
  for (const session of active) {
    if (session.spawnProtectedUntil > now) continue;
    for (const cell of session.cells) {
      if (!cell.alive) continue;
      for (const bot of world.bots) {
        if (!bot.alive || !cell.alive) continue;
        const big = cell.mass >= bot.mass ? cell : bot;
        const small = big === cell ? bot : cell;
        if (small === cell && session.immune) continue;
        if (small === cell && session.teamedBots.has(bot.botTeam || bot.name) && session.cells.filter(candidate => candidate.alive).length <= 1) continue;
        if (big.mass > small.mass * 1.18 && collisionDistance(big, small,now) < big.radius - small.radius * 0.28) {
          consume(big, small);
          session.revision++;
          worldRevision++;
          botRevision++;
        }
      }
    }
  }
  world.bots = world.bots.filter(bot => bot.alive);
}

function sessionView(session) {
  const aliveCells = session.cells.filter(cell => cell.alive);
  return {
    id: session.id,
    name: session.name,
    skinVersion: session.skinVersion || 0,
    color: session.color,
    running: session.running,
    cells: aliveCells,
    dead: session.running && aliveCells.length === 0,
    revision: session.revision,
    forceMenuVersion: session.forceMenuVersion,
  };
}

function readBody(request) {
  if (request.body !== undefined) {
    const body=typeof request.body==="string" || Buffer.isBuffer(request.body) ? JSON.parse(String(request.body)||"{}") : request.body;
    if (Buffer.byteLength(JSON.stringify(body))>2_000_000) return Promise.reject(new Error("Request too large"));
    return Promise.resolve(body);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error("Request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function cleanupSessions() {
  const cutoff = Date.now() - 15_000;
  for (const [id, session] of sessions) {
    if (session.lastSeen >= cutoff) continue;
    sessions.delete(id);
    if (id === ownerId) ownerId = null;
  }
}

const handleRequest = async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    cleanupSessions();
    const account = accounts.fromRequest(request);
    const deviceId = moderation.device(request, response);
    const bannedUntil = account?.isAdmin ? 0 : moderation.until([`device:${deviceId}`, ...(account ? [`account:${account.username}`] : [])]);
    if (bannedUntil) { sendJson(response, 403, { error: "You are banned from this arena.", bannedUntil }); return; }
    const id = crypto.randomUUID();
    const sessionKey = crypto.randomBytes(20).toString("hex");
    const isAdmin = Boolean(account && account.isAdmin);
    if (isAdmin) {
      ownerId = id;
    }
    sessions.set(id, {
      id,
      sessionKey,
      isAdmin,
      account,
      deviceId,
      botActionIds: new Set(),
      feedIds: new Set(),
      teamedBots: new Set(),
      teamRevision: 0,
      followedBotTeam: null,
      cursor: null,
      running: false,
      name: "PLAYER",
      color: "#55d6ff",
      score: 0,
      immune: false,
      cells: [],
      skin: "",
      skinVersion: 0,
      revision: 0,
      forceMenuVersion: 0,
      spawnProtectedUntil: 0,
      lastSeen: Date.now(),
    });
    if (account) accounts.remember(response, account.username);
    sendJson(response, 200, { id, sessionKey, isAdmin, account });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/skins/")) {
    const target=sessions.get(url.pathname.slice("/api/skins/".length));
    const match=target?.skin?.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {sendJson(response,404,{error:"Skin not found"});return;}
    response.writeHead(200,{"Content-Type":match[1],"Cache-Control":"private, max-age=60","X-Content-Type-Options":"nosniff"});
    response.end(Buffer.from(match[2],"base64"));
    return;
  }

  if(request.method==="POST"&&url.pathname==="/api/realtime-ticket") {
    try {
      const body=await readBody(request),session=sessions.get(String(body.id||""));
      if(!session||session.sessionKey!==body.sessionKey){sendJson(response,401,{error:"Session expired"});return;}
      sendJson(response,200,realtime?realtime.issue(request,session):{available:false});
    }catch{sendJson(response,400,{error:"Unable to connect"});}
    return;
  }

  if (request.method === "POST" && ["/api/accounts/login", "/api/accounts/register", "/api/accounts/logout"].includes(url.pathname)) {
    try {
      const body = await readBody(request);
      const session = sessions.get(String(body.id || ""));
      if (!session || session.sessionKey !== body.sessionKey) {
        sendJson(response, 401, { error: "Refresh the game before signing in." });
        return;
      }
      const registering = url.pathname.endsWith("/register");
      let account = null;
      if (!url.pathname.endsWith("/logout")) {
        const now = Date.now();
        const wait = registering ? registrationWait(session.deviceId, now) : signInWait(body.username, session.deviceId, now);
        if (wait > 0) {
          sendJson(response, 429, { error: tryAgainMessage(wait), retryAfter: Math.ceil(wait / 1000) });
          return;
        }
        // New accounts need 8+ characters; older accounts with shorter passwords can still sign in.
        if (registering && String(body.password || "").length < 8) throw new Error("Use a password with at least 8 characters.");
        try {
          account = await accounts.authenticate(body.username, body.password, registering);
        } catch (error) {
          if (!registering && error.message === "Incorrect username or password.") recordSignInFailure(body.username, session.deviceId, Date.now());
          throw error;
        }
        if (registering) signInGuard.registrations.push({ time: Date.now(), device: session.deviceId });
        else recordSignInSuccess(body.username, session.deviceId);
      }
      if (account && !account.isAdmin && moderation.until([`account:${account.username}`, `device:${session.deviceId}`])) throw new Error("This account or browser is currently banned.");
      session.account = account;
      session.isAdmin = Boolean(account && account.isAdmin);
      realtime?.invalidateDevice(session.deviceId);
      if (!session.isAdmin) session.immune = false;
      session.lastSeen = Date.now();
      if (account) accounts.remember(response, account.username);
      else accounts.forget(response);
      sendJson(response, 200, { isAdmin: session.isAdmin, account });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/follow-bot") {
    try {
      const body = await readBody(request);
      const session = sessions.get(String(body.id || ""));
      if (!session || session.sessionKey !== body.sessionKey) { sendJson(response, 401, { error: "Session expired" }); return; }
      const team = body.team == null ? null : String(body.team);
      if (team && (!world || !world.bots.some(bot => bot.alive && (bot.botTeam || bot.name) === team))) { sendJson(response, 404, { error: "Bot is gone" }); return; }
      if (team && [...sessions.values()].some(other => other !== session && other.running && other.followedBotTeam === team && Date.now() - other.lastSeen < 1500)) {
        sendJson(response, 409, { error: "Another player is already controlling this bot." }); return;
      }
      session.followedBotTeam = team;
      sendJson(response, 200, { followedBotTeam: team });
    } catch { sendJson(response, 400, { error: "Invalid follow request" }); }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/team") {
    try {
      const body = await readBody(request);
      const session = sessions.get(String(body.id || ""));
      if (!session || session.sessionKey !== body.sessionKey) { sendJson(response, 401, { error: "Session expired" }); return; }
      const team = String(body.team || "");
      if (!world || !world.bots.some(bot => bot.alive && (bot.botTeam || bot.name) === team)) { sendJson(response, 404, { error: "Bot is gone" }); return; }
      if (body.enabled) {
        if ([...sessions.values()].some(other => other !== session && other.running && other.followedBotTeam === team && Date.now() - other.lastSeen < 1500)) { sendJson(response, 409, {error:"Another player is already teaming with this bot."}); return; }
        session.teamedBots.clear();
        session.teamedBots.add(team);
        session.followedBotTeam = team;
      } else {
        session.teamedBots.delete(team);
        if (session.followedBotTeam === team) session.followedBotTeam = null;
      }
      session.teamRevision++;
      sendJson(response, 200, { teamedBots: [...session.teamedBots], followedBotTeam: session.followedBotTeam, teamRevision:session.teamRevision });
    } catch { sendJson(response, 400, { error: "Invalid team request" }); }
    return;
  }

  if (request.method === "POST" && ["/api/admin/ban", "/api/admin/paint-spikes", "/api/admin/arena"].includes(url.pathname)) {
    try {
      const body = await readBody(request);
      const admin = sessions.get(String(body.id || ""));
      const account = accounts.fromRequest(request);
      if (!admin || admin.sessionKey !== body.sessionKey || !account?.isAdmin) { sendJson(response, 403, { error: "Admin access required" }); return; }
      if (url.pathname.endsWith("/arena")) {
        if (!world) { sendJson(response, 409, {error:"Start a round first."}); return; }
        if (body.mapScale === 2 || body.mapScale === .5) {
          const nextSize = number(world.worldSize * body.mapScale, world.worldSize, 5200, 1e9);
          const scale = nextSize / world.worldSize;
          for (const item of [...world.bots, ...world.viruses, ...world.ejected, ...activePlayerCells()]) {
            item.x *= scale; item.y *= scale;
            if (Number.isFinite(item.targetX)) item.targetX *= scale;
            if (Number.isFinite(item.targetY)) item.targetY *= scale;
          }
          world.worldSize = nextSize;
          for (const player of sessions.values()) {player.revision++;player.positionGraceUntil=Date.now()+1500;}
        }
        if ([24,48,96,192].includes(body.botCount)) {
          targetBotTeams = body.botCount;
          botPieceCap = Math.max(96, targetBotTeams * 2);
          const teams = [...new Set(world.bots.map(bot=>bot.botTeam||bot.name))];
          const keep = new Set(teams.slice(0,targetBotTeams));
          world.bots = world.bots.filter(bot=>keep.has(bot.botTeam||bot.name)).slice(0,botPieceCap);
        }
        if (body.clearSpikes) world.viruses = [];
        worldRevision++; botRevision++;
        sendJson(response,200,{world, self:sessionView(admin), botRevision});
      } else if (url.pathname.endsWith("/ban")) {
        const target = sessions.get(String(body.targetId || ""));
        const team = typeof body.botTeam === "string" ? body.botTeam : null;
        if (target) {
          if (target.id === admin.id || target.account?.isAdmin || target.deviceId===admin.deviceId) { sendJson(response, 403, { error:"The owner cannot be banned." }); return; }
          const identities = [`device:${target.deviceId}`, ...(target.account ? [`account:${target.account.username}`] : [])];
          const until = moderation.ban(identities, body.durationMs);
          for (const session of sessions.values()) if (playerBanUntil(session)) stopBannedPlayer(session);
          sendJson(response, 200, { bannedUntil: until });
        } else if (team && world?.bots.some(bot => (bot.botTeam || bot.name) === team)) {
          const until = moderation.ban([`bot:${team}`], body.durationMs);
          world.bots = world.bots.filter(bot => (bot.botTeam || bot.name) !== team);
          botRevision++;
          sendJson(response, 200, { bannedUntil: until });
        } else sendJson(response, 404, { error:"Player is no longer in the arena." });
      } else {
        if (!world) { sendJson(response, 409, {error:"Start a round first."}); return; }
        let added = 0;
        for (const point of (Array.isArray(body.points) ? body.points : []).slice(0, 40)) {
          const x = number(point.x, 42, 42, world.worldSize - 42), y = number(point.y, 42, 42, world.worldSize - 42);
          if (world.viruses.length >= 200 || world.viruses.some(virus => Math.hypot(virus.x-x,virus.y-y) < 84)) continue;
          world.viruses.push({x,y,r:42,angle:Math.random()*Math.PI*2}); added++;
        }
        worldRevision++; botRevision++;
        sendJson(response, 200, {added,viruses:world.viruses});
      }
    } catch (error) { sendJson(response, 400, {error:error.message}); }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/kill-all") {
    try {
      cleanupSessions();
      const body = await readBody(request);
      const owner = sessions.get(String(body.id || ""));
      const account = accounts.fromRequest(request);
      if (!owner || owner.sessionKey !== body.sessionKey || !account || !account.isAdmin) {
        sendJson(response, 403, { error: "Owner access required" });
        return;
      }
      let killed = 0;
      for (const session of sessions.values()) {
        if (session.id === owner.id) continue;
        if (session.running || session.cells.some(cell => cell.alive)) killed++;
        session.cells = [];
        session.running = false;
        session.revision++;
        session.forceMenuVersion++;
      }
      const botsKilled = world ? world.bots.filter(bot => bot.alive).length : 0;
      if (world) {
        world.bots = [];
        worldRevision++;
        botRevision++;
      }
      botRespawnBlockedUntil = Date.now() + 5000;
      sendJson(response, 200, { killed, botsKilled });
    } catch {
      sendJson(response, 400, { error: "Invalid admin command" });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/state") {
    try {
      cleanupSessions();
      const body = await readBody(request);
      const session = sessions.get(String(body.id || ""));
      if (!session || session.sessionKey !== body.sessionKey) {
        sendJson(response, 401, { error: "Session expired" });
        return;
      }
      const previousSeen = session.lastSeen;
      const rejectedFood = new Set();
      session.lastSeen = Date.now();
      session.account = accounts.fromRequest(request);
      session.isAdmin = Boolean(session.account && session.account.isAdmin);
      const bannedUntil = playerBanUntil(session);
      if (bannedUntil) { stopBannedPlayer(session); sendJson(response, 403, {error:"You are banned from this arena.",bannedUntil}); return; }
      const wasRunning = session.running;
      session.running = Boolean(body.running);
      if (body.cursor && world) session.cursor = { x: number(body.cursor.x, 0, 0, world.worldSize), y: number(body.cursor.y, 0, 0, world.worldSize) };
      session.botFeeding = Boolean(body.botFeeding);
      if (typeof body.skin==="string" && body.skin.length<=60000 && (body.skin==="" || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(body.skin)) && body.skin!==session.skin) {
        session.skin=body.skin; session.skinVersion=(session.skinVersion||0)+1;
      }
      let botSplitError=null;
      for (const id of (Array.isArray(body.botSplitCommands) ? body.botSplitCommands : []).slice(0, 8)) {
        if (typeof id !== "string" || id.length > 100 || session.botActionIds.has(id)) continue;
        session.botActionIds.add(id);
        if (!session.running || !session.followedBotTeam || !session.cursor || !world) continue;
        botSplitError=splitTeammate(session)||botSplitError;
      }
      session.name = cleanText(body.name, "PLAYER", 14);
      session.color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : "#55d6ff";
      session.score = number(body.score, 0, 0, 1e15);
      session.immune = session.isAdmin && Boolean(body.immune);
      {
        const previousCells = session.cells;
        const previous = new Map(previousCells.map(cell=>[cell.netId,cell]));
        const proposed = acceptClientCells(session,body.cells,number(body.ackRevision,0,0));
        // The owner keeps admin powers (size multipliers, speed, instant remerge); everyone else is checked.
        if (!session.running) session.cells = proposed;
        else if (session.isAdmin || trustClientForTests) {
          session.cells = proposed;
          claimFoodForOwner(previousCells, proposed, body.foodClaims, rejectedFood);
        } else session.cells = validateClientCells(session, previousCells, proposed, body.cells, !wasRunning, session.lastSeen, body.foodClaims, rejectedFood);
        if (wasRunning && session.lastSeen-previousSeen<400) for (const cell of session.cells) {
          const old=previous.get(cell.netId);
          if (!old || Math.hypot(cell.x-old.x,cell.y-old.y)>Math.max(1600,old.radius*3)) continue;
          cell._moveFromX=old.x;cell._moveFromY=old.y;cell._moveUntil=session.lastSeen+80;
        }
      }
      // Only isolated integration tests may inject a world fixture.
      if (process.env.NODE_ENV === "test" && process.env.SPLITFLUX_TEST_WORLD === "1" && session.isAdmin && session.running && body.world && number(body.ackBotRevision, 0, 0) >= botRevision && number(body.ackBotMassRevision, 0, 0) >= botMassRevision) {
        const sharedEjected = world ? world.ejected : [];
        world = cleanWorld(body.world);
        world.bots = world.bots.filter(bot => !moderation.until([`bot:${bot.botTeam || bot.name}`]));
        world.ejected = sharedEjected;
      }
      // Map boundaries are independent of bot correction acknowledgements.
      if (process.env.NODE_ENV === "test" && process.env.SPLITFLUX_TEST_WORLD === "1" && session.isAdmin && session.running && body.world && world) {
        world.worldSize = number(body.world.worldSize, world.worldSize, 5200, 1e9);
      }
      addSharedEjected(session, body.ejectedAdditions);
      simulateSharedEjected(0);
      if (!wasRunning && session.running) ensureSafeOnlineSpawn(session);
      resolveCollisions();

      const players = [...sessions.values()].filter(other => other.id !== session.id).map(sessionView);
      const activeCount = [...sessions.values()].filter(other => other.running).length;
      session.lastReplyCells=session.cells.filter(cell=>cell.alive).map(cell=>({netId:cell.netId,mass:cell.mass}));
      session.lastReplyRevision=session.revision;
      sendJson(response, 200, {
        self: sessionView(session),
        account: session.account,
        isAdmin: session.isAdmin,
        acceptedFeedIds: (Array.isArray(body.ejectedAdditions) ? body.ejectedAdditions : []).filter(pellet => session.feedIds.has(pellet.netId)).map(pellet => pellet.netId),
        teamedBots: [...session.teamedBots],
        teamRevision:session.teamRevision,
        followedBotTeam: session.followedBotTeam,
        botControllers: botControllers(),
        acceptedBotSplitCommands: (Array.isArray(body.botSplitCommands) ? body.botSplitCommands : []).filter(id => session.botActionIds.has(id)),
        botSplitError,
        bannedBotTeams: moderation.bannedBotTeams(),
        food: foodSyncFor(body, rejectedFood),
        players,
        playerCount: Math.max(1, activeCount),
        world,
        worldRevision,
        botRevision,
        botMassRevision,
      });
    } catch (error) {
      sendJson(response, 400, { error: "Invalid room update" });
    }
    return;
  }

  if (request.method === "GET" && files[url.pathname]) {
    const [fileName, contentType] = files[url.pathname];
    const filePath = path.join(root, fileName);
    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
      response.end(data);
    });
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
};
const server = http.createServer(handleRequest);

world = cleanWorld({ worldSize: 5200, bots: [], viruses: Array.from({ length: 22 }, () => ({
  x: 100 + Math.random() * 5000,
  y: 100 + Math.random() * 5000,
  r: 42,
  angle: Math.random() * Math.PI * 2,
})) });
for (let index = 0; index < 24; index++) spawnServerBot();

let lastFallbackTick = Date.now();
function tickArena(dt) {
  cleanupSessions();
  simulateSharedEjected(dt);
  simulateBotFeeding();
  simulateServerBots(dt);
  resolveCollisions();
  if (world) {
    const before=world.bots.length;
    world.bots=world.bots.filter(bot=>!moderation.until([`bot:${bot.botTeam||bot.name}`]));
    if (world.bots.length!==before) botRevision++;
  }
}
function advanceArena() {
  const now=Date.now();
  let elapsed=Math.min(2,Math.max(0,(now-lastFallbackTick)/1000));
  while (elapsed>0) {const dt=Math.min(.04,elapsed);tickArena(dt);elapsed-=dt;}
  lastFallbackTick=now;
}
const fallbackTimer = cloudMode ? null : setInterval(advanceArena,40);
fallbackTimer?.unref();

function enableRealtime(target=server,dispatch=handleRequest){
  realtime=require("./realtime.cjs").attachRealtime(target,{getSession:id=>sessions.get(id),dispatch});
  return realtime;
}
if(!cloudMode&&typeof server.on==="function")enableRealtime();

if (!cloudMode) server.listen(port, "0.0.0.0", () => {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  console.log("");
  console.log("SPLITFLUX ONLINE SERVER");
  console.log("========================");
  console.log(`OWNER PC: http://localhost:${port}/owner`);
  for (const address of addresses) {
    console.log(`MOBILE OWNER: http://${address}:${port}/mobile-owner`);
    console.log(`MOBILE GUEST: http://${address}:${port}/mobile`);
    console.log(`REGULAR GUEST: http://${address}:${port}/`);
  }
  console.log("");
  console.log("Keep this window open while playing.");
  console.log("Sign in to the alpha account for owner and admin powers.");
});

function exportState() {
  return {world,food:exportFoodState(),signInGuard,worldRevision,botRevision,botMassRevision,serverBotCounter,serverFallbackActive,
    botRespawnBlockedUntil,targetBotTeams,botPieceCap,lastFallbackTick,ownerId,
    sessions:[...sessions.values()].map(session=>({...session,feedIds:[...session.feedIds],
      botActionIds:[...session.botActionIds],teamedBots:[...session.teamedBots]}))};
}
function importState(state) {
  if (!state || !state.world || !Array.isArray(state.sessions)) throw new Error("Invalid shared arena state");
  world=state.world; foodState=importFoodState(state.food); signInGuard=importSignInGuard(state.signInGuard); worldRevision=state.worldRevision||0; botRevision=state.botRevision||0;
  botMassRevision=state.botMassRevision||0; serverBotCounter=state.serverBotCounter||0;
  serverFallbackActive=Boolean(state.serverFallbackActive);botRespawnBlockedUntil=state.botRespawnBlockedUntil||0;
  targetBotTeams=state.targetBotTeams||24;botPieceCap=state.botPieceCap||96;
  lastFallbackTick=state.lastFallbackTick||Date.now();ownerId=state.ownerId||null;sessions.clear();
  for (const session of state.sessions) sessions.set(session.id,{...session,feedIds:new Set(session.feedIds),
    botActionIds:new Set(session.botActionIds),teamedBots:new Set(session.teamedBots)});
}
module.exports = { server, handleRequest, advanceArena, exportState, importState, enableRealtime };
