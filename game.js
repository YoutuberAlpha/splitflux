const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const minimap = document.querySelector("#minimap");
const mctx = minimap.getContext("2d");

let worldSize = 5200;
const FOOD_COUNT = 49600;
const BOT_COUNT = 24;
const CRAZY_BOT_COUNT = 48;
const XTRA_CRAZY_BOT_COUNT = 96;
const MEGA_CRAZY_BOT_COUNT = XTRA_CRAZY_BOT_COUNT * 2;
const VIRUS_COUNT = 22;
const COLORS = ["#ff4f7b", "#b6ff4a", "#55d6ff", "#9b7bff", "#ffb547", "#38e6b0", "#ff6e52", "#e865ff"];
const BOT_NAMES = ["Alex", "Maya", "Jordan", "Sofia", "Ethan", "Chloe", "Noah", "Ava", "Liam", "Emma", "Lucas", "Mia", "Leo", "Zoe", "Owen", "Ruby", "Jack", "Ella", "Henry", "Lily", "Sam", "Grace", "Daniel", "Nora"];
const EXTRA_NAMES = ["Oliver", "Isla", "James", "Amelia", "Mateo", "Harper", "Ben", "Layla", "Theo", "Ivy", "Finn", "Luna", "Kai", "Alice", "Adam", "Hazel", "Ryan", "Clara", "Dylan", "Sadie", "Milo", "Lucy", "Caleb", "Aria", "Isaac", "Eva", "Julian", "Rose", "Max", "Sarah", "Logan", "Emily", "Miles", "Anna", "Luke", "Julia", "Oscar", "Elena", "Cole", "Violet", "Nico", "Stella", "Aaron", "Jade", "Eli", "Maria", "Dean", "Willa", "Ian", "Leah", "Joel", "Cora", "Ezra", "Bella", "Hugo", "Lila", "Aiden", "Mae", "Jonah", "Tessa", "Simon", "Elise", "Blake", "June", "Jason", "Daisy", "Louis", "Molly", "David", "Nina", "Asher", "Faye", "Jamie", "Holly"];

let width = innerWidth;
let height = innerHeight;
const efficientGraphics = matchMedia('(pointer: coarse)').matches || /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg/.test(navigator.userAgent);
let dpr = Math.min(devicePixelRatio || 1, efficientGraphics ? 1.5 : 2);
let running = false;
let gameOver = false;
let lastTime = 0;
let player;
let playerCells = [];
let bots = [];
let food = [];
let ejected = [];
const pendingFeedCommands = new Map();
let viruses = [];
let particles = [];
let camera = { x: worldSize / 2, y: worldSize / 2, zoom: 1 };
let pointer = { x: width / 2, y: height / 2 };
let keys = {};
let score = 0;
let startTime = 0;
let feedCooldown = 0;
let manualZoom = 1;
let fpsLimit = 60;
let lastFrameTime = 0;
const DEFAULT_PLAYER_SPEED = 235;
let playerSpeed = 235;
let crazyMode = false;
let xtraCrazyMode = false;
let megaCrazyMode = false;
let botImmunity = false;
let botSpawnTimer = 0;
let botRespawnPausedUntil = 0;
let botNameCounter = 0;
let playerColor = "#b6ff4a";
let playerBlobImage = null;
let playerBlobImageData = "";
const onlineMode = location.protocol === "http:" || location.protocol === "https:";
let isAdmin = !onlineMode;
let remotePlayerCells = [];
let teamedBots = new Set();
let selectedTeamBot = null;
let followedBotTeam = null;
let botFollowTargets = new Map();
const pendingBotSplitCommands = new Set();
const remoteSkinImages = new Map();
let bannedBotTeams = new Set();
let selectedModerationTarget = null;
let spikePainter = false;
let spikePainting = false;
let lastPaintAt = 0;
let offlineBotFeedCooldown = 0;
let currentBanUntil = 0;

function cursorWorldPosition() {
  return { x: clamp(camera.x + (pointer.x - width / 2) / camera.zoom, 0, worldSize),
    y: clamp(camera.y + (pointer.y - height / 2) / camera.zoom, 0, worldSize) };
}

const ui = {
  start: document.querySelector("#startScreen"),
  death: document.querySelector("#deathScreen"),
  name: document.querySelector("#nameInput"),
  colorInput: document.querySelector("#colorInput"),
  fpsSelect: document.querySelector("#fpsSelect"),
  imageField: document.querySelector("#imageField"),
  blobImageInput: document.querySelector("#blobImageInput"),
  blobImagePreview: document.querySelector("#blobImagePreview"),
  score: document.querySelector("#score"),
  mass: document.querySelector("#mass"),
  rank: document.querySelector("#rank"),
  list: document.querySelector("#leaderboardList"),
  finalScore: document.querySelector("#finalScore"),
  hint: document.querySelector("#hint"),
  admin: document.querySelector("#adminPanel"),
  adminControls: document.querySelector("#adminControls"),
};

function resize() {
  width = innerWidth;
  height = innerHeight;
  dpr = Math.min(devicePixelRatio || 1, efficientGraphics ? 1.5 : 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const safeMass = value => Math.max(1, Number.isFinite(Number(value)) ? Number(value) : 1);
const radiusForMass = m => Math.sqrt(safeMass(m)) * 4.2 + 8;
const boundCell = (value, radius) => radius * 2 >= worldSize ? worldSize / 2 : clamp(value, radius, worldSize - radius);

function safeRandomCoordinate(radius) {
  const margin = Math.min(worldSize / 2, Math.max(80, radius + 80));
  if (worldSize <= margin * 2) return worldSize / 2;
  return rand(margin, worldSize - margin);
}

function setCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 86400000).toUTCString();
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

function getCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const cookie = document.cookie.split("; ").find(item => item.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
}

function saveColorPreference(color) {
  try { localStorage.setItem("voidcellColor", color); } catch {}
  setCookie("voidcellColor", color);
}

function loadColorPreference() {
  try {
    const stored = localStorage.getItem("voidcellColor");
    if (stored) return stored;
  } catch {}
  return getCookie("voidcellColor");
}

function saveNamePreference(name) {
  try { localStorage.setItem("voidcellName", name); } catch {}
  setCookie("voidcellName", name);
}

function loadNamePreference() {
  try {
    const stored = localStorage.getItem("voidcellName");
    if (stored) return stored;
  } catch {}
  return getCookie("voidcellName");
}

function saveMapSizePreference(size) {
  try { sessionStorage.setItem("tricksplitMapSize", String(size)); } catch {}
  try { localStorage.setItem("tricksplitMapSize", String(size)); } catch {}
}

function loadMapSizePreference() {
  try {
    const stored = Number(sessionStorage.getItem("tricksplitMapSize") || localStorage.getItem("tricksplitMapSize"));
    if (Number.isFinite(stored) && stored >= 5200) return stored;
  } catch {}
  return worldSize;
}

function updateMapSizeLabel() {
  document.querySelector("#mapSizeLabel").textContent = worldSize.toLocaleString();
}

function saveBlobImagePreference(dataUrl) {
  try {
    if (dataUrl) localStorage.setItem("voidcellBlobImage", dataUrl);
    else localStorage.removeItem("voidcellBlobImage");
  } catch {}
}

function loadBlobImagePreference() {
  try { return localStorage.getItem("voidcellBlobImage") || ""; } catch {}
  return "";
}

function setPlayerBlobImage(dataUrl) {
  playerBlobImageData = dataUrl || "";
  if (!playerBlobImageData) {
    playerBlobImage = null;
    ui.blobImagePreview.classList.add("hidden");
    ui.blobImagePreview.removeAttribute("src");
    saveBlobImagePreference("");
    return;
  }
  const img = new Image();
  img.onload = () => {
    playerBlobImage = img;
    ui.blobImagePreview.src = playerBlobImageData;
    ui.blobImagePreview.classList.remove("hidden");
  };
  img.src = playerBlobImageData;
  saveBlobImagePreference(playerBlobImageData);
}

function saveFpsPreference(value) {
  try { localStorage.setItem("voidcellFpsLimit", String(value)); } catch {}
}

function loadFpsPreference() {
  try { return Number(localStorage.getItem("voidcellFpsLimit")) || 60; } catch {}
  return 60;
}

function setFpsLimit(value) {
  const allowed = [30, 60, 90, 120, 144, 165, 240];
  fpsLimit = allowed.includes(Number(value)) ? Number(value) : 60;
  if (ui.fpsSelect) ui.fpsSelect.value = String(fpsLimit);
  saveFpsPreference(fpsLimit);
}

function clearActiveBlobImage() {
  playerBlobImageData = "";
  playerBlobImage = null;
  ui.blobImagePreview.classList.add("hidden");
  ui.blobImagePreview.removeAttribute("src");
  ui.blobImageInput.value = "";
}

function updateBlobImageAccess() {
  ui.imageField.classList.remove("hidden");
  ui.blobImageInput.disabled = false;
  document.querySelector("#clearBlobImage").disabled = false;
  if (!playerBlobImageData) setPlayerBlobImage(loadBlobImagePreference());
}

function lightenColor(hex, amount) {
  const value = parseInt(hex.replace("#", ""), 16);
  const r = Math.min(255, (value >> 16) + amount);
  const g = Math.min(255, ((value >> 8) & 255) + amount);
  const b = Math.min(255, (value & 255) + amount);
  return `rgb(${r}, ${g}, ${b})`;
}

function makeFood() {
  return {
    x: rand(35, worldSize - 35),
    y: rand(35, worldSize - 35),
    r: rand(2.4, 5.2),
    value: rand(0.7, 1.5),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    pulse: rand(0, Math.PI * 2)
  };
}

function makeVirus() {
  return { x: rand(120, worldSize - 120), y: rand(120, worldSize - 120), r: rand(38, 48), angle: rand(0, Math.PI * 2) };
}

function humanBotName(index) {
  const names = [...BOT_NAMES, ...EXTRA_NAMES];
  const base = names[index % names.length];
  const cycle = Math.floor(index / names.length);
  return cycle ? `${base} ${cycle + 1}` : base;
}

function makeCell(name, isPlayer = false) {
  const mass = isPlayer ? 28 : rand(18, 115);
  return {
    name,
    isPlayer,
    x: rand(250, worldSize - 250),
    y: rand(250, worldSize - 250),
    vx: 0,
    vy: 0,
    mass,
    radius: radiusForMass(mass),
    color: isPlayer ? playerColor : COLORS[Math.floor(Math.random() * COLORS.length)],
    accent: isPlayer ? lightenColor(playerColor, 75) : "#ffffff",
    targetX: rand(0, worldSize),
    targetY: rand(0, worldSize),
    think: rand(0, 1),
    alive: true,
    boost: 0,
    mergeAt: 0,
    launchX: 0,
    launchY: 0,
    botTeam: isPlayer ? null : name,
    splitCooldown: rand(0, 3),
    invulnerableUntil: 0,
    virusImmuneUntil: 0,
  };
}

function findSafeSpawn(radius, avoidCells = [], extraClearance = 180) {
  const candidates = avoidCells.filter(cell => cell && cell.alive);
  let best = { x: worldSize / 2, y: worldSize / 2, clearance: -Infinity };
  for (let attempt = 0; attempt < 120; attempt++) {
    const x = safeRandomCoordinate(radius);
    const y = safeRandomCoordinate(radius);
    let clearance = Infinity;
    for (const cell of candidates) {
      clearance = Math.min(clearance, Math.hypot(x - cell.x, y - cell.y) - radius - cell.radius);
    }
    for (const virus of viruses) {
      clearance = Math.min(clearance, Math.hypot(x - virus.x, y - virus.y) - radius - virus.r);
    }
    if (clearance >= extraClearance) return { x, y };
    if (clearance > best.clearance) best = { x, y, clearance };
  }
  return best;
}

function spreadSpawnPosition(index, total, radius) {
  const cols = Math.ceil(Math.sqrt(total));
  const rows = Math.ceil(total / cols);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const cellW = worldSize / cols;
  const cellH = worldSize / rows;
  const jitterX = rand(-cellW * .2, cellW * .2);
  const jitterY = rand(-cellH * .2, cellH * .2);
  return {
    x: boundCell((col + .5) * cellW + jitterX, radius),
    y: boundCell((row + .5) * cellH + jitterY, radius)
  };
}

function createInitialBots() {
  bots = [];
  const names = Array.from({ length: BOT_COUNT }, (_, index) => humanBotName(index)).sort(() => Math.random() - .5);
  names.forEach((name, index) => {
    const bot = makeCell(name);
    const spread = spreadSpawnPosition(index, names.length, bot.radius);
    bot.x = spread.x;
    bot.y = spread.y;
    let tooClose = bots.some(other => distance(bot, other) < bot.radius + other.radius + 80) ||
      viruses.some(virus => distance(bot, virus) < bot.radius + virus.r + 60);
    if (tooClose) {
      const safe = findSafeSpawn(bot.radius, bots, 90);
      bot.x = safe.x;
      bot.y = safe.y;
    }
    bots.push(bot);
  });
}

function resetGame() {
  if (currentBanUntil > Date.now()) return;
  pendingFeedCommands.clear();
  if (isAdmin) {
    worldSize = loadMapSizePreference();
    updateMapSizeLabel();
  }
  playerColor = ui.colorInput.value;
  saveNamePreference(ui.name.value.trim());
  food = Array.from({ length: FOOD_COUNT }, makeFood);
  particles = [];
  ejected = [];
  if (!onlineMode) {
    viruses = Array.from({ length: VIRUS_COUNT }, makeVirus);
    createInitialBots();
  }
  player = makeCell((ui.name.value.trim() || "NOVA").toUpperCase(), true);
  const playerSpawn = findSafeSpawn(player.radius, [...bots, ...remotePlayerCells], 500);
  player.x = playerSpawn.x;
  player.y = playerSpawn.y;
  player.invulnerableUntil = performance.now() + 2500;
  playerCells = [player];
  camera.x = player.x;
  camera.y = player.y;
  camera.zoom = 1;
  score = 0;
  startTime = performance.now();
  gameOver = false;
  running = true;
  if (isAdmin) document.querySelector("#adminShortcut").classList.remove("inactive");
  ui.start.classList.add("hidden");
  ui.death.classList.add("hidden");
  ui.hint.style.opacity = "1";
  setTimeout(() => ui.hint.style.opacity = "0", 5000);
}

function spawnBot(name) {
  const uniqueName = name || humanBotName(botNameCounter++);
  const bot = makeCell(uniqueName);
  const playerMass = playerCenter().mass;
  bot.mass = rand(Math.max(14, playerMass * .06), Math.max(42, playerMass * .18));
  bot.radius = radiusForMass(bot.mass);
  const avoid = [...playerCells, ...bots];
  const safe = findSafeSpawn(bot.radius, avoid, 300);
  bot.x = safe.x;
  bot.y = safe.y;
  if (!Number.isFinite(bot.x) || !Number.isFinite(bot.y)) {
    const spread = spreadSpawnPosition(botNameCounter, Math.max(BOT_COUNT, avoid.length + 1), bot.radius);
    bot.x = spread.x;
    bot.y = spread.y;
  }
  bot.invulnerableUntil = performance.now() + 2500;
  bots.push(bot);
}

function maintainBotPopulation(dt) {
  if (onlineMode) return;
  bots = bots.filter(bot => bot.alive);
  if (performance.now() < botRespawnPausedUntil) return;
  botSpawnTimer -= dt;
  if (botSpawnTimer > 0) return;
  const { targetTeams, pieceCap, spawnBatch, spawnDelay } = currentBotModeSettings();
  botSpawnTimer = spawnDelay;
  const livingTeams = new Set(bots.filter(bot => bot.alive).map(bot => bot.botTeam));
  for (let i = 0; i < spawnBatch && livingTeams.size < targetTeams && bots.length < pieceCap; i++) {
    const missingDefault = Array.from({ length: BOT_COUNT }, (_, index) => humanBotName(index)).find(name => !livingTeams.has(name));
    spawnBot(missingDefault);
    livingTeams.add(bots[bots.length - 1].botTeam);
  }
}

function currentBotModeSettings() {
  return {
    targetTeams: megaCrazyMode ? MEGA_CRAZY_BOT_COUNT : xtraCrazyMode ? XTRA_CRAZY_BOT_COUNT : crazyMode ? CRAZY_BOT_COUNT : BOT_COUNT,
    pieceCap: megaCrazyMode ? 360 : xtraCrazyMode ? 180 : crazyMode ? 96 : 56,
    spawnBatch: megaCrazyMode ? 8 : xtraCrazyMode ? 5 : crazyMode ? 3 : 2,
    spawnDelay: megaCrazyMode ? .015 : xtraCrazyMode ? .025 : crazyMode ? .05 : .14
  };
}

function trimBotsToCurrentMode() {
  if (onlineMode) {
    window.configureArenaOnline?.({botCount:currentBotModeSettings().targetTeams}).catch(showArenaError);
    return;
  }
  const { targetTeams, pieceCap } = currentBotModeSettings();
  const teams = new Map();
  bots.filter(bot => bot.alive).forEach((bot, index) => {
    const team = bot.botTeam || bot.name || `bot-${index}`;
    if (!teams.has(team)) teams.set(team, { name: team, cells: [], mass: 0, firstIndex: index });
    const group = teams.get(team);
    group.cells.push(bot);
    group.mass += bot.mass || 0;
    group.firstIndex = Math.min(group.firstIndex, index);
  });

  const keptTeams = Array.from(teams.values())
    .sort((a, b) => b.mass - a.mass || a.firstIndex - b.firstIndex)
    .slice(0, targetTeams);

  const trimmed = [];
  for (const team of keptTeams) {
    team.cells.sort((a, b) => b.mass - a.mass);
    for (const cell of team.cells) {
      if (trimmed.length >= pieceCap) break;
      trimmed.push(cell);
    }
    if (trimmed.length >= pieceCap) break;
  }
  bots = trimmed;
}

function steer(cell, tx, ty, dt) {
  if (!cell.isPlayer && performance.now() < (cell.splitLineUntil || 0)) {
    const lineX = Number(cell.splitLineX) || 0;
    const lineY = Number(cell.splitLineY) || 0;
    tx = cell.x + lineX * 1000;
    ty = cell.y + lineY * 1000;
  }
  const dx = tx - cell.x;
  const dy = ty - cell.y;
  const len = Math.hypot(dx, dy) || 1;
  const movementSpeed = cell.isPlayer ? playerSpeed : 235;
  const baseSpeed = movementSpeed / Math.pow(cell.mass / 25, 0.18);
  const speed = baseSpeed;
  const ease = Math.min(1, dt * 5.5);
  if (!cell.isPlayer && performance.now() < (cell.splitLineUntil || 0)) {
    cell.vx = dx / len * speed;
    cell.vy = dy / len * speed;
  } else {
    cell.vx += ((dx / len) * speed - cell.vx) * ease;
    cell.vy += ((dy / len) * speed - cell.vy) * ease;
  }
  cell.x = boundCell(cell.x + cell.vx * dt, cell.radius);
  cell.y = boundCell(cell.y + cell.vy * dt, cell.radius);
  BlobPhysics.moveBoost(cell, dt, worldSize, "launchX", "launchY", cell.radius);
  cell.radius = radiusForMass(cell.mass);
}

function updatePlayer(dt) {
  const center = playerCenter();
  let tx = center.x + (pointer.x - width / 2) / camera.zoom;
  let ty = center.y + (pointer.y - height / 2) / camera.zoom;
  const keyX = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  const keyY = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
  if (keyX || keyY) {
    tx = center.x + keyX * 500;
    ty = center.y + keyY * 500;
  }
  playerCells.filter(c => c.alive).forEach(cell => steer(cell, tx, ty, dt));
  feedCooldown = Math.max(0, feedCooldown - dt);
  if (keys.KeyW) feedMass();
  offlineBotFeedCooldown = Math.max(0, offlineBotFeedCooldown - dt);
  if (!onlineMode && keys.KeyT && followedBotTeam && !offlineBotFeedCooldown) {
    offlineBotFeedCooldown = .06;
    const target = cursorWorldPosition();
    for (const bot of bots.filter(bot => bot.alive && (bot.botTeam || bot.name) === followedBotTeam && bot.mass > BlobPhysics.minFeedMass)) {
      if (!bot.netId) bot.netId = `bot-${Math.random().toString(36).slice(2)}`;
      bot.mass -= BlobPhysics.feedCost;
      bot.radius = radiusForMass(bot.mass);
      ejected.push({ ...BlobPhysics.createFeed(bot,target.x-bot.x,target.y-bot.y,target,worldSize),color:bot.color,ownerCellId:bot.netId,ownerUntil:performance.now()+700,createdAt:performance.now() });
    }
  }
  separatePlayerCells();
}

function playerCenter() {
  const alive = playerCells.filter(c => c.alive);
  const mass = alive.reduce((sum, c) => sum + c.mass, 0) || 1;
  return {
    x: alive.reduce((sum, c) => sum + c.x * c.mass, 0) / mass,
    y: alive.reduce((sum, c) => sum + c.y * c.mass, 0) / mass,
    mass
  };
}

function aimDirection() {
  const dx = pointer.x - width / 2;
  const dy = pointer.y - height / 2;
  return BlobPhysics.direction(dx, dy);
}

function partitionMassCorrection(cell, pieces) {
  for (const key of ["_syncMassWeights", "_pendingFeedCosts"]) {
    if (cell[key]) cell[key] = Object.fromEntries(Object.entries(cell[key]).map(([id, weight]) => [id, weight / pieces]));
  }
}

function combineMassCorrections(target, source) {
  for (const key of ["_syncMassWeights", "_pendingFeedCosts"]) {
    const weights = { ...target[key] };
    for (const [id, weight] of Object.entries(source[key] || {})) weights[id] = (weights[id] || 0) + weight;
    target[key] = weights;
  }
}

function splitPlayer() {
  if (!running) return;
  const dir = aimDirection();
  const now = performance.now();
  const newCells = [];
  for (const cell of playerCells.filter(c => c.alive)) {
    partitionMassCorrection(cell, 2);
    cell.mass = Math.max(cell.mass / 2, .000001);
    cell.radius = radiusForMass(cell.mass);
    cell.mergeAt = now + 3000;
    const child = { ...cell, netId: `cell-${Math.random().toString(36).slice(2)}` };
    child.x = boundCell(cell.x + dir.x * Math.min(8, cell.radius * .08), cell.radius);
    child.y = boundCell(cell.y + dir.y * Math.min(8, cell.radius * .08), cell.radius);
    child.launchX = dir.x * Math.max(720, cell.radius * 6);
    child.launchY = dir.y * Math.max(720, cell.radius * 6);
    child.splitBirthAt = now;
    child.mergeAt = now + 3000;
    newCells.push(child);
    emit(cell.x, cell.y, cell.color, 8);
  }
  playerCells.push(...newCells);
  player = playerCells.find(c => c.alive) || player;
}

function quadSplitPlayer() {
  if (!running) return;
  const original = playerCells.filter(c => c.alive);
  const dir = aimDirection();
  const now = performance.now();
  const result = [];
  for (const cell of original) {
    partitionMassCorrection(cell, 4);
    const pieceMass = Math.max(cell.mass / 4, .000001);
    cell.mass = pieceMass;
    cell.radius = radiusForMass(pieceMass);
    cell.mergeAt = now + 3000;
    for (let i = 1; i <= 3; i++) {
      const child = { ...cell, netId: `cell-${Math.random().toString(36).slice(2)}` };
      child.x = boundCell(cell.x + dir.x * Math.min(4, cell.radius * .04) * i, cell.radius);
      child.y = boundCell(cell.y + dir.y * Math.min(4, cell.radius * .04) * i, cell.radius);
      child.launchX = dir.x * (520 + i * 120) * Math.max(1, cell.radius / 70);
      child.launchY = dir.y * (520 + i * 120) * Math.max(1, cell.radius / 70);
      child.splitBirthAt = now;
      result.push(child);
    }
  }
  playerCells.push(...result);
}

function tripleSplitPlayer() {
  if (!running) return;
  const original = playerCells.filter(c => c.alive);
  const dir = aimDirection();
  const now = performance.now();
  const result = [];
  for (const cell of original) {
    partitionMassCorrection(cell, 3);
    const pieceMass = Math.max(cell.mass / 3, .000001);
    cell.mass = pieceMass;
    cell.radius = radiusForMass(pieceMass);
    cell.mergeAt = now + 3000;
    for (let i = 1; i <= 2; i++) {
      const child = { ...cell, netId: `cell-${Math.random().toString(36).slice(2)}` };
      child.x = boundCell(cell.x + dir.x * Math.min(4, cell.radius * .04) * i, cell.radius);
      child.y = boundCell(cell.y + dir.y * Math.min(4, cell.radius * .04) * i, cell.radius);
      child.launchX = dir.x * (560 + i * 140) * Math.max(1, cell.radius / 70);
      child.launchY = dir.y * (560 + i * 140) * Math.max(1, cell.radius / 70);
      child.splitBirthAt = now;
      result.push(child);
    }
  }
  playerCells.push(...result);
}

function fiveSplitPlayer() {
  if (!running) return;
  const original = playerCells.filter(c => c.alive);
  const dir = aimDirection();
  const now = performance.now();
  const result = [];
  for (const cell of original) {
    partitionMassCorrection(cell, 5);
    const pieceMass = Math.max(cell.mass / 5, .000001);
    cell.mass = pieceMass;
    cell.radius = radiusForMass(pieceMass);
    cell.mergeAt = now + 3000;
    for (let i = 1; i <= 4; i++) {
      const child = { ...cell, netId: `cell-${Math.random().toString(36).slice(2)}` };
      child.x = boundCell(cell.x + dir.x * Math.min(4, cell.radius * .04) * i, cell.radius);
      child.y = boundCell(cell.y + dir.y * Math.min(4, cell.radius * .04) * i, cell.radius);
      child.launchX = dir.x * (500 + i * 115) * Math.max(1, cell.radius / 70);
      child.launchY = dir.y * (500 + i * 115) * Math.max(1, cell.radius / 70);
      child.splitBirthAt = now;
      result.push(child);
    }
  }
  playerCells.push(...result);
}

function sixSplitPlayer() {
  if (!running) return;
  const original = playerCells.filter(c => c.alive);
  const dir = aimDirection();
  const now = performance.now();
  const result = [];
  for (const cell of original) {
    partitionMassCorrection(cell, 6);
    const pieceMass = Math.max(cell.mass / 6, .000001);
    cell.mass = pieceMass;
    cell.radius = radiusForMass(pieceMass);
    cell.mergeAt = now + 3000;
    for (let i = 1; i <= 5; i++) {
      const child = { ...cell, netId: `cell-${Math.random().toString(36).slice(2)}` };
      child.x = boundCell(cell.x + dir.x * Math.min(4, cell.radius * .04) * i, cell.radius);
      child.y = boundCell(cell.y + dir.y * Math.min(4, cell.radius * .04) * i, cell.radius);
      child.launchX = dir.x * (480 + i * 105) * Math.max(1, cell.radius / 70);
      child.launchY = dir.y * (480 + i * 105) * Math.max(1, cell.radius / 70);
      child.splitBirthAt = now;
      result.push(child);
    }
  }
  playerCells.push(...result);
}

function squareSplitPlayer() {
  if (!running) return;
  const original = playerCells.filter(c => c.alive);
  const now = performance.now();
  const result = [];
  for (const cell of original) {
    partitionMassCorrection(cell, 4);
    const pieceMass = Math.max(cell.mass / 4, .000001);
    const centerX = cell.x;
    const centerY = cell.y;
    cell.mass = pieceMass;
    cell.radius = radiusForMass(pieceMass);
    cell.mergeAt = now + 3000;
    const offsets = [
      { x: -1, y: -1, original: true },
      { x: 1, y: -1 },
      { x: -1, y: 1 },
      { x: 1, y: 1 },
    ];
    for (const offset of offsets) {
      const piece = offset.original ? cell : { ...cell, netId: `cell-${Math.random().toString(36).slice(2)}` };
      piece.x = boundCell(centerX + offset.x * cell.radius * .08, cell.radius);
      piece.y = boundCell(centerY + offset.y * cell.radius * .08, cell.radius);
      piece.launchX = offset.x * Math.max(120, cell.radius * 5);
      piece.launchY = offset.y * Math.max(120, cell.radius * 5);
      piece.splitBirthAt = now;
      piece.targetX = piece.x;
      piece.targetY = piece.y;
      if (!offset.original) result.push(piece);
    }
  }
  playerCells.push(...result);
}

function feedMass() {
  if (!running || feedCooldown > 0) return;
  if (onlineMode && pendingFeedCommands.size >= BlobPhysics.feeding.maxPending || ejected.length >= 700) return;
  const target = cursorWorldPosition();
  let fed = false;
  for (const cell of playerCells.filter(c => c.alive)) {
    if (onlineMode && pendingFeedCommands.size >= BlobPhysics.feeding.maxPending) break;
    if (cell.mass <= BlobPhysics.minFeedMass) continue;
    if (!cell.netId) cell.netId = `local-feed-owner-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    cell.mass -= BlobPhysics.feedCost;
    cell.radius = radiusForMass(cell.mass);
    const pellet = { ...BlobPhysics.createFeed(cell, target.x - cell.x, target.y - cell.y, target, worldSize),
      netId: `feed-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
      sourceX:cell.x,sourceY:cell.y,sourceMass:cell.mass,
      color: cell.color, ownerUntil: performance.now() + 700, createdAt: performance.now(), ownerCellId: cell.netId };
    pellet.startX = pellet.x;
    pellet.startY = pellet.y;
    ejected.push(pellet);
    if (onlineMode) {
      cell._pendingFeedCosts = { ...cell._pendingFeedCosts, [pellet.netId]: BlobPhysics.feedCost };
      pendingFeedCommands.set(pellet.netId, { ...pellet });
    }
    fed = true;
  }
  if (fed) feedCooldown = BlobPhysics.feeding.interval;
}

function separatePlayerCells() {
  const now = performance.now();
  for (let i = 0; i < playerCells.length; i++) for (let j = i + 1; j < playerCells.length; j++) {
    const a = playerCells[i], b = playerCells[j];
    if (!a.alive || !b.alive) continue;
    if (now - Math.max(a.splitBirthAt || 0, b.splitBirthAt || 0) < 180) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const canMerge = now >= a.mergeAt && now >= b.mergeAt;
    if (canMerge && d < a.radius + b.radius * .65) {
      const big = a.mass >= b.mass ? a : b, small = big === a ? b : a;
      combineMassCorrections(big, small);
      big.mass += small.mass;
      big.radius = radiusForMass(big.mass);
      small.alive = false;
      continue;
    }
    if (canMerge) {
      const pull = Math.min(4.5, d * .018);
      a.x += dx / d * pull; a.y += dy / d * pull;
      b.x -= dx / d * pull; b.y -= dy / d * pull;
      continue;
    }
    const overlap = a.radius + b.radius - d;
    if (overlap > 0) {
      const push = overlap * .055;
      a.x -= dx / d * push; a.y -= dy / d * push;
      b.x += dx / d * push; b.y += dy / d * push;
    }
  }
  playerCells = playerCells.filter(c => c.alive);
}

function burstPlayerCell(cell) {
  if (!cell.alive || cell.mass < 90 || playerCells.length >= 16) return;
  const pieces = Math.min(6, 16 - playerCells.length);
  partitionMassCorrection(cell, pieces + 1);
  const pieceMass = cell.mass / (pieces + 1);
  cell.mass = pieceMass;
  cell.radius = radiusForMass(pieceMass);
  cell.mergeAt = performance.now() + 3000;
  for (let i = 0; i < pieces; i++) {
    const angle = Math.PI * 2 * i / pieces + rand(-.25, .25);
    const child = { ...cell, netId: `cell-${Math.random().toString(36).slice(2)}` };
    child.x = clamp(cell.x + Math.cos(angle) * cell.radius, cell.radius, worldSize - cell.radius);
    child.y = clamp(cell.y + Math.sin(angle) * cell.radius, cell.radius, worldSize - cell.radius);
    child.launchX = Math.cos(angle) * rand(380, 620);
    child.launchY = Math.sin(angle) * rand(380, 620);
    playerCells.push(child);
  }
  emit(cell.x, cell.y, "#56ff71", 24);
}

function burstBotCell(bot) {
  const maxPieces = megaCrazyMode ? 360 : xtraCrazyMode ? 180 : crazyMode ? 96 : 64;
  if (!bot.alive || bot.mass < 90 || bots.length >= maxPieces) return;
  const pieces = Math.min(6, maxPieces - bots.length);
  if (pieces < 1) return;
  const pieceMass = bot.mass / (pieces + 1);
  bot.mass = pieceMass;
  bot.radius = radiusForMass(pieceMass);
  bot.splitCooldown = 7;
  bot.mergeAt = performance.now() + 15000;
  for (let i = 0; i < pieces; i++) {
    const angle = Math.PI * 2 * i / pieces + rand(-.25, .25);
    const child = { ...bot };
    child.x = boundCell(bot.x + Math.cos(angle) * bot.radius, bot.radius);
    child.y = boundCell(bot.y + Math.sin(angle) * bot.radius, bot.radius);
    child.launchX = Math.cos(angle) * rand(380, 620);
    child.launchY = Math.sin(angle) * rand(380, 620);
    child.splitCooldown = 7;
    child.mergeAt = bot.mergeAt;
    bots.push(child);
  }
  emit(bot.x, bot.y, "#56ff71", 24);
}

function handleViruses() {
  for (let virusIndex = viruses.length - 1; virusIndex >= 0; virusIndex--) {
    const virus = viruses[virusIndex];
    let consumed = false;
    for (const cell of playerCells.filter(c => c.alive)) {
      if (!botImmunity && performance.now() >= cell.virusImmuneUntil && distance(cell, virus) < cell.radius + virus.r * .65 && cell.mass > 90) {
        burstPlayerCell(cell);
        consumed = true;
        break;
      }
    }
    if (!consumed && !onlineMode) {
      for (const bot of bots.filter(c => c.alive)) {
        if (distance(bot, virus) < bot.radius + virus.r * .65 && bot.mass > 90) {
          burstBotCell(bot);
          consumed = true;
          break;
        }
      }
    }
    if (consumed) viruses.splice(virusIndex, 1);
  }
}

function splitBot(bot, prey) {
  const maxPieces = megaCrazyMode ? 360 : xtraCrazyMode ? 180 : crazyMode ? 96 : 64;
  if (!bot.alive || !prey || !prey.alive || bot.mass < 44 || bot.splitCooldown > 0 || bots.length >= maxPieces) return;
  const dx = prey.x - bot.x;
  const dy = prey.y - bot.y;
  const len = Math.hypot(dx, dy) || 1;
  const pieceMass = bot.mass / 2;
  if (pieceMass < prey.mass * 1.18) return;
  bot.mass = pieceMass;
  bot.radius = radiusForMass(pieceMass);
  bot.splitCooldown = rand(1.15, 2.35);
  bot.mergeAt = performance.now() + 15000;
  const launchSpeed = clamp(len * 1.25, 680, 980);
  const dirX = dx / len;
  const dirY = dy / len;
  const lineTargetX = clamp(bot.x + dirX * 1800, 0, worldSize);
  const lineTargetY = clamp(bot.y + dirY * 1800, 0, worldSize);
  const splitLineUntil = performance.now() + 900;
  bot.vx = dirX * 160;
  bot.vy = dirY * 160;
  bot.launchX = dirX * launchSpeed;
  bot.launchY = dirY * launchSpeed;
  bot.targetX = lineTargetX;
  bot.targetY = lineTargetY;
  bot.splitLineX = dirX;
  bot.splitLineY = dirY;
  bot.splitLineUntil = splitLineUntil;
  bot.think = Math.max(bot.think, .42);
  const child = { ...bot };
  child.x = clamp(bot.x + dirX * bot.radius * 1.4, bot.radius, worldSize - bot.radius);
  child.y = clamp(bot.y + dirY * bot.radius * 1.4, bot.radius, worldSize - bot.radius);
  child.vx = bot.vx;
  child.vy = bot.vy;
  child.launchX = bot.launchX;
  child.launchY = bot.launchY;
  child.targetX = lineTargetX;
  child.targetY = lineTargetY;
  child.splitLineX = dirX;
  child.splitLineY = dirY;
  child.splitLineUntil = splitLineUntil;
  child.think = bot.think;
  child.splitCooldown = rand(.95, 1.85);
  child.mergeAt = bot.mergeAt;
  bots.push(child);
  emit(bot.x, bot.y, bot.color, 8);
}

function botShouldSplitFor(bot, prey, preyDist) {
  if (!prey || bot.splitCooldown > 0) return false;
  const splitMass = bot.mass / 2;
  if (splitMass < Math.max(24, prey.mass * 1.18)) return false;
  const splitRadius = radiusForMass(splitMass);
  const reach = splitRadius * 2.2 + 560;
  if (preyDist > reach) return false;
  if (preyDist < bot.radius * .55) return false;
  const hunger = prey.isPlayer ? 1.18 : 1;
  const confidence = clamp((reach - preyDist) / reach + (splitMass / Math.max(1, prey.mass) - 1.18) * .55, 0, 1);
  return Math.random() < Math.min(.9, (.34 + confidence * .5) * hunger);
}

function applyCpuAssistance(dt) {
  const playerMass = playerCenter().mass;
  const targetMass = Math.max(45, playerMass * .42);
  for (const bot of bots) {
    if (!bot.alive || bot.mass >= targetMass) continue;
    const growth = Math.min(targetMass - bot.mass, Math.max(.6, targetMass * .012) * dt);
    bot.mass += growth;
    bot.radius = radiusForMass(bot.mass);
  }
}

function updateBot(bot, dt) {
  bot.splitCooldown = Math.max(0, bot.splitCooldown - dt);
  const target = followedBotTeam === (bot.botTeam || bot.name) ? cursorWorldPosition() : botFollowTargets.get(bot.botTeam || bot.name);
  if (target) {
    bot.splitLineUntil = 0;
    bot.targetX = target.x;
    bot.targetY = target.y;
    if (Math.hypot(target.x - bot.x, target.y - bot.y) < 8) { bot.vx = 0; bot.vy = 0; }
    else steer(bot, target.x, target.y, dt);
    return;
  }
  if (performance.now() < (bot.splitLineUntil || 0)) {
    bot.targetX = clamp(bot.x + (Number(bot.splitLineX) || 0) * 1800, 0, worldSize);
    bot.targetY = clamp(bot.y + (Number(bot.splitLineY) || 0) * 1800, 0, worldSize);
    steer(bot, bot.targetX, bot.targetY, dt);
    return;
  }
  bot.think -= dt;
  if (bot.think <= 0) {
    bot.think = rand(.18, .45);
    let threat = null;
    let prey = null;
    let nearestFood = null;
    let threatDist = Infinity;
    let preyDist = Infinity;
    let foodDist = Infinity;
    let nearestVirus = null;
    let virusDist = Infinity;
    const cells = [...playerCells, ...bots];
    for (const other of cells) {
      if (!other || other === bot || !other.alive || (other.botTeam && other.botTeam === bot.botTeam)) continue;
      const d = distance(bot, other);
      if (other.mass > bot.mass * 1.2 && d < threatDist && d < 760) { threat = other; threatDist = d; }
      const splitMass = bot.mass / 2;
      if ((bot.mass > other.mass * 1.25 || splitMass > other.mass * 1.18) && d < preyDist && d < 820) { prey = other; preyDist = d; }
    }
    for (const dot of food) {
      const d = (bot.x - dot.x) ** 2 + (bot.y - dot.y) ** 2;
      if (d < foodDist) { foodDist = d; nearestFood = dot; }
    }
    if (bot.mass > 105) {
      for (const virus of viruses) {
        const d = distance(bot, virus);
        if (d < virusDist) { virusDist = d; nearestVirus = virus; }
      }
    }
    if (nearestVirus && virusDist < bot.radius + 135) {
      bot.targetX = bot.x + (bot.x - nearestVirus.x) * 3;
      bot.targetY = bot.y + (bot.y - nearestVirus.y) * 3;
    } else if (threat) {
      bot.targetX = bot.x + (bot.x - threat.x) * 2;
      bot.targetY = bot.y + (bot.y - threat.y) * 2;
    } else if (prey && Math.random() < .82) {
      bot.targetX = prey.x;
      bot.targetY = prey.y;
      if (botShouldSplitFor(bot, prey, preyDist)) splitBot(bot, prey);
    } else if (nearestFood) {
      bot.targetX = nearestFood.x;
      bot.targetY = nearestFood.y;
    } else {
      bot.targetX = rand(0, worldSize);
      bot.targetY = rand(0, worldSize);
    }
  }
  steer(bot, bot.targetX, bot.targetY, dt);
}

function mergeBotTeams() {
  const now = performance.now();
  for (let i = 0; i < bots.length; i++) {
    const a = bots[i];
    if (!a.alive || now < a.mergeAt) continue;
    for (let j = i + 1; j < bots.length; j++) {
      const b = bots[j];
      if (!b.alive || a.botTeam !== b.botTeam || now < b.mergeAt) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < a.radius + b.radius * .65) {
        const big = a.mass >= b.mass ? a : b;
        const small = big === a ? b : a;
        big.mass += small.mass;
        big.radius = radiusForMass(big.mass);
        big.mergeAt = 0;
        small.alive = false;
        continue;
      }
      const pull = Math.min(3.2, d * .012);
      a.x += dx / d * pull; a.y += dy / d * pull;
      b.x -= dx / d * pull; b.y -= dy / d * pull;
    }
  }
  bots = bots.filter(bot => bot.alive);
}

const foodBuckets = new Map();
let indexedFood = null, indexedFoodLength = -1, indexedFoodWorld = 0;
const foodBucketKey = dot => Math.floor(dot.x / 256) + ',' + Math.floor(dot.y / 256);
function addFoodIndex(i) {
  const key = foodBucketKey(food[i]);
  if (!foodBuckets.has(key)) foodBuckets.set(key, new Set());
  foodBuckets.get(key).add(i);
}
function nearbyFood(cell) {
  if (indexedFood !== food || indexedFoodLength !== food.length || indexedFoodWorld !== worldSize) {
    foodBuckets.clear();for(let i=0;i<food.length;i++)addFoodIndex(i);
    indexedFood=food;indexedFoodLength=food.length;indexedFoodWorld=worldSize;
  }
  const reach=cell.radius+20;
  const minX=Math.floor((cell.x-reach)/256),maxX=Math.floor((cell.x+reach)/256);
  const minY=Math.floor((cell.y-reach)/256),maxY=Math.floor((cell.y+reach)/256);
  const found=[];
  if((maxX-minX+1)*(maxY-minY+1)>foodBuckets.size*2){
    for(const [key,indices]of foodBuckets){const [x,y]=key.split(',').map(Number);if(x>=minX&&x<=maxX&&y>=minY&&y<=maxY)found.push(...indices);}
  }else for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++){const bucket=foodBuckets.get(x+','+y);if(bucket)found.push(...bucket);}
  return found.sort((a,b)=>b-a);
}

function eatFood(cell) {
  for (const i of nearbyFood(cell)) {
    const dx = cell.x - food[i].x;
    const dy = cell.y - food[i].y;
    const reach = cell.radius + food[i].r;
    if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
    if (dx * dx + dy * dy < reach * reach) {
      cell.mass += food[i].value;
      if (cell.isPlayer) score += Math.ceil(food[i].value * 3);
      if (food.length <= 12000 || cell.isPlayer) emit(food[i].x, food[i].y, food[i].color, food.length > 12000 ? 1 : 2);
      const oldKey = foodBucketKey(food[i]);
      foodBuckets.get(oldKey)?.delete(i);
      if (!foodBuckets.get(oldKey)?.size) foodBuckets.delete(oldKey);
      food[i] = makeFood();
      addFoodIndex(i);
    }
  }
}

function updateEjected(dt) {
  ejected = ejected.filter(pellet => (
    pellet &&
    Number.isFinite(pellet.x) &&
    Number.isFinite(pellet.y) &&
    Number.isFinite(pellet.vx) &&
    Number.isFinite(pellet.vy) &&
    Number.isFinite(pellet.value) &&
    Number.isFinite(pellet.r) &&
    pellet.r > 0
  )).slice(-700);
  for (const pellet of ejected) {
    pellet.previousX = pellet.x;
    pellet.previousY = pellet.y;
    if (Number.isFinite(pellet.flightX) && Number.isFinite(pellet.createdAt)) {
      pellet.flightAge = Math.max(pellet.flightAge || 0, (performance.now()-pellet.createdAt)/1000-dt);
    }
    BlobPhysics.moveFeed(pellet, dt, worldSize);
    pellet.drawX = pellet.x;
    pellet.drawY = pellet.y;
  }
  const cells = [...playerCells, ...bots].filter(c => c.alive);
  for (let i = ejected.length - 1; i >= 0; i--) {
    const pellet = ejected[i];
    if (performance.now() - (Number(pellet.createdAt) || 0) > 7000) {
      ejected.splice(i, 1);
      continue;
    }
    if (onlineMode) continue;
    const eater = cells.find(c => BlobPhysics.catchesFeed(c, pellet, pellet.previousX, pellet.previousY) && (c.netId !== pellet.ownerCellId || performance.now() > pellet.ownerUntil));
    if (eater) {
      eater.mass = safeMass(eater.mass) + clamp(safeMass(pellet.value), .1, BlobPhysics.feedValue);
      eater.radius = radiusForMass(eater.mass);
      emit(pellet.x, pellet.y, pellet.color, 4);
      ejected.splice(i, 1);
    }
  }
}

function handleCells() {
  const cells = [...playerCells, ...bots].filter(Boolean);
  for (let i = 0; i < cells.length; i++) {
    const a = cells[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < cells.length; j++) {
      const b = cells[j];
      if (!b.alive) continue;
      if (a.isPlayer && b.isPlayer) continue;
      if (a.botTeam && a.botTeam === b.botTeam) continue;
      const d = distance(a, b);
      const big = a.mass > b.mass ? a : b;
      const small = big === a ? b : a;
      if (botImmunity && small.isPlayer && !big.isPlayer) continue;
      if (small.isPlayer && !big.isPlayer && teamedBots.has(big.botTeam || big.name) && playerCells.filter(cell => cell.alive).length <= 1) continue;
      if (!big.isPlayer && performance.now() < small.invulnerableUntil) continue;
      if (big.mass > small.mass * 1.18 && d < big.radius - small.radius * .28) {
        big.mass += small.mass * .72;
        big.radius = radiusForMass(big.mass);
        if (big.isPlayer) score += Math.round(small.mass * 12);
        emit(small.x, small.y, small.color, 18);
        small.alive = false;
        if (small.isPlayer) {
          if (!playerCells.some(c => c.alive)) endGame();
        }
        else bots = bots.filter(bot => bot.alive);
      }
    }
  }
}

function emit(x, y, color, count) {
  for (let i = 0; i < count; i++) particles.push({ x, y, vx: rand(-90, 90), vy: rand(-90, 90), life: rand(.3, .8), max: .8, color, r: rand(1.5, 4) });
}
function emitTrail(cell) {
  particles.push({ x: cell.x - cell.vx * .12, y: cell.y - cell.vy * .12, vx: -cell.vx * .15 + rand(-20, 20), vy: -cell.vy * .15 + rand(-20, 20), life: .45, max: .45, color: cell.color, r: rand(2, 5) });
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= .96;
    p.vy *= .96;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function endGame() {
  running = false;
  gameOver = true;
  ui.admin.classList.add("hidden");
  document.querySelector("#adminShortcut").classList.add("inactive");
  ui.finalScore.textContent = score.toLocaleString();
  setTimeout(() => ui.death.classList.remove("hidden"), 500);
}

function returnToMainMenu() {
  running = false;
  keys.KeyT=false;
  setSpikePainter(false);
  document.querySelector("#botTeamMenu").classList.add("hidden");
  gameOver = false;
  ui.admin.classList.add("hidden");
  ui.death.classList.add("hidden");
  ui.start.classList.remove("hidden");
  document.querySelector("#adminShortcut").classList.add("inactive");
}

function update(dt) {
  if (!running) return;
  bots = bots.filter(bot => !bannedBotTeams.has(bot.botTeam || bot.name));
  updatePlayer(dt);
  maintainBotPopulation(dt);
  applyCpuAssistance(dt);
  playerCells.filter(c => c.alive).forEach(eatFood);
  bots.forEach(bot => {
    if (!bot.alive) return;
    updateBot(bot, dt);
    eatFood(bot);
  });
  mergeBotTeams();
  handleCells();
  handleViruses();
  updateEjected(dt);
  updateParticles(dt);
  const center = playerCenter();
  player = playerCells.find(c => c.alive) || player;
  const naturalZoom = clamp(1.15 / Math.pow(center.mass / 28, .16), .38, 1.05);
  const targetZoom = Math.max(Number.MIN_VALUE, naturalZoom * manualZoom);
  camera.zoom += (targetZoom - camera.zoom) * Math.min(1, dt * 3);
  camera.x += (center.x - camera.x) * Math.min(1, dt * 4);
  camera.y += (center.y - camera.y) * Math.min(1, dt * 4);
  updateUI();
}

function worldToScreen(x, y) {
  return { x: (x - camera.x) * camera.zoom + width / 2, y: (y - camera.y) * camera.zoom + height / 2 };
}

function drawGrid() {
  ctx.fillStyle = "#05070b";
  ctx.fillRect(0, 0, width, height);
  const spacing = 72 * camera.zoom;
  const major = spacing * 5;
  ctx.lineWidth = 1;
  if (spacing >= 5) {
    const ox = (-camera.x * camera.zoom + width / 2) % spacing;
    const oy = (-camera.y * camera.zoom + height / 2) % spacing;
    ctx.strokeStyle = "rgba(139,159,181,.055)";
    ctx.beginPath();
    for (let x = ox; x < width; x += spacing) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    for (let y = oy; y < height; y += spacing) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    ctx.stroke();
  }
  if (major >= 5) {
    const mx = (-camera.x * camera.zoom + width / 2) % major;
    const my = (-camera.y * camera.zoom + height / 2) % major;
    ctx.strokeStyle = "rgba(139,159,181,.075)";
    ctx.beginPath();
    for (let x = mx; x < width; x += major) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    for (let y = my; y < height; y += major) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    ctx.stroke();
  }
  const tl = worldToScreen(0, 0);
  const br = worldToScreen(worldSize, worldSize);
  ctx.strokeStyle = "rgba(182,255,74,.25)";
  ctx.lineWidth = 2;
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
}

function drawFood(dot, time) {
  const s = worldToScreen(dot.x, dot.y);
  if (s.x < -15 || s.x > width + 15 || s.y < -15 || s.y > height + 15) return;
  const r = dot.r * camera.zoom;
  ctx.fillStyle = dot.color;
  if (food.length > 12000 || r < 2.2) {
    ctx.globalAlpha = .9;
    const size = Math.max(1.4, r * 1.4);
    ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
    ctx.globalAlpha = 1;
    return;
  }
  const pulsedR = r * (1 + Math.sin(time * .002 + dot.pulse) * .08);
  ctx.globalAlpha = .8;
  ctx.shadowBlur = 8;
  ctx.shadowColor = dot.color;
  ctx.beginPath();
  ctx.arc(s.x, s.y, Math.max(1.5, pulsedR), 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

function drawEjected(pellet) {
  const s = worldToScreen(pellet.drawX ?? pellet.x, pellet.drawY ?? pellet.y);
  const r = pellet.r * camera.zoom;
  if (s.x < -r || s.y < -r || s.x > width+r || s.y > height+r) return;
  ctx.fillStyle = pellet.color;
  ctx.beginPath();
  ctx.arc(s.x, s.y, Math.max(2, r), 0, Math.PI * 2);
  ctx.fill();
}

function drawVirus(virus) {
  const s = worldToScreen(virus.x, virus.y);
  const r = virus.r * camera.zoom;
  if (s.x < -r || s.x > width + r || s.y < -r || s.y > height + r) return;
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(virus.angle);
  ctx.fillStyle = "#1fcd5a";
  ctx.strokeStyle = "#75ff9b";
  ctx.lineWidth = Math.max(1, 2 * camera.zoom);
  ctx.shadowBlur = efficientGraphics ? 0 : 18;
  ctx.shadowColor = "#38ff75";
  ctx.beginPath();
  const spikes = 20;
  for (let i = 0; i < spikes * 2; i++) {
    const angle = Math.PI * i / spikes;
    const rr = i % 2 ? r * .78 : r;
    const x = Math.cos(angle) * rr, y = Math.sin(angle) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawCell(cell) {
  if (!cell.alive) return;
  const s = worldToScreen(cell.x, cell.y);
  const r = cell.radius * camera.zoom;
  if (s.x < -r || s.x > width + r || s.y < -r || s.y > height + r) return;
  const grad = ctx.createRadialGradient(s.x - r * .25, s.y - r * .3, r * .1, s.x, s.y, r);
  grad.addColorStop(0, cell.accent);
  grad.addColorStop(.18, cell.color);
  grad.addColorStop(1, cell.color + "99");
  ctx.shadowBlur = efficientGraphics || r > 240 ? 0 : Math.min(25, r * .28);
  ctx.shadowColor = cell.color + "99";
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
  ctx.fill();
  const skin = cell.isPlayer ? playerBlobImage : cell.isRemote ? remoteSkinImages.get(cell.remoteSessionId)?.image : null;
  if (skin && skin.complete && skin.naturalWidth) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * .94, 0, Math.PI * 2);
    ctx.clip();
    const size = r * 1.9;
    ctx.drawImage(skin, s.x - size / 2, s.y - size / 2, size, size);
    ctx.restore();
  }
  ctx.shadowBlur = 0;
  ctx.strokeStyle = !cell.isPlayer && teamedBots.has(cell.botTeam || cell.name) ? "#38e6b0" : cell.isPlayer ? "rgba(230,255,181,.8)" : "rgba(255,255,255,.25)";
  ctx.lineWidth = Math.max(1, 2 * camera.zoom);
  ctx.stroke();
  if (r > 14) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = cell.isPlayer ? "#10150a" : "rgba(255,255,255,.92)";
    ctx.font = `600 ${clamp(r * .33, 9, 18)}px Consolas`;
    ctx.fillText(cell.name, s.x, s.y - (r > 36 ? 3 : 0));
    if (r > 36) {
      ctx.globalAlpha = .65;
      ctx.font = `600 ${clamp(r * .18, 7, 11)}px Consolas`;
      ctx.fillText(Math.round(cell.mass), s.x, s.y + r * .24);
      ctx.globalAlpha = 1;
    }
  }
}

function drawParticles() {
  for (const p of particles) {
    const s = worldToScreen(p.x, p.y);
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, p.r * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawVignette() {
  const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * .2, width / 2, height / 2, Math.max(width, height) * .72);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,.48)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
}

function drawMinimap() {
  const w = minimap.width, h = minimap.height;
  mctx.clearRect(0, 0, w, h);
  mctx.fillStyle = "#080c12";
  mctx.fillRect(0, 0, w, h);
  mctx.strokeStyle = "rgba(255,255,255,.12)";
  mctx.strokeRect(.5, .5, w - 1, h - 1);
  for (const bot of bots) {
    if (!bot.alive) continue;
    mctx.fillStyle = bot.color;
    mctx.globalAlpha = .65;
    mctx.fillRect(bot.x / worldSize * w - 1, bot.y / worldSize * h - 1, 2, 2);
  }
  if (playerCells.length) {
    const center = playerCenter();
    mctx.globalAlpha = 1;
    mctx.fillStyle = "#b6ff4a";
    mctx.beginPath();
    mctx.arc(center.x / worldSize * w, center.y / worldSize * h, 3.5, 0, Math.PI * 2);
    mctx.fill();
  }
}

let lastHudUpdate = -Infinity;
function updateUI() {
  const now = performance.now();
  if (running && now - lastHudUpdate < 100) return;
  lastHudUpdate = now;
  const totalMass = playerCenter().mass;
  const standings = [{ name: player.name, mass: totalMass, isPlayer: true }, ...bots.filter(c => c.alive), ...remotePlayerCells.filter(c => c.alive)].sort((a, b) => b.mass - a.mass);
  const rank = standings.findIndex(c => c.isPlayer) + 1;
  ui.score.textContent = score.toLocaleString();
  ui.mass.textContent = Math.round(totalMass);
  ui.rank.textContent = `#${rank}`;
  document.querySelector("#leaderboard").classList.toggle("moderating", running);
  ui.list.replaceChildren(...standings.slice(0,8).map(cell => {
    const row=document.createElement("li"), name=document.createElement("span"), mass=document.createElement("strong");
    row.className=cell.isPlayer?"player":"";
    name.textContent=cell.name; mass.textContent=Math.round(cell.mass); row.append(name,mass);
    if (running && !cell.isPlayer && (!cell.isRemote || isAdmin)) {
      const button=document.createElement("button");button.type="button";
      button.append(name,mass);row.replaceChildren(button);
      const open=()=>cell.isRemote?showModeration(cell):showBotTeam(cell);
      button.addEventListener("pointerdown",event=>{event.preventDefault();open();});
      button.addEventListener("click",event=>{if(event.detail===0)open();});
    }
    return row;
  }));
  document.querySelector("#botCount").textContent = `${bots.filter(bot => bot.alive).length} BOTS`;
}

function render(time) {
  drawGrid();
  const pad = 60 / camera.zoom;
  const left = camera.x - width / (2 * camera.zoom) - pad;
  const right = camera.x + width / (2 * camera.zoom) + pad;
  const top = camera.y - height / (2 * camera.zoom) - pad;
  const bottom = camera.y + height / (2 * camera.zoom) + pad;
  for (const dot of food) {
    if (dot.x < left || dot.x > right || dot.y < top || dot.y > bottom) continue;
    drawFood(dot, time);
  }
  ejected.forEach(drawEjected);
  viruses.forEach(drawVirus);
  drawParticles();
  [...bots, ...playerCells].filter(Boolean).sort((a, b) => a.mass - b.mass).forEach(drawCell);
  drawVignette();
  drawMinimap();
}

function loop(time) {
  const frameInterval = 1000 / fpsLimit;
  if (lastFrameTime && time - lastFrameTime < frameInterval) {
    requestAnimationFrame(loop);
    return;
  }
  lastFrameTime = time;
  const dt = Math.min(.035, (time - lastTime) / 1000 || 0);
  lastTime = time;
  update(dt);
  render(time);
  requestAnimationFrame(loop);
}

function showModeration(cell) {
  if (!isAdmin || !cell || cell.isPlayer) return;
  selectedModerationTarget = {targetId:cell.remoteSessionId || null,botTeam:cell.isRemote?null:cell.botTeam||cell.name,name:cell.name};
  document.querySelector("#moderationName").textContent=cell.name;
  document.querySelector("#moderationMessage").textContent="Choose how long this player should be banned.";
  document.querySelector("#moderationMenu").classList.remove("hidden");
}
document.querySelector("#closeModeration").addEventListener("click",()=>document.querySelector("#moderationMenu").classList.add("hidden"));
document.querySelector("#botBanOptions").addEventListener("click",()=>showModeration(bots.find(bot=>(bot.botTeam||bot.name)===selectedTeamBot)));
document.querySelector("#confirmBan").addEventListener("click",async()=>{
  if (!isAdmin || !selectedModerationTarget) return;
  const unit=document.querySelector("#banUnit").value;
  const durationMs=unit==="forever"?null:Number(document.querySelector("#banDuration").value)*Number(unit);
  const message=document.querySelector("#moderationMessage"), button=document.querySelector("#confirmBan");
  if (durationMs!==null&&(!Number.isFinite(durationMs)||durationMs<1000)) {message.textContent="Choose at least one second.";return;}
  button.disabled=true;
  try {
    if (onlineMode) await window.banPlayerOnline(selectedModerationTarget,durationMs);
    else if (selectedModerationTarget.botTeam) {
      const team=selectedModerationTarget.botTeam;
      bannedBotTeams.add(team); bots=bots.filter(bot=>(bot.botTeam||bot.name)!==team);
      if (durationMs!==null&&durationMs<2147483647) setTimeout(()=>bannedBotTeams.delete(team),durationMs);
    }
    message.textContent="Ban applied.";
  } catch(error) {message.textContent=error.message;} finally {button.disabled=false;}
});
function showArenaError(error) {
  document.querySelector("#arenaTool").classList.remove("hidden");
  document.querySelector("#arenaToolMessage").textContent=error.message||String(error);
}
function setSpikePainter(enabled) {
  spikePainter=Boolean(enabled&&isAdmin&&running);
  spikePainting=false;
  document.querySelector("#spikePainter").textContent=`SPIKE PAINTER: ${spikePainter?"ON":"OFF"}`;
  canvas.style.cursor=spikePainter?"cell":"crosshair";
  document.querySelector("#arenaTool").classList.toggle("hidden",!spikePainter);
  document.querySelector("#arenaToolMessage").textContent="Paint mode: click or drag on empty map space.";
  if (spikePainter) {ui.admin.classList.add("hidden");document.querySelector("#botTeamMenu").classList.add("hidden");}
}
document.querySelector("#stopPainting").addEventListener("click",()=>setSpikePainter(false));
document.querySelector("#spikePainter").addEventListener("click",()=>{
  setSpikePainter(!spikePainter);
});
let paintRequestPending=false;
function paintSpike(event) {
  if (!spikePainter||!isAdmin||!running||paintRequestPending||performance.now()-lastPaintAt<80) return;
  lastPaintAt=performance.now();
  const point={x:clamp(camera.x+(event.clientX-width/2)/camera.zoom,42,worldSize-42),y:clamp(camera.y+(event.clientY-height/2)/camera.zoom,42,worldSize-42)};
  if (viruses.length>=200) {showArenaError(new Error("Spike limit reached (200). Remove spikes before painting more."));return;}
  if (viruses.some(virus=>Math.hypot(virus.x-point.x,virus.y-point.y)<84)) {showArenaError(new Error("Move farther from the existing spike."));return;}
  if (onlineMode) {
    paintRequestPending=true;
    window.paintSpikesOnline([point]).then(result=>{document.querySelector("#arenaToolMessage").textContent=result.added?"Spike added. Keep clicking or dragging to paint.":"No spike added. Choose clear map space.";}).catch(showArenaError).finally(()=>{paintRequestPending=false;});
  }
  else viruses.push({...point,r:42,angle:0});
}
canvas.addEventListener("pointerdown",event=>{
  if (!spikePainter||!isAdmin||!running) return;
  event.preventDefault();spikePainting=true;canvas.setPointerCapture(event.pointerId);lastPaintAt=-Infinity;paintSpike(event);
});
canvas.addEventListener("pointermove",event=>{if(spikePainting)paintSpike(event);});
canvas.addEventListener("pointerup",()=>{spikePainting=false;});
canvas.addEventListener("pointercancel",()=>{spikePainting=false;});
document.querySelector("#playButton").addEventListener("click", resetGame);
canvas.addEventListener("pointerdown", event => {
  if (!running || spikePainter) return;
  const x = camera.x + (event.clientX - width / 2) / camera.zoom;
  const y = camera.y + (event.clientY - height / 2) / camera.zoom;
  const remote=remotePlayerCells.find(cell=>cell.alive&&Math.hypot(cell.x-x,cell.y-y)<=cell.radius);
  if (remote && isAdmin) { showModeration(remote); return; }
  const bot = [...bots].reverse().find(cell => cell.alive && Math.hypot(cell.x - x, cell.y - y) <= cell.radius);
  const menu = document.querySelector("#botTeamMenu");
  if (!bot) { menu.classList.add("hidden"); return; }
  showBotTeam(bot);
});
function showBotTeam(bot) {
  if (!running || !bot || !bot.alive) return;
  setSpikePainter(false);
  selectedTeamBot = bot.botTeam || bot.name;
  document.querySelector("#botTeamMessage").textContent = teamedBots.has(selectedTeamBot) ? "Teammate: this bot cannot eat your last blob." : "A teammate cannot eat your last blob.";
  document.querySelector("#botTeamName").textContent = bot.name;
  document.querySelector("#botTeamToggle").textContent = teamedBots.has(selectedTeamBot) ? "STOP TEAMING" : "TEAM WITH BOT";
  document.querySelector("#botBanOptions").hidden = !isAdmin;
  document.querySelector("#botTeamMenu").classList.remove("hidden");
}
document.querySelector("#closeBotTeam").addEventListener("click", () => document.querySelector("#botTeamMenu").classList.add("hidden"));
async function toggleSelectedBotTeam() {
  if (!selectedTeamBot || !running) return;
  const team = selectedTeamBot;
  const enabled = !teamedBots.has(team);
  const button = document.querySelector("#botTeamToggle");
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (onlineMode) await window.setBotTeamOnline(team, enabled);
    else if (enabled) { teamedBots.clear(); teamedBots.add(team); followedBotTeam=team; }
    else { teamedBots.delete(team); followedBotTeam=null; }
    button.textContent = enabled ? "STOP TEAMING" : "TEAM WITH BOT";
    document.querySelector("#botTeamMessage").textContent = enabled ? "Following cursor. Hold T: bot feed. Press 1: bot split. Your last blob is protected." : "No longer teaming.";
  } catch(error) { document.querySelector("#botTeamMessage").textContent = error.message||"Could not update team. Try again."; }
  finally { button.disabled = false; }
}
document.querySelector("#botTeamToggle").addEventListener("click", toggleSelectedBotTeam);
document.querySelector("#restartButton").addEventListener("click", resetGame);
document.querySelector("#adminShortcut").addEventListener("pointerdown", event => {
  event.preventDefault();
  toggleAdmin();
});
document.querySelector("#closeAdmin").addEventListener("pointerdown", toggleAdmin);
document.querySelector("#minimizeAdmin").addEventListener("pointerdown", () => {
  ui.admin.classList.toggle("minimized");
  document.querySelector("#minimizeAdmin").textContent = ui.admin.classList.contains("minimized") ? "+" : "-";
});
document.querySelector("#doubleMap").addEventListener("pointerdown", doubleMapSize);
document.querySelector("#halveMap").addEventListener("pointerdown", halveMapSize);
document.querySelector("#crazyMode").addEventListener("pointerdown", toggleCrazyMode);
document.querySelector("#xtraCrazyMode").addEventListener("pointerdown", toggleXtraCrazyMode);
document.querySelector("#megaCrazyMode").addEventListener("pointerdown", toggleMegaCrazyMode);
document.querySelector("#botImmunity").addEventListener("pointerdown", toggleBotImmunity);
document.querySelector("#applyPlayerSpeed").addEventListener("pointerdown", applyPlayerSpeed);
document.querySelector("#playerSpeedInput").addEventListener("keydown", e => {
  e.stopPropagation();
  if (e.code === "Enter") applyPlayerSpeed();
});
ui.colorInput.addEventListener("input", () => {
  playerColor = ui.colorInput.value;
  document.querySelector("#colorValue").textContent = playerColor.toUpperCase();
  document.documentElement.style.setProperty("--lime", playerColor);
  saveColorPreference(playerColor);
});
ui.name.addEventListener("input", () => saveNamePreference(ui.name.value));
ui.fpsSelect.addEventListener("change", () => setFpsLimit(ui.fpsSelect.value));
ui.blobImageInput.addEventListener("change", () => {
  const file = ui.blobImageInput.files && ui.blobImageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => setPlayerBlobImage(String(reader.result || ""));
  reader.readAsDataURL(file);
});
document.querySelector("#clearBlobImage").addEventListener("click", () => {
  ui.blobImageInput.value = "";
  setPlayerBlobImage("");
});
document.querySelector("#instantMerge").addEventListener("pointerdown", instantlyRemerge);
document.querySelector("#removeSpikes").addEventListener("pointerdown", removeAllSpikes);
document.querySelector("#killEveryone").addEventListener("pointerdown", killEveryone);
document.querySelectorAll("[data-multiplier]").forEach(button => button.addEventListener("pointerdown", () => multiplyPlayer(Number(button.dataset.multiplier))));
document.querySelectorAll("[data-divisor]").forEach(button => button.addEventListener("pointerdown", () => dividePlayer(Number(button.dataset.divisor))));
addEventListener("resize", resize);
addEventListener("mousemove", e => { pointer.x = e.clientX; pointer.y = e.clientY; });
addEventListener("touchmove", e => {
  if (e.target.closest(".mobile-controls, .admin-panel")) return;
  pointer.x = e.touches[0].clientX;
  pointer.y = e.touches[0].clientY;
}, { passive: true });
addEventListener("wheel", e => {
  if (!running || e.target !== canvas) return;
  if (!ui.start.classList.contains("hidden") || !ui.death.classList.contains("hidden")) return;
  e.preventDefault();
  manualZoom = Math.max(Number.MIN_VALUE, manualZoom * Math.exp(-e.deltaY * .0012));
}, { passive: false });
addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === "KeyP" && !e.repeat) {
    if (running) {
      e.preventDefault();
      toggleAdmin();
    }
    return;
  }
  if (e.code === "KeyT") {
    if (running && followedBotTeam) { e.preventDefault(); keys.KeyT=true; }
    return;
  }
  if (e.code === "KeyR") {
    if (!e.repeat) { e.preventDefault(); instantlyRemerge(); }
    return;
  }
  if (e.code === "Digit1" && !e.repeat && running && followedBotTeam) {
    e.preventDefault();
    if (onlineMode) pendingBotSplitCommands.add(`split-${Date.now()}-${Math.random()}`);
    else {
      const target=cursorWorldPosition();
      for (const bot of [...bots].filter(bot=>(bot.botTeam||bot.name)===followedBotTeam)) splitBot(bot,{...target,mass:0,alive:true});
    }
    return;
  }
  if (e.code === "KeyM" && !e.repeat) {
    e.preventDefault();
    returnToMainMenu();
    return;
  }
  if (e.code === "KeyS" && !e.repeat) {
    e.preventDefault();
    removeAllSpikes();
    return;
  }
  if (e.code === "KeyL" && !e.repeat) {
    e.preventDefault();
    toggleBotImmunity();
    return;
  }
  if (e.code === "KeyO" && !e.repeat) {
    e.preventDefault();
    if (!isAdmin) return;
    playerSpeed *= 2;
    document.querySelector("#playerSpeedInput").value = playerSpeed;
    return;
  }
  if (e.code === "KeyN" && !e.repeat) {
    e.preventDefault();
    if (!isAdmin) return;
    playerSpeed = DEFAULT_PLAYER_SPEED;
    document.querySelector("#playerSpeedInput").value = playerSpeed;
    return;
  }
  keys[e.code] = true;
  if (e.code === "Enter" && (!running || gameOver)) resetGame();
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) splitPlayer();
  }
  if (e.code === "KeyW") {
    e.preventDefault();
    if (!e.repeat) feedMass();
  }
  if (e.code === "KeyQ") {
    e.preventDefault();
    if (!e.repeat) quadSplitPlayer();
  }
  if (e.code === "KeyE") {
    e.preventDefault();
    if (!e.repeat) tripleSplitPlayer();
  }
  if (e.code === "KeyA") {
    e.preventDefault();
    if (!e.repeat) fiveSplitPlayer();
  }
  if (e.code === "KeyZ") {
    e.preventDefault();
    if (!e.repeat) sixSplitPlayer();
  }
  if (e.code === "KeyX") {
    e.preventDefault();
    if (!e.repeat) squareSplitPlayer();
  }
  if (e.code === "Digit2" || e.code === "Numpad2") {
    e.preventDefault();
    if (!e.repeat) multiplyPlayer(2);
  }
});
addEventListener("keyup", e => { keys[e.code] = false; });

resize();
document.querySelector("#adminShortcut").classList.add("inactive");
worldSize = loadMapSizePreference();
updateMapSizeLabel();
food = Array.from({ length: FOOD_COUNT }, makeFood);
createInitialBots();
player = makeCell("NOVA", true);
const menuPlayerSpawn = findSafeSpawn(player.radius, bots, 500);
player.x = menuPlayerSpawn.x;
player.y = menuPlayerSpawn.y;
playerCells = [player];
viruses = Array.from({ length: VIRUS_COUNT }, makeVirus);
const savedColor = loadColorPreference();
if (/^#[0-9a-f]{6}$/i.test(savedColor || "")) {
  playerColor = savedColor;
  ui.colorInput.value = savedColor;
  document.querySelector("#colorValue").textContent = savedColor.toUpperCase();
  document.documentElement.style.setProperty("--lime", savedColor);
  player.color = savedColor;
  player.accent = lightenColor(savedColor, 75);
}
const savedName = loadNamePreference();
if (savedName) ui.name.value = savedName.slice(0, 14);
setFpsLimit(loadFpsPreference());
setPlayerBlobImage(loadBlobImagePreference());
updateBlobImageAccess();
updateUI();
requestAnimationFrame(loop);

function toggleAdmin() {
  if (!running || !isAdmin) return;
  ui.admin.classList.toggle("hidden");
}

function multiplyPlayer(multiplier) {
  if (!running || !isAdmin) return;
  playerCells.filter(c => c.alive).forEach(cell => {
    cell.mass *= multiplier;
    cell.radius = radiusForMass(cell.mass);
  });
  score *= multiplier;
  updateUI();
}

function dividePlayer(divisor) {
  if (!running || !isAdmin) return;
  playerCells.filter(c => c.alive).forEach(cell => {
    cell.mass = Math.max(.000001, cell.mass / divisor);
    cell.radius = radiusForMass(cell.mass);
  });
  score = Math.max(0, Math.floor(score / divisor));
  updateUI();
}

function removeAllSpikes() {
  if (!isAdmin) return;
  if (onlineMode) { window.configureArenaOnline({clearSpikes:true}).catch(showArenaError); return; }
  viruses = [];
}

function killEveryone() {
  if (!running || !isAdmin || !onlineMode) return;
  if (typeof window.killEveryoneOnline === "function") window.killEveryoneOnline();
}

function doubleMapSize() {
  if (!isAdmin) return;
  if (onlineMode) { window.configureArenaOnline({mapScale:2}).catch(showArenaError); return; }
  const oldSize = worldSize;
  const nextSize = worldSize * 2;
  const scale = nextSize / oldSize;
  worldSize = nextSize;
  const scalePoint = item => {
    item.x = boundCell(item.x * scale, item.r || item.radius || 0);
    item.y = boundCell(item.y * scale, item.r || item.radius || 0);
    if (Number.isFinite(item.targetX)) item.targetX *= scale;
    if (Number.isFinite(item.targetY)) item.targetY *= scale;
  };
  playerCells.forEach(scalePoint);
  bots.forEach(scalePoint);
  ejected.forEach(scalePoint);
  food.forEach(scalePoint);
  viruses.forEach(scalePoint);
  camera.x *= scale;
  camera.y *= scale;
  const extraFood = Math.min(FOOD_COUNT - food.length, Math.round(food.length * (scale * scale - 1)));
  const extraViruses = Math.min(120, Math.max(8, Math.round(viruses.length * .5)));
  for (let i = 0; i < extraFood; i++) food.push(makeFood());
  for (let i = 0; i < extraViruses; i++) viruses.push(makeVirus());
  while (food.length < FOOD_COUNT) food.push(makeFood());
  updateMapSizeLabel();
  saveMapSizePreference(worldSize);
  emit(worldSize / 2, worldSize / 2, "#9b7bff", 30);
}

function halveMapSize() {
  if (!isAdmin) return;
  if (onlineMode) { window.configureArenaOnline({mapScale:.5}).catch(showArenaError); return; }
  const oldSize = worldSize;
  worldSize = Math.max(5200, worldSize / 2);
  const clampToWorld = cell => {
    cell.x = boundCell(cell.x, cell.radius);
    cell.y = boundCell(cell.y, cell.radius);
  };
  playerCells.forEach(clampToWorld);
  bots.forEach(clampToWorld);
  ejected.forEach(pellet => {
    pellet.x = boundCell(pellet.x, pellet.r);
    pellet.y = boundCell(pellet.y, pellet.r);
  });
  food = food.filter(dot => dot.x <= worldSize && dot.y <= worldSize);
  viruses = viruses.filter(virus => virus.x <= worldSize && virus.y <= worldSize);
  while (food.length < FOOD_COUNT) food.push(makeFood());
  while (viruses.length < VIRUS_COUNT) viruses.push(makeVirus());
  updateMapSizeLabel();
  saveMapSizePreference(worldSize);
  emit(Math.min(oldSize, worldSize), Math.min(oldSize, worldSize), "#6d4fd3", 24);
}

function toggleCrazyMode() {
  if (!isAdmin) return;
  crazyMode = !crazyMode;
  if (crazyMode) {
    xtraCrazyMode = false;
    megaCrazyMode = false;
  }
  const button = document.querySelector("#crazyMode");
  document.querySelector("#crazyModeState").textContent = crazyMode ? "ON" : "OFF";
  button.classList.toggle("active", crazyMode);
  document.querySelector("#xtraCrazyModeState").textContent = "OFF";
  document.querySelector("#xtraCrazyMode").classList.remove("active");
  document.querySelector("#megaCrazyModeState").textContent = "OFF";
  document.querySelector("#megaCrazyMode").classList.remove("active");
  trimBotsToCurrentMode();
  botSpawnTimer = 0;
  maintainBotPopulation(1);
}

function toggleXtraCrazyMode() {
  if (!isAdmin) return;
  xtraCrazyMode = !xtraCrazyMode;
  if (xtraCrazyMode) {
    crazyMode = false;
    megaCrazyMode = false;
  }
  const button = document.querySelector("#xtraCrazyMode");
  document.querySelector("#xtraCrazyModeState").textContent = xtraCrazyMode ? "ON" : "OFF";
  button.classList.toggle("active", xtraCrazyMode);
  document.querySelector("#crazyModeState").textContent = "OFF";
  document.querySelector("#crazyMode").classList.remove("active");
  document.querySelector("#megaCrazyModeState").textContent = "OFF";
  document.querySelector("#megaCrazyMode").classList.remove("active");
  trimBotsToCurrentMode();
  botSpawnTimer = 0;
  maintainBotPopulation(1);
}

function toggleMegaCrazyMode() {
  if (!isAdmin) return;
  megaCrazyMode = !megaCrazyMode;
  if (megaCrazyMode) {
    crazyMode = false;
    xtraCrazyMode = false;
  }
  const button = document.querySelector("#megaCrazyMode");
  document.querySelector("#megaCrazyModeState").textContent = megaCrazyMode ? "ON" : "OFF";
  button.classList.toggle("active", megaCrazyMode);
  document.querySelector("#crazyModeState").textContent = "OFF";
  document.querySelector("#crazyMode").classList.remove("active");
  document.querySelector("#xtraCrazyModeState").textContent = "OFF";
  document.querySelector("#xtraCrazyMode").classList.remove("active");
  trimBotsToCurrentMode();
  botSpawnTimer = 0;
  maintainBotPopulation(1);
}

function toggleBotImmunity() {
  if (!running || !isAdmin) return;
  botImmunity = !botImmunity;
  const button = document.querySelector("#botImmunity");
  document.querySelector("#botImmunityState").textContent = botImmunity ? "ON" : "OFF";
  button.classList.toggle("active", botImmunity);
}

function applyPlayerSpeed() {
  if (!isAdmin) return;
  const input = document.querySelector("#playerSpeedInput");
  const value = Number(input.value);
  if (!Number.isFinite(value)) return;
  playerSpeed = Math.max(Number.MIN_VALUE, value);
  input.value = playerSpeed;
}

function instantlyRemerge() {
  if (!running || !isAdmin) return;
  const alive = playerCells.filter(cell => cell.alive);
  if (alive.length < 2) return;
  const center = playerCenter();
  const merged = alive[0];
  for (const cell of alive.slice(1)) combineMassCorrections(merged, cell);
  merged.mass = center.mass;
  merged.radius = radiusForMass(center.mass);
  merged.x = worldSize > merged.radius * 2 ? clamp(center.x, merged.radius, worldSize - merged.radius) : worldSize / 2;
  merged.y = worldSize > merged.radius * 2 ? clamp(center.y, merged.radius, worldSize - merged.radius) : worldSize / 2;
  merged.vx = 0;
  merged.vy = 0;
  merged.launchX = 0;
  merged.launchY = 0;
  merged.mergeAt = 0;
  merged.virusImmuneUntil = performance.now() + 3000;
  playerCells = [merged];
  player = merged;
  emit(merged.x, merged.y, merged.color, 24);
  updateUI();
}

const adminHeader = document.querySelector(".admin-header");
let adminDrag = null;
adminHeader.addEventListener("pointerdown", e => {
  if (e.target.closest("button")) return;
  const rect = ui.admin.getBoundingClientRect();
  adminDrag = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  adminHeader.setPointerCapture(e.pointerId);
});
adminHeader.addEventListener("pointermove", e => {
  if (!adminDrag) return;
  const maxX = Math.max(0, innerWidth - ui.admin.offsetWidth);
  const maxY = Math.max(0, innerHeight - ui.admin.offsetHeight);
  ui.admin.style.left = `${clamp(e.clientX - adminDrag.x, 0, maxX)}px`;
  ui.admin.style.top = `${clamp(e.clientY - adminDrag.y, 0, maxY)}px`;
});
adminHeader.addEventListener("pointerup", () => { adminDrag = null; });
adminHeader.addEventListener("pointercancel", () => { adminDrag = null; });

const mobileJoystick = document.querySelector("#mobileJoystick");
const mobileJoystickKnob = document.querySelector("#mobileJoystickKnob");
const mobileFeedButton = document.querySelector("#mobileFeed");
let mobileJoystickPointer = null;

function updateMobileJoystick(clientX, clientY) {
  const rect = mobileJoystick.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const maxDistance = rect.width * .34;
  let dx = clientX - centerX;
  let dy = clientY - centerY;
  const distanceFromCenter = Math.hypot(dx, dy) || 1;
  if (distanceFromCenter > maxDistance) {
    dx = dx / distanceFromCenter * maxDistance;
    dy = dy / distanceFromCenter * maxDistance;
  }
  mobileJoystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  pointer.x = width / 2 + dx / maxDistance * Math.max(320, width * .45);
  pointer.y = height / 2 + dy / maxDistance * Math.max(320, height * .45);
}

function releaseMobileJoystick(event) {
  if (mobileJoystickPointer !== null && event.pointerId !== mobileJoystickPointer) return;
  mobileJoystickPointer = null;
  mobileJoystickKnob.style.transform = "translate(0, 0)";
  pointer.x = width / 2;
  pointer.y = height / 2;
}

mobileJoystick.addEventListener("pointerdown", event => {
  event.preventDefault();
  mobileJoystickPointer = event.pointerId;
  mobileJoystick.setPointerCapture(event.pointerId);
  updateMobileJoystick(event.clientX, event.clientY);
});
mobileJoystick.addEventListener("pointermove", event => {
  if (event.pointerId !== mobileJoystickPointer) return;
  event.preventDefault();
  updateMobileJoystick(event.clientX, event.clientY);
});
mobileJoystick.addEventListener("pointerup", releaseMobileJoystick);
mobileJoystick.addEventListener("pointercancel", releaseMobileJoystick);

function startMobileFeed(event) {
  event.preventDefault();
  if (!running) return;
  keys.KeyW = true;
  mobileFeedButton.classList.add("pressed");
  feedMass();
  mobileFeedButton.setPointerCapture(event.pointerId);
}

function stopMobileFeed() {
  keys.KeyW = false;
  mobileFeedButton.classList.remove("pressed");
}

mobileFeedButton.addEventListener("pointerdown", startMobileFeed);
mobileFeedButton.addEventListener("pointerup", stopMobileFeed);
mobileFeedButton.addEventListener("pointercancel", stopMobileFeed);
mobileFeedButton.addEventListener("lostpointercapture", stopMobileFeed);
function bindMobilePointerPress(selector, action) {
  document.querySelector(selector).addEventListener("pointerdown", event => {
    event.preventDefault();
    action();
  });
}

bindMobilePointerPress("#mobileSplit", splitPlayer);
bindMobilePointerPress("#mobileMenu", returnToMainMenu);
bindMobilePointerPress("#mobileZoomOut", () => {
  manualZoom = Math.max(Number.MIN_VALUE, manualZoom * .62);
});
bindMobilePointerPress("#mobileZoomIn", () => {
  manualZoom = Math.min(Number.MAX_VALUE, manualZoom * 1.6);
});
bindMobilePointerPress("#mobileTricksToggle", () => {
  document.querySelector("#mobileTricks").classList.toggle("hidden");
});
document.querySelectorAll("[data-mobile-action]").forEach(button => {
  button.addEventListener("pointerdown", event => {
    event.preventDefault();
    const actions = {
      triple: tripleSplitPlayer,
      quad: quadSplitPlayer,
      five: fiveSplitPlayer,
      six: sixSplitPlayer,
      square: squareSplitPlayer,
    };
    const action = actions[button.dataset.mobileAction];
    if (action) action();
  });
});
function releaseHeldActions() {stopMobileFeed();keys.KeyT=false;spikePainting=false;}
addEventListener("blur", releaseHeldActions);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseHeldActions();
});
