(() => {
  if (!onlineMode) return;

  const status = document.querySelector("#serverStatus");
  const adminShortcut = document.querySelector("#adminShortcut");
  const baseUpdate = update;
  const baseRender = render;
  const baseUpdateEjected = updateEjected;
  let session = null;
  let connected = false;
  let syncing = false;
  let lastWorld = null;
  let lastPlayerCount = 1;
  let networkRevision = 0;
  let worldRevision = 0;
  let botRevision = 0;
  let botMassRevision = 0;
  let forceMenuVersion = 0;
  let remoteCellCache = new Map();
  let ejectedCache = new Map();
  let networkDelay = 0;
  // SKIN SHOP: coins and the worn skin, from the server (sent only when they change; walletSig says which we have).
  let walletSig = "";
  let shopState = null, confirmBuy = null, confirmTimer = 0;  // the SHOP tab (see below)
  let lastChatSeq = 0;  // the newest chat message this game has (see CHAT below)
  let teamRevision = 0;
  let lastSyncAt = -Infinity;
  // Compact updates: the server only resends the bot team table and the spike list when they change,
  // so the game keeps its copies and tells the server which version it has (a short fingerprint).
  let botTeamInfo = new Map();
  let teamsSig = "";
  let spikesSig = "";
  let serverViruses = [];
  const roomTransport=RoomTransport.create({fetch:(...args)=>fetch(...args),WebSocket});
  function showBan(until) {
    currentBanUntil=until;
    returnToMainMenu();
    document.querySelector("#adminUnlockStatus").textContent=until>=8640000000000000?"You are permanently banned from this arena.":`Banned until ${new Date(until).toLocaleString()}. Refresh after the ban expires.`;
    connected=false;
  }

  isAdmin = false;
  adminShortcut.classList.add("hidden", "inactive");
  ui.admin.classList.add("hidden");
  status.innerHTML = '<i class="status-dot"></i> CONNECTING';

  function cellForNetwork(cell) {
    if (!cell.netId) cell.netId = `${session ? session.id : "local"}-${Math.random().toString(36).slice(2)}`;
    const splitLineRemaining = Math.max(0, (Number(cell.splitLineUntil) || 0) - performance.now());
    const mass = cell.mass + Object.values(cell._pendingFeedCosts || {}).reduce((sum, cost) => sum + cost, 0);
    return {
      netId: cell.netId,
      name: cell.name,
      x: cell.x,
      y: cell.y,
      vx: cell.vx,
      vy: cell.vy,
      mass,
      massOrigins: { ...(cell._syncMassWeights || { [cell.netId]: 1 }) },
      radius: radiusForMass(mass),
      color: cell.color,
      accent: cell.accent,
      alive: cell.alive,
      boost: cell.boost,
      mergeAt: cell.mergeAt,
      launchX: cell.launchX,
      launchY: cell.launchY,
      botTeam: cell.botTeam,
      splitCooldown: cell.splitCooldown,
      splitLineX: cell.splitLineX,
      splitLineY: cell.splitLineY,
      splitLineUntil: cell.splitLineUntil,
      splitLineUntilEpoch: splitLineRemaining ? Date.now() + splitLineRemaining : 0,
      invulnerableUntil: cell.invulnerableUntil,
      virusImmuneUntil: cell.virusImmuneUntil,
      targetX: cell.targetX,
      targetY: cell.targetY,
      think: cell.think,
    };
  }

  function normalizeNetworkCell(cell) {
    const normalized = { ...cell };
    const epochUntil = Number(normalized.splitLineUntilEpoch) || 0;
    if (epochUntil > 0) {
      normalized.splitLineUntil = performance.now() + Math.max(0, Math.min(1000, epochUntil - Date.now()));
    } else if (Number(normalized.splitLineUntil) > Date.now() - 10000) {
      normalized.splitLineUntil = performance.now() + Math.max(0, Math.min(1000, Number(normalized.splitLineUntil) - Date.now()));
    }
    delete normalized.splitLineUntilEpoch;
    return normalized;
  }

  function cellsForNetwork(cells) {
    const usedIds = new Set();
    return cells.map(cell => {
      if (!cell.netId || usedIds.has(cell.netId)) {
        cell.netId = `${session ? session.id : "local"}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
      }
      usedIds.add(cell.netId);
      return cellForNetwork(cell);
    });
  }

  function ejectedForNetwork(pellet) {
    if (!pellet.netId) pellet.netId = `${session.id}-feed-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    pellet._networkShared = true;
    pellet._pendingNetworkAt = pellet._pendingNetworkAt || performance.now();
    return {
      netId: pellet.netId,
      x: Number(pellet.x) || 0,
      y: Number(pellet.y) || 0,
      vx: Number(pellet.vx) || 0,
      vy: Number(pellet.vy) || 0,
      value: Number(pellet.value) || 2.2,
      r: Number(pellet.r) || 8,
      startX: Number(pellet.startX) || Number(pellet.x) || 0,
      startY: Number(pellet.startY) || Number(pellet.y) || 0,
      ownerCellId: pellet.ownerCellId || "",
      dirX: pellet.dirX,
      dirY: pellet.dirY,
      targetX: pellet.targetX,
      targetY: pellet.targetY,
      sourceX: pellet.sourceX,
      sourceY: pellet.sourceY,
      sourceMass: pellet.sourceMass,
      debits: playerCells.filter(cell => cell.alive && cell._pendingFeedCosts?.[pellet.netId] > 0)
        .map(cell => ({netId:cell.netId,cost:cell._pendingFeedCosts[pellet.netId]})),
      color: pellet.color,
    };
  }

  function applyOwnCells(serverCells, sentCells = []) {
    if (!Array.isArray(serverCells) || !serverCells.length || !running) return;
    const current = new Map(playerCells.map(cell => [cell.netId, cell]));
    const sent = new Map(sentCells.map(cell => [cell.netId, cell]));
    const unsent = playerCells.filter(cell => cell.alive && !sent.has(cell.netId));
    const massCorrections = new Map(serverCells.filter(cell => sent.has(cell.netId)).map(cell => [cell.netId, cell.mass - sent.get(cell.netId).mass]));
    playerCells = serverCells.filter(serverCell => {
      if (sent.has(serverCell.netId) && !current.has(serverCell.netId)) {
        return false;
      }
      return true;
    }).map(serverCell => {
      const normalized = normalizeNetworkCell(serverCell);
      const existing = current.get(normalized.netId);
      if (existing) {
        const unchangedShape = !existing._syncMassWeights || existing._syncMassWeights[existing.netId] === 1 && Object.keys(existing._syncMassWeights).length === 1;
        const baseline = sent.get(existing.netId);
        if (unchangedShape && baseline && Number.isFinite(baseline.x) && Number.isFinite(baseline.y)) {
          existing.x += normalized.x - baseline.x;
          existing.y += normalized.y - baseline.y;
        }
        return {
          ...existing,
          vx: existing.vx,
          vy: existing.vy,
          alive: normalized.alive,
          color: normalized.color,
          accent: normalized.accent,
          isPlayer: true,
          botTeam: null,
        };
      }
      return {
        ...normalized,
        isPlayer: true,
        botTeam: null,
      };
    });
    playerCells.push(...unsent.filter(cell => !playerCells.some(other => other.netId === cell.netId)));
    // A response describes the pre-split cells. Carry its mass delta through local splits/merges.
    for (const cell of playerCells) {
      const weights = cell._syncMassWeights || { [cell.netId]: 1 };
      let correction = 0;
      for (const [id, weight] of Object.entries(weights)) correction += (massCorrections.get(id) || 0) * weight;
      cell.mass = Math.max(.000001, cell.mass + correction);
      cell.radius = radiusForMass(cell.mass);
    }
    player = playerCells.find(cell => cell.alive) || playerCells[0] || player;
  }

  function settleFeedPredictions(ids) {
    for (const cell of playerCells) {
      const costs = { ...cell._pendingFeedCosts };
      for (const id of ids) {
        cell.mass += costs[id] || 0;
        delete costs[id];
      }
      cell._pendingFeedCosts = costs;
      cell.radius = radiusForMass(cell.mass);
    }
  }

  function mergeNetworkCell(current, incoming) {
    incoming = normalizeNetworkCell(incoming);
    const now = performance.now();
    const sample = {time:now,x:incoming.x,y:incoming.y};
    if (!current) {
      return {
        ...incoming,
        _netTargetX: incoming.x,
        _netTargetY: incoming.y,
        _netTargetMass: incoming.mass,
        _netTargetRadius: incoming.radius,
        _netSamples: [sample],
        _netSpacing: 100,
      };
    }
    const x = current.x;
    const y = current.y;
    const mass = current.mass;
    const radius = current.radius;
    const samples = current._netSamples || [];
    const interval = samples.length ? now-samples[samples.length-1].time : 100;
    const spacing = Math.max(50,Math.min(500,(current._netSpacing||100)*.7+interval*.3));
    Object.assign(current, incoming);
    current.x = x;
    current.y = y;
    current.mass = mass;
    current.radius = radius;
    current._netSamples = [...samples.slice(-11),sample];
    current._netSpacing = spacing;
    current._netTargetX = incoming.x + (Number(incoming.vx) || 0) * .07;
    current._netTargetY = incoming.y + (Number(incoming.vy) || 0) * .07;
    current._netTargetMass = incoming.mass;
    current._netTargetRadius = incoming.radius;
    return current;
  }

  // A compact bot is [id, team, x, y, mass, vx, vy]; its name and colours come from the team table.
  function decodeBot(entry) {
    if (!Array.isArray(entry)) return entry;
    const [netId, team, x, y, mass, vx, vy] = entry;
    const [name, color, accent] = botTeamInfo.get(team) || [team, "#55d6ff", "#ffffff"];
    return { netId, botTeam: team, name, color, accent, x, y, mass, radius: radiusForMass(mass), vx, vy, alive: true };
  }

  // A compact piece of another player is [id, x, y, mass, vx, vy].
  function decodeRemoteCell(entry) {
    if (!Array.isArray(entry)) return entry;
    const [netId, x, y, mass, vx, vy] = entry;
    return { netId, x, y, mass, radius: radiusForMass(mass), vx, vy, alive: true };
  }

  // Tells the server the newest pellet this game already has, so it only sends newer ones.
  function newestPelletSeq() {
    let newest = 0;
    for (const pellet of ejected) if (pellet && pellet._serverConfirmed && Number(pellet.seq) > newest) newest = Number(pellet.seq);
    return newest;
  }

  function applyWorld(world, forceOwnerCorrection = false, preserveLocalMapSize = false) {
    if (!world) return;
    lastWorld = world;
    const previousMapSize = worldSize;
    if (!preserveLocalMapSize) worldSize = Math.max(5200, Number(world.worldSize) || 5200);
    if (worldSize !== previousMapSize) rebuildSharedFood();
    updateMapSizeLabel();
    if (world.teams && typeof world.teams === "object") {
      botTeamInfo = new Map(Object.entries(world.teams));
      teamsSig = String(world.teamsSig || "");
    }
    if (Array.isArray(world.bots)) {
        const currentBots = new Map(bots.map(bot => [bot.netId, bot]));
        bots = world.bots.map(decodeBot).map(bot => ({
          ...mergeNetworkCell(currentBots.get(bot.netId), bot),
          isPlayer: false,
        }));
    }
    // The spike list only comes when it changed; spikes this player just popped stay hidden until the server agrees.
    if (Array.isArray(world.viruses)) {
      serverViruses = world.viruses;
      spikesSig = String(world.spikesSig || "");
    }
    {
      const now = performance.now();
      for (const [id, until] of poppedVirusIds) if (until < now) poppedVirusIds.delete(id);
      viruses = serverViruses.filter(virus => !poppedVirusIds.has(virus.id));
    }
    if (typeof world.autoSpikes === "boolean" && world.autoSpikes !== autoSpikesOn) setAutoSpikesLabel(world.autoSpikes);
    if (typeof world.botsOff === "boolean" && world.botsOff !== botsRemoved) setRemoveBotsLabel(world.botsOff);
    if (Array.isArray(world.ejected)) {
      const nextEjected = new Map();
      const localPending = ejected.filter(pellet => (
        pellet &&
        pellet.netId &&
        !pellet._serverConfirmed &&
        Number.isFinite(pellet.x) &&
        Number.isFinite(pellet.y)
      ));
      const serverIds = new Set(world.ejected.map(pellet => pellet.netId));
      // Compact updates only send new pellets plus the numbers of all pellets still in the air:
      // keep the ones we already have that are still in the air.
      const live = Array.isArray(world.ejectedLive) ? new Set(world.ejectedLive) : null;
      const kept = live ? ejected.filter(pellet => pellet && pellet._serverConfirmed && live.has(pellet.seq) && !serverIds.has(pellet.netId)) : [];
      const fresh = world.ejected.map(pellet => {
        const current = ejectedCache.get(pellet.netId) || ejected.find(local => local.netId === pellet.netId);
        const serverCreatedAt = Number(pellet.createdAt) || Date.now();
        const age = Math.max(0, (Date.now() - serverCreatedAt) / 1000);
        const serverOwnerUntil = Number(pellet.ownerUntil) || 0;
        const localCreatedAt = serverCreatedAt > 1000000000000 ? performance.now() - age * 1000 : serverCreatedAt;
        const localOwnerUntil = serverOwnerUntil > 1000000000000
          ? performance.now() + Math.max(0, serverOwnerUntil - Date.now())
          : serverOwnerUntil;
        const shared = {
          ...(current || pellet),
          ...pellet,
          createdAt: current?.createdAt ?? localCreatedAt,
          ownerUntil: localOwnerUntil,
          _networkShared: true,
          _serverConfirmed: true,
        };
        BlobPhysics.moveFeed(shared,networkDelay,worldSize);
        // Keep the already animated trajectory; snapshots only confirm its lifetime.
        if (current) for (const key of [...BlobPhysics.feeding.motionFields,"feedDrag"]) {
          if (current[key] !== undefined) shared[key]=current[key];
        }
        shared.drawX=current?(current.drawX??current.x):shared.x;
        shared.drawY=current?(current.drawY??current.y):shared.y;
        nextEjected.set(shared.netId, shared);
        return shared;
      });
      for (const pellet of kept) nextEjected.set(pellet.netId, pellet);
      ejected = [...kept, ...fresh];
      for (const pellet of localPending) {
        if (!pellet || !pellet.netId || serverIds.has(pellet.netId)) continue;
        const pendingAt = Number(pellet._pendingNetworkAt) || Number(pellet.createdAt) || 0;
        if (performance.now() - pendingAt > 1200) continue;
        nextEjected.set(pellet.netId, pellet);
        ejected.push(pellet);
      }
      ejectedCache = nextEjected;
    }
  }

  // Brings the shared food up to date: a full copy when joining, otherwise just the bites since last time.
  // Bites this player made that the server has not seen yet are kept, so an older update never
  // brings back a dot that was already eaten here (which would get eaten and counted twice).
  function applyFoodSync(sync) {
    if (!sync || !Number.isInteger(sync.seed)) return;
    const unsent = new Set(foodClaims.map(claim => claim[0]));
    if (typeof sync.full === "string") {
      const bytes = Uint8Array.from(atob(sync.full), character => character.charCodeAt(0));
      sharedFoodSeed = sync.seed;
      sharedFoodVersions = new Uint8Array(BlobPhysics.food.count);
      sharedFoodVersions.set(bytes.subarray(0, BlobPhysics.food.count));
      for (const [index, version] of foodClaims) {
        if (sharedFoodVersions[index] === version) sharedFoodVersions[index] = (version + 1) & 255;
      }
      sharedFoodRevision = sync.revision;
      rebuildSharedFood();
      return;
    }
    if (sync.seed !== sharedFoodSeed || !sharedFoodVersions) return;
    for (const change of Array.isArray(sync.changes) ? sync.changes : []) {
      const index = change[0], version = change[1];
      if (!(index >= 0 && index < sharedFoodVersions.length) || sharedFoodVersions[index] === version) continue;
      const localLead = (sharedFoodVersions[index] - version) & 255;
      if (unsent.has(index) && localLead > 0 && localLead < 128) continue;
      sharedFoodVersions[index] = version;
      replaceFoodDot(index, sharedFoodDot(index));
    }
    sharedFoodRevision = sync.revision;
  }

  function applyBotMassOnly(world) {
    if (!world || !Array.isArray(world.bots)) return;
    const byId = new Map(bots.map(bot => [bot.netId, bot]));
    for (const entry of world.bots) {
      const serverBot = Array.isArray(entry) ? { netId: entry[0], mass: entry[4] } : entry;
      const bot = byId.get(serverBot.netId);
      if (!bot || !bot.alive) continue;
      const mass = Number(serverBot.mass);
      if (!Number.isFinite(mass)) continue;
      bot._netTargetMass = mass;
      bot._netTargetRadius = radiusForMass(mass);
    }
  }

  function applyRemotePlayers(players) {
    const nextCache = new Map();
    const nextCells = [];
    for (const remote of players || []) {
      if (remote.running === false) continue;
      for (const cell of (remote.cells || []).map(decodeRemoteCell)) {
        if (!cell.alive) continue;
        const key = `${remote.id}:${cell.netId}`;
        const networkCell = mergeNetworkCell(remoteCellCache.get(key), cell);
        Object.assign(networkCell, {
          name: remote.name || cell.name || "PLAYER",
          color: remote.color || cell.color,
          accent: lightenColor(remote.color || cell.color || "#55d6ff", 55),
          isPlayer: false,
          isRemote: true,
          remoteSessionId: remote.id,
          role: remote.role || null,
          botTeam: `remote-${remote.id}`,
          skin: remote.skin || "",
        });
        nextCache.set(key, networkCell);
        nextCells.push(networkCell);
      }
    }
    remoteCellCache = nextCache;
    remotePlayerCells = nextCells;
  }

  function smoothNetworkCell(cell, dt) {
    if (!Number.isFinite(cell._netTargetX)) return;
    const positionEase = 1 - Math.exp(-dt * 14);
    const sizeEase = 1 - Math.exp(-dt * 11);
    const samples = cell._netSamples;
    if (samples?.length > 1) {
      const renderTime = performance.now()-Math.max(70,Math.min(150,cell._netSpacing*1.2));
      let before=samples[0], after=samples[samples.length-1];
      for (let i=1;i<samples.length;i++) {
        if(samples[i].time>=renderTime){before=samples[i-1];after=samples[i];break;}
        before=samples[i];
      }
      const span=after.time-before.time;
      const blend=span>0?Math.max(0,Math.min(1,(renderTime-before.time)/span)):1;
      const ahead=Math.max(0,Math.min(.2,(renderTime-after.time)/1000));
      cell.x=before.x+(after.x-before.x)*blend+(Number(cell.vx)||0)*ahead;
      cell.y=before.y+(after.y-before.y)*blend+(Number(cell.vy)||0)*ahead;
    } else {
      cell.x += (cell._netTargetX - cell.x) * positionEase;
      cell.y += (cell._netTargetY - cell.y) * positionEase;
    }
    cell.mass += (cell._netTargetMass - cell.mass) * sizeEase;
    cell.radius += (cell._netTargetRadius - cell.radius) * sizeEase;
  }

  function smoothNetworkEntities(dt) {
    remotePlayerCells.forEach(cell => smoothNetworkCell(cell, dt));
    bots.forEach(bot => smoothNetworkCell(bot, dt));
  }

  const ROLE_LABELS = {owner: "OWNER", host: "SERVER OWNER", admin: "ADMIN", serveradmin: "ADMIN"};
  function updateAdminAccess() {
    isAdmin = Boolean(session && session.isAdmin);
    adminRole = isAdmin ? (session.adminRole || "admin") : null;
    document.querySelector("#botBanOptions").hidden = !isAdmin;
    if (!isAdmin) document.querySelector("#moderationMenu").classList.add("hidden");
    // Signing in or out changes the wallet: refresh the shop if it is open.
    if (!document.querySelector("#shopTab").hidden && Boolean(account) !== Boolean(shopState?.signedIn)) loadShop();
    document.querySelector("#mobileRole").textContent = ROLE_LABELS[adminRole] || "GUEST";
    adminShortcut.classList.toggle("hidden", !isAdmin);
    adminShortcut.classList.toggle("inactive", !isAdmin || !running);
    if (!isAdmin) ui.admin.classList.add("hidden");
    const account = session && session.account;
    const role = adminRole === "owner" ? "OWNER / ADMIN" : adminRole === "host" ? "SERVER OWNER (ADMIN ON THIS SERVER)" : adminRole === "admin" ? "ADMIN (EVERY SERVER)" : adminRole === "serveradmin" ? "ADMIN ON THIS SERVER" : "PLAYER";
    document.querySelector("#adminUnlockStatus").textContent = account
      ? `Signed in as ${account.username} - ${role}` : `Playing as guest${adminRole ? ` - ${role}` : ""}. Sign in or create an account.`;
    document.querySelector("#accountLogout").hidden = !account;
    // CHAT: guests can read it; signing in lets you write.
    document.querySelector("#chatInput").hidden = !account;
    document.querySelector("#chatGuestNote").hidden = Boolean(account);
    document.querySelector("#accountTools").hidden = !account;
    document.querySelector("#ownerReset").hidden = !(account && account.isAdmin);
    updateServerAdmin();
    document.querySelector("#accountLogin").hidden = Boolean(account);
    document.querySelector("#accountRegister").hidden = Boolean(account);
    document.querySelector("#accountUsername").disabled = Boolean(account);
    document.querySelector("#accountPassword").disabled = Boolean(account);
  }

  let accountBusy = false;
  async function accountAction(action) {
    const message = document.querySelector("#adminUnlockStatus");
    if (!session) { message.textContent = "Server is connecting. Try again in a moment."; return; }
    if (accountBusy) return;
    accountBusy = true;
    document.querySelectorAll(".account-actions button").forEach(button => { button.disabled = true; });
    try {
      const response = await fetch(`/api/accounts/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: session.id, sessionKey: session.sessionKey,
          username: document.querySelector("#accountUsername").value,
          password: document.querySelector("#accountPassword").value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      session.isAdmin = result.isAdmin;
      session.adminRole = result.adminRole || null;
      session.account = result.account;
      roomTransport.reset();
      updateAdminAccess();
      document.querySelector("#accountPassword").value = "";
    } catch (error) {
      message.textContent = error.message || "Unable to connect to server.";
    } finally {
      accountBusy = false;
      document.querySelectorAll(".account-actions button").forEach(button => { button.disabled = false; });
    }
  }
  async function passwordAction(route, fields, done) {
    const message = document.querySelector("#adminUnlockStatus");
    if (!session) { message.textContent = "Server is connecting. Try again in a moment."; return; }
    if (accountBusy) return;
    accountBusy = true;
    try {
      const response = await fetch(route, {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({id: session.id, sessionKey: session.sessionKey, ...fields})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      done(result);
    } catch (error) {
      message.textContent = error.message || "Unable to connect to server.";
    } finally {
      accountBusy = false;
    }
  }
  document.querySelector("#changePassword").addEventListener("click", () => passwordAction("/api/accounts/password", {
    currentPassword: document.querySelector("#currentPassword").value, newPassword: document.querySelector("#newPassword").value,
  }, () => {
    document.querySelector("#currentPassword").value = "";
    document.querySelector("#newPassword").value = "";
    document.querySelector("#accountTools").open = false;
    roomTransport.reset();
    document.querySelector("#adminUnlockStatus").textContent = "Password changed. Any other browser signed in to this account is now signed out.";
  }));
  document.querySelector("#resetPlayerPassword").addEventListener("click", () => passwordAction("/api/admin/reset-password", {
    username: document.querySelector("#resetUsername").value, newPassword: document.querySelector("#resetPassword").value,
  }, result => {
    document.querySelector("#resetPassword").value = "";
    document.querySelector("#adminUnlockStatus").textContent = `Password for ${result.reset} was reset. Give them the temporary password and ask them to change it.`;
  }));
  document.querySelector("#accountLogin").addEventListener("click", () => accountAction("login"));
  document.querySelector("#accountRegister").addEventListener("click", () => accountAction("register"));
  document.querySelector("#accountLogout").addEventListener("click", () => accountAction("logout"));
  document.querySelector("#accountPassword").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      accountAction("login");
    }
  });

  // ---- Servers ----
  // The server this tab plays on. It is remembered for the tab, so a refresh stays on the same server.
  // A private server gives a "pass" after the right password, so rejoining doesn't need the password again.
  const MAIN_SERVER = {id: "main", name: "MAIN SERVER", pass: null};
  let currentServer = MAIN_SERVER;
  try {
    const saved = JSON.parse(sessionStorage.getItem("splitflux-server") || "null");
    if (saved && typeof saved.id === "string" && typeof saved.name === "string") currentServer = saved;
  } catch {}
  function rememberServer() {
    try { sessionStorage.setItem("splitflux-server", JSON.stringify(currentServer)); } catch {}
    document.querySelector("#currentServerName").textContent = currentServer.name;
    const label = document.querySelector("#serverLabel");
    label.textContent = currentServer.name;
    label.hidden = false;
  }

  // Starts a player session on a server. Throws with the server's reason (wrong password, closed, full, banned).
  async function openSession(server, password) {
    let response;
    if (server.id === "main") {
      const ownerKey = new URLSearchParams(location.search).get("owner") || "";
      response = await fetch(`/api/session${ownerKey ? `?owner=${encodeURIComponent(ownerKey)}` : ""}`, {cache: "no-store"});
    } else {
      response = await fetch("/api/session", {method: "POST", cache: "no-store", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({room: server.id, pass: server.pass || undefined, password: password || undefined})});
    }
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(answer.error || "The room server did not answer."), answer, {status: response.status});
    return answer;
  }

  async function createSession() {
    let next;
    try {
      next = await openSession(currentServer);
    } catch (error) {
      if (error.bannedUntil && currentServer.id === "main") { showBan(error.bannedUntil); session = null; return; }
      if (currentServer.id === "main" || error.full) throw error;
      // That server was stopped, closed, restarted, or can't be reached (backup mode only has the main server):
      // back to the main menu on the main server, with an announcement saying why.
      currentServer = MAIN_SERVER;
      if (error.stopped) {
        if (running) returnToMainMenu();
        showGameNotice("The server owner or an admin has stopped this server. You're back on the main server.", 9000, true);
      } else showGameNotice(error.roomGone ? "That server closed. You're back on the main server." : "You're back on the main server.", 5000);
      await createSession();
      return {moved: error.stopped ? "stopped" : "closed"};
    }
    useSession(next, currentServer);
    return {moved: null};
  }

  async function joinServer(server, password) {
    const next = await openSession(server, password);
    if (running) returnToMainMenu();
    useSession(next, server);
  }

  function useSession(next, server) {
    const changedServer = server.id !== currentServer.id;
    session = next;
    currentServer = {id: server.id, name: next.server?.name || server.name, pass: next.pass || server.pass || null, maxPlayers: next.server?.maxPlayers};
    rememberServer();
    if (changedServer || !lastWorld) {
      // A different server: forget everything about the old arena.
      bots = []; viruses = []; serverViruses = []; remotePlayerCells = []; remoteCellCache = new Map(); lastWorld = null;
      teamedBots = new Set(); followedBotTeam = null; botFollowTargets = new Map(); bannedBotTeams = new Set();
      foodClaims = []; virusPops = [];
    }
    roomTransport.reset();
    roomTransport.connect(session);
    networkRevision = 0;
    worldRevision = 0;
    botRevision = 0;
    botMassRevision = 0;
    teamRevision = 0;
    forceMenuVersion = 0;
    pendingFeedCommands.clear();
    ejected = [];
    ejectedCache.clear();
    botTeamInfo = new Map();
    teamsSig = "";
    spikesSig = "";
    walletSig = "";
    // A new connection (or another server) gets that server's recent chat again.
    lastChatSeq = 0;
    document.querySelector("#chatLog").replaceChildren();
    updateAdminAccess();
    connected = true;
    if (isAdmin) {
      adminShortcut.classList.remove("hidden");
      if (running) adminShortcut.classList.remove("inactive");
    } else {
      adminShortcut.classList.add("hidden", "inactive");
      ui.admin.classList.add("hidden");
    }
    status.innerHTML = `<i class="status-dot"></i> ONLINE - ${ROLE_LABELS[adminRole] || "GUEST"}`;
  }

  async function syncRoom() {
    if (currentBanUntil>Date.now()) return;
    if (!session || syncing) return;
    // About 10 updates a second while playing (the game smooths movement in between), one every 1.5 s on
    // the menu, and one every 3 s while the tab is hidden: enough to keep the place in the arena.
    // Without the live connection (backup mode: every update is a Vercel call plus a database save) it is 5 a second.
    const interval = document.hidden ? 3000 : running ? (roomTransport.realtime ? 100 : 200) : 1500;
    if (performance.now() - lastSyncAt < interval) return;
    lastSyncAt = performance.now();
    syncing = true;
    try {
      const payload = {
        id: session.id,
        sessionKey: session.sessionKey,
        running,
        name: (player && player.name) || ui.name.value || "PLAYER",
        color: playerColor,
        score,
        immune: isAdmin && botImmunity,
        cursor: cursorWorldPosition(),
        botFeeding: running && Boolean(followedBotTeam) && Boolean(keys.KeyT),
        botSplitCommands: [...pendingBotSplitCommands].slice(0,8),
        ackRevision: networkRevision,
        ackWorldRevision: worldRevision,
        ackBotRevision: botRevision,
        ackBotMassRevision: botMassRevision,
        cells: running ? cellsForNetwork(playerCells.filter(cell => cell.alive)) : [],
        ejectedAdditions: running
          ? [...pendingFeedCommands.values()].slice(0, 80).map(ejectedForNetwork)
          : [],
        foodClaims: running ? foodClaims.slice(0, 600) : [],
        virusPops: running ? virusPops.slice(0, 16) : [],
        foodSeed: sharedFoodSeed,
        ackFoodRevision: sharedFoodRevision,
        view: 2,
        ackTeams: teamsSig,
        ackSpikes: spikesSig,
        ackEjected: newestPelletSeq(),
        ackAnnouncement: lastAnnouncementId,
        ackWallet: walletSig,
        ackChat: lastChatSeq,
      };
      for (const cell of playerCells) cell._syncMassWeights = { [cell.netId]: 1 };
      const sentMapSize = worldSize;
      const requestAt=performance.now();
      if(!roomTransport.realtime)roomTransport.connect(session);
      const response = await roomTransport.state(payload);
      if (response.status === 401) {
        // The server forgot this player (idle tab or restart), so it no longer knows their size.
        // End the round cleanly instead of silently shrinking them back to a starting cell.
        const lostRound = running;
        // If the arena is full or waking up, wait 3 s before asking again instead of every update.
        let result;
        try { result = await createSession(); } catch (error) { lastSyncAt = performance.now() + 3000; throw error; }
        if (result?.moved === "stopped") return;
        if (lostRound && session) {
          returnToMainMenu();
          document.querySelector("#adminUnlockStatus").textContent = "Connection to the arena was lost, so that round ended. Deploy again to keep playing.";
        }
        return;
      }
      if (response.status===403) {
        const blocked=await response.json();
        if (blocked.bannedUntil && currentServer.id !== "main") {
          // Banned from a made server: go back to the main server instead of the ban screen.
          currentServer = MAIN_SERVER;
          await createSession();
          returnToMainMenu();
          showGameNotice("You were banned from that server.", 6000);
          return;
        }
        if (blocked.bannedUntil) {showBan(blocked.bannedUntil);return;}
      }
      if (!response.ok) throw new Error("Room sync failed.");
      const snapshot = await response.json();
      // These bites reached the server (confirmed or not); never send them twice.
      const sentClaims = new Set(payload.foodClaims);
      foodClaims = foodClaims.filter(claim => !sentClaims.has(claim));
      const sentPops = new Set(payload.virusPops);
      virusPops = virusPops.filter(id => !sentPops.has(id));
      applyFoodSync(snapshot.food);
      networkDelay=Math.min(.15,(performance.now()-requestAt)/2000);
      if (snapshot.wallet) applyWallet(snapshot.wallet);
      if (snapshot.chat) applyChat(snapshot.chat);
      for (const text of snapshot.notices || []) showGameNotice(text, 7000, true);
      (snapshot.acceptedBotSplitCommands||[]).forEach(id=>pendingBotSplitCommands.delete(id));
      if (snapshot.botSplitError) showArenaError(new Error(snapshot.botSplitError));
      bannedBotTeams=new Set(snapshot.bannedBotTeams||[]);
      const acceptedFeedIds = new Set(snapshot.acceptedFeedIds || []);
      settleFeedPredictions(acceptedFeedIds);
      acceptedFeedIds.forEach(id => pendingFeedCommands.delete(id));
      ejected.forEach(pellet => { if (acceptedFeedIds.has(pellet.netId)) pellet._serverConfirmed = true; });
      if ((snapshot.teamRevision||0)>=teamRevision) {
        teamRevision=snapshot.teamRevision||0;
        teamedBots = new Set(snapshot.teamedBots || []);
        followedBotTeam = snapshot.followedBotTeam || null;
      }
      botFollowTargets = new Map((snapshot.botControllers || []).map(entry => [entry.team, {x:entry.x,y:entry.y}]));
      if (!accountBusy && (session.isAdmin !== snapshot.isAdmin || (session.adminRole || null) !== (snapshot.adminRole || null) || JSON.stringify(session.account) !== JSON.stringify(snapshot.account))) {
        const before = session.adminRole || null, after = snapshot.adminRole || null;
        if (after === "host" && before !== "host") showGameNotice("You are now the server owner. Press P for the admin panel (you can stop the server or change its player limit).", 7000);
        else if (before === "host" && after === "admin") showGameNotice("You are no longer the server owner, but you are still an admin here.", 6000);
        else if (snapshot.isAdmin && !session.isAdmin) showGameNotice("You are now an admin on this server. Press P for the admin panel.", 6000);
        else if (!snapshot.isAdmin && session.isAdmin) showGameNotice("You are no longer an admin on this server.", 5000);
        session.isAdmin = snapshot.isAdmin;
        session.adminRole = snapshot.adminRole || null;
        session.account = snapshot.account;
        updateAdminAccess();
      }
      connected = true;
      const receivedNetworkRevision = Number(snapshot.self && snapshot.self.revision) || 0;
      const receivedWorldRevision = Number(snapshot.worldRevision) || 0;
      const receivedBotRevision = Number(snapshot.botRevision) || 0;
      const receivedBotMassRevision = Number(snapshot.botMassRevision) || 0;
      const hasPlayerCorrection = receivedNetworkRevision > networkRevision;
      const hasBotCorrection = receivedBotRevision > botRevision;
      const hasBotMassCorrection = receivedBotMassRevision > botMassRevision;
      networkRevision = receivedNetworkRevision;
      worldRevision = receivedWorldRevision;
      botRevision = receivedBotRevision;
      botMassRevision = receivedBotMassRevision;
      const nextForceMenuVersion = Number(snapshot.self && snapshot.self.forceMenuVersion) || 0;
      if (nextForceMenuVersion > forceMenuVersion) {
        forceMenuVersion = nextForceMenuVersion;
        returnToMainMenu();
      }
      lastPlayerCount = snapshot.playerCount || 1;
      // An announcement from the owner or a real admin: shown big on everyone's screen, once.
      if (snapshot.announcement && snapshot.announcement.id !== lastAnnouncementId) {
        lastAnnouncementId = snapshot.announcement.id;
        showGameNotice(`ANNOUNCEMENT FROM ${String(snapshot.announcement.from).toUpperCase()}: ${snapshot.announcement.text}`, 10000, true);
        document.querySelector("#gameNotice")?.classList.add("announcement");
      }
      // Another admin may have changed this server's player limit.
      if (snapshot.server && snapshot.server.id === currentServer.id && snapshot.server.maxPlayers !== currentServer.maxPlayers) {
        currentServer.maxPlayers = snapshot.server.maxPlayers;
        updateServerAdmin();
      }
      if (hasPlayerCorrection) applyOwnCells(snapshot.self && snapshot.self.cells, payload.cells);
      applyRemotePlayers(snapshot.players);
      applyWorld(snapshot.world || lastWorld, hasBotCorrection, isAdmin && worldSize !== sentMapSize);
      if (!hasBotCorrection && hasBotMassCorrection) applyBotMassOnly(snapshot.world || lastWorld);
      status.innerHTML = `<i class="status-dot"></i> ${roomTransport.realtime?"LIVE":"ONLINE"} - ${lastPlayerCount} PLAYER${lastPlayerCount === 1 ? "" : "S"}`;
      if (snapshot.self && snapshot.self.dead && running) endGame();
    } catch (error) {
      connected = false;
      status.innerHTML = '<i class="status-dot"></i> RECONNECTING';
    } finally {
      syncing = false;
    }
  }

  update = function multiplayerUpdate(dt) {
    if (!running) return;
    updatePlayer(dt);
    handleViruses();
    playerCells.filter(cell => cell.alive).forEach(eatFood);
    updateEjected(dt);
    updateParticles(dt);
    const center = playerCenter();
    player = playerCells.find(cell => cell.alive) || player;
    const naturalZoom = clamp(1.15 / Math.pow(center.mass / 28, .16), .38, 1.05);
    const targetZoom = Math.max(Number.MIN_VALUE, naturalZoom * manualZoom);
    camera.zoom += (targetZoom - camera.zoom) * Math.min(1, dt * 3);
    camera.x += (center.x - camera.x) * Math.min(1, dt * 4);
    camera.y += (center.y - camera.y) * Math.min(1, dt * 4);
    smoothNetworkEntities(dt);
    updateUI();
  };

  updateEjected = function multiplayerEjectedUpdate(dt) {
    baseUpdateEjected(dt);
  };

  render = function multiplayerRender(time) {
    const localBots = bots;
    bots = [...localBots, ...remotePlayerCells];
    baseRender(time);
    bots = localBots;
  };

  async function joinRoom(){
    try{await createSession();}catch(error){
      status.innerHTML = `<i class="status-dot"></i> ${error.full ? "ARENA FULL" : "WAKING SERVER"} - RETRYING`;
      setTimeout(joinRoom,3000);
    }
  }
  joinRoom();

  window.killEveryoneOnline = async function killEveryoneOnline() {
    if (!session || !isAdmin) return;
    const button = document.querySelector("#killEveryone");
    try {
      const response = await fetch("/api/admin/kill-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: session.id, sessionKey: session.sessionKey }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Admin command rejected");
      const result = await response.json();
      bots = [];
      botRespawnPausedUntil = performance.now() + 5000;
      button.textContent = `WIPED ${result.killed} PLAYERS + ${result.botsKilled} BOTS`;
      setTimeout(() => { button.textContent = "KILL EVERYONE"; }, 1400);
      syncRoom();
    } catch {
      button.textContent = "COMMAND FAILED";
      setTimeout(() => { button.textContent = "KILL EVERYONE"; }, 1400);
    }
  };

  window.setBotTeamOnline = async function(team, enabled) {
    if (!session) throw new Error("Not connected");
    const response = await fetch("/api/team", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, sessionKey: session.sessionKey, team, enabled }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error||"Team request failed");
    teamRevision=result.teamRevision||0;
    teamedBots = new Set(result.teamedBots);
    followedBotTeam=result.followedBotTeam||null;
  };

  window.setBotFollowOnline = async function(team) {
    if (!session) throw new Error("Not connected");
    const response = await fetch("/api/follow-bot", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: session.id, sessionKey: session.sessionKey, team }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Follow request failed");
    followedBotTeam = result.followedBotTeam;
  };

  async function adminCommand(route, command) {
    if (!session || !isAdmin) throw new Error("Admin access required");
    const response=await fetch(`/api/admin/${route}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:session.id,sessionKey:session.sessionKey,view:2,...command})});
    const result=await response.json();
    if (!response.ok) throw new Error(result.error||"Admin command failed");
    return result;
  }
  window.banPlayerOnline=async(target,durationMs)=>adminCommand("ban",{...target,durationMs});
  window.promotePlayerOnline=async(targetId,admin)=>adminCommand("promote",{targetId,admin});
  window.paintSpikesOnline=async(points)=>{
    const result=await adminCommand("paint-spikes",{points});
    serverViruses=result.viruses;
    viruses=result.viruses;
    return result;
  };
  window.configureArenaOnline=async(command)=>{
    const result=await adminCommand("arena",command);
    const oldSize=worldSize;
    applyWorld(result.world,true);
    if (worldSize!==oldSize) {
      const scale=worldSize/oldSize;
      // Shared food was already re-laid for the new size by applyWorld.
      if (!sharedFoodVersions) food.forEach(dot=>{dot.x*=scale;dot.y*=scale;});
      playerCells.forEach(cell=>{cell.x*=scale;cell.y*=scale;});
      camera.x*=scale;camera.y*=scale;
      saveMapSizePreference(worldSize);
    }
    return result;
  };

  // ---- SERVERS tab ----
  const serverMessage = text => { document.querySelector("#serverMessage").textContent = text; };
  function showMenuTab(tab) {
    for (const [name, panel, id] of [["play", "#playTab", "#tabPlay"], ["servers", "#serversTab", "#tabServers"], ["shop", "#shopTab", "#tabShop"]]) {
      const active = tab === name;
      document.querySelector(panel).hidden = !active;
      const button = document.querySelector(id);
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
    if (tab === "servers") loadServers();
    if (tab === "shop") { renderShop(); loadShop(); }
  }

  // ---- SHOP tab ----
  // shopState is the server's answer: {signedIn, coins, unsaved (a guest's coins), owned: [skin ids], skin, ownsAll}.
  // The server decides everything (prices, who owns what); this only shows it and sends BUY / WEAR clicks.
  const shopMessage = text => { document.querySelector("#shopMessage").textContent = text; };
  function applyWallet(next) {
    walletSig = next.sig || "";
    playerSkin = next.skin || "";
    const shown = (next.coins || 0) + (next.unsaved || 0);
    document.querySelector("#coins").textContent = shown.toLocaleString();
    document.querySelector("#coinStat").hidden = false;
    if (!shopState) return;
    if (Boolean(next.signedIn) !== shopState.signedIn) { loadShop(); return; }
    Object.assign(shopState, {coins: next.coins || 0, unsaved: next.unsaved || 0, skin: next.skin || ""});
    if (!document.querySelector("#shopTab").hidden) renderShop();
  }
  function renderShop() {
    const state = shopState || {signedIn: false, coins: 0, unsaved: 0, owned: [], skin: "", ownsAll: false};
    const coins = state.coins + (state.unsaved || 0);
    document.querySelector("#shopCoins").textContent = coins.toLocaleString();
    document.querySelector("#shopAdminCoins").hidden = !(adminRole === "owner" || adminRole === "admin");
    document.querySelector("#shopNote").textContent = state.ownsAll ? "You're the owner: every skin is yours to wear."
      : !state.signedIn ? (state.unsaved ? `You have ${state.unsaved} unsaved coins. Sign in on the PLAY tab to keep them and buy skins.`
        : "Sign in on the PLAY tab to earn coins and buy skins. Grow to earn: 1 coin for every 10 mass.")
      : isAdmin ? "You don't earn coins on a server where you're an admin (admin powers can change your size)."
      : "Grow to earn coins: 1 coin for every 10 mass you grow past your biggest size in each life.";
    document.querySelector("#shopGrid").replaceChildren(...SkinShop.list.map(skin => {
      const owned = state.owned.includes(skin.id), worn = state.skin === skin.id;
      const card = document.createElement("div");
      card.className = `skin-card tier-${skin.tier}${owned ? " owned" : ""}${worn ? " worn" : ""}`;
      const picture = document.createElement("img");
      picture.src = skin.image; picture.alt = ""; picture.loading = "lazy";
      const name = document.createElement("b"); name.textContent = skin.name;
      const tier = document.createElement("small"); tier.textContent = skin.tier.toUpperCase();
      const button = document.createElement("button");
      button.type = "button"; button.dataset.skin = skin.id;
      if (worn) button.textContent = "TAKE OFF";
      else if (owned) button.textContent = "WEAR";
      else if (confirmBuy === skin.id) { button.textContent = `BUY FOR ${skin.price}?`; button.classList.add("confirm"); }
      else {
        const coin = document.createElement("i"); coin.className = "coin";
        button.append(coin, String(skin.price));
        if (!state.signedIn || state.coins < skin.price) button.classList.add("short");
      }
      card.append(picture, name, tier, button);
      return card;
    }));
  }
  async function shopCommand(route, skin, done, extra = {}) {
    if (!session) { shopMessage("Connecting to the server..."); return false; }
    let ok = false;
    try {
      const response = await fetch(`/api/shop${route ? "/" + route : ""}`, {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({id: session.id, sessionKey: session.sessionKey, skin, ...extra})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The shop isn't available right now.");
      shopState = result;
      playerSkin = result.skin || "";
      walletSig = "";  // the next update brings the new wallet
      if (done) shopMessage(done);
      ok = true;
    } catch (error) { shopMessage(error.message); }
    renderShop();
    return ok;
  }
  function loadShop() { return shopCommand("", ""); }
  // BUY needs two clicks (so a stray click doesn't spend coins); WEAR and TAKE OFF are one click.
  document.querySelector("#shopGrid").addEventListener("click", async event => {
    const button = event.target.closest("button[data-skin]");
    const skin = button && SkinShop.find(button.dataset.skin);
    if (!skin || !shopState) return;
    const owned = shopState.owned.includes(skin.id), worn = shopState.skin === skin.id;
    if (!shopState.signedIn) { shopMessage("Sign in on the PLAY tab to buy and wear skins."); return; }
    if (!owned && confirmBuy !== skin.id) {
      if (shopState.coins < skin.price) { shopMessage(`You need ${skin.price - shopState.coins} more coins for ${skin.name}. Keep growing!`); return; }
      confirmBuy = skin.id;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { confirmBuy = null; renderShop(); }, 4000);
      shopMessage(`Click again to buy ${skin.name} for ${skin.price} coins.`);
      renderShop();
      return;
    }
    confirmBuy = null; clearTimeout(confirmTimer);
    button.disabled = true;
    if (!owned) await shopCommand("buy", skin.id, `You bought ${skin.name}! You're wearing it now.`);
    else await shopCommand("equip", worn ? "" : skin.id, worn ? `You took off ${skin.name}.` : `You're wearing ${skin.name}.`);
  });

  async function loadServers() {
    try {
      const response = await fetch("/api/rooms", {cache: "no-store"});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Servers are not available right now.");
      renderServers(result);
    } catch (error) {
      serverMessage(error.message || "Servers are not available right now.");
    }
  }

  // Server names come from players, so they are only ever put on the page as text.
  function renderServers(result) {
    const list = document.querySelector("#serverList");
    list.replaceChildren(...result.rooms.map(room => {
      const row = document.createElement("li"), info = document.createElement("div"), name = document.createElement("b"), meta = document.createElement("small");
      const here = room.id === currentServer.id;
      row.classList.toggle("here", here);
      name.textContent = room.name;
      for (const tag of [room.private && "PRIVATE", room.mine && "YOURS"].filter(Boolean)) {
        const badge = document.createElement("span"); badge.className = "tag"; badge.textContent = tag; name.append(badge);
      }
      const people = room.main ? `${room.players} playing` : `${room.people}/${room.maxPlayers} players`;
      meta.textContent = [room.main ? "the main arena" : `owner ${room.host}`, people, room.bots ? "bots" : "no bots"].join(" · ");
      info.append(name, meta);
      const join = document.createElement("button");
      join.type = "button";
      join.textContent = here ? "YOU'RE HERE" : "JOIN";
      join.disabled = here;
      join.addEventListener("click", () => {
        const known = currentServer.id === room.id ? currentServer.pass : null;
        if (room.private && !room.mine && !known && !session?.account?.isAdmin) askPassword(row, room);
        else tryJoin(room);
      });
      row.append(info, join);
      return row;
    }));
    document.querySelector("#createServer").disabled = !result.canCreate;
    serverMessage(result.canCreate ? "" : result.reason || `All ${result.max} server slots are in use.`);
  }

  function askPassword(row, room) {
    if (row.querySelector(".password-row")) { row.querySelector(".password-row input").focus(); return; }
    const box = document.createElement("div"), input = document.createElement("input"), go = document.createElement("button");
    box.className = "password-row";
    input.type = "password"; input.maxLength = 64; input.placeholder = "Server password"; input.autocomplete = "off";
    go.type = "button"; go.textContent = "JOIN";
    const submit = () => tryJoin(room, input.value);
    go.addEventListener("click", submit);
    input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); submit(); } });
    box.append(input, go);
    row.append(box);
    input.focus();
  }

  let joining = false;
  async function tryJoin(room, password) {
    if (joining) return;
    joining = true;
    serverMessage(`Joining ${room.name}...`);
    try {
      await joinServer({id: room.id, name: room.name, pass: null}, password);
      serverMessage("");
      showMenuTab("play");
      showGameNotice(`You're on ${currentServer.name}. Press DEPLOY CELL to play.`, 5000);
    } catch (error) {
      serverMessage(error.message);
      if (error.roomGone) loadServers();
    } finally {
      joining = false;
    }
  }

  async function createServer() {
    const button = document.querySelector("#createServer");
    if (button.disabled) return;
    button.disabled = true;
    serverMessage("Making your server...");
    try {
      const response = await fetch("/api/rooms/create", {method: "POST", cache: "no-store", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({name: document.querySelector("#newServerName").value, password: document.querySelector("#newServerPassword").value,
          bots: document.querySelector("#newServerBots").checked, maxPlayers: Number(document.querySelector("#newServerLimit").value)})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Couldn't make the server.");
      document.querySelector("#newServerPassword").value = "";
      document.querySelector("#makeServer").open = false;
      await joinServer({id: result.room.id, name: result.room.name, pass: result.pass});
      showMenuTab("play");
      showGameNotice(`Your server "${currentServer.name}" is ready. You have the admin panel here (press P while playing).`, 6000);
    } catch (error) {
      serverMessage(error.message);
    } finally {
      button.disabled = false;
    }
  }

  // ---- Admin panel: ANNOUNCEMENT (owner and real admins only) ----
  let lastAnnouncementId = null;
  window.onMadeServer = () => currentServer.id !== "main";
  async function sendAnnouncement() {
    const box = document.querySelector("#announceText"), button = document.querySelector("#sendAnnouncement");
    if (!box.value.trim() || button.disabled) return;
    button.disabled = true;
    try {
      await serverCommand("/api/admin/announce", {text: box.value});
      box.value = "";
    } catch (error) { showArenaError(error); }
    finally { button.disabled = false; }
  }
  document.querySelector("#sendAnnouncement").addEventListener("click", sendAnnouncement);
  document.querySelector("#announceText").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendAnnouncement(); }
  });

  // ---- Admin panel: THIS SERVER (made servers only) ----
  function updateServerAdmin() {
    document.querySelector("#announceBox").hidden = !(adminRole === "owner" || adminRole === "admin");
    document.querySelector("#coinBox").hidden = !(adminRole === "owner" || adminRole === "admin");
    const box = document.querySelector("#serverAdmin");
    box.hidden = !(isAdmin && currentServer.id !== "main");
    const input = document.querySelector("#serverLimitInput");
    if (currentServer.maxPlayers && document.activeElement !== input) input.value = currentServer.maxPlayers;
  }

  async function serverCommand(route, fields) {
    if (!session) throw new Error("Not connected yet.");
    const response = await fetch(route, {method: "POST", cache: "no-store", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({id: session.id, sessionKey: session.sessionKey, ...fields})});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "That didn't work.");
    return result;
  }

  async function applyServerLimit() {
    const value = Number(document.querySelector("#serverLimitInput").value);
    try {
      const result = await serverCommand("/api/rooms/limit", {maxPlayers: value});
      currentServer.maxPlayers = result.maxPlayers;
      rememberServer();
      showGameNotice(`Max players is now ${result.maxPlayers}. Nobody already here is removed.`, 4000);
    } catch (error) { showArenaError(error); }
  }

  // Two clicks so nobody stops a server by accident.
  let stopArmedUntil = 0;
  async function stopServer() {
    const button = document.querySelector("#stopServer");
    if (performance.now() > stopArmedUntil) {
      stopArmedUntil = performance.now() + 3000;
      button.textContent = "CLICK AGAIN TO STOP THE SERVER";
      setTimeout(() => { if (performance.now() > stopArmedUntil) button.textContent = "STOP THIS SERVER"; }, 3100);
      return;
    }
    stopArmedUntil = 0;
    button.textContent = "STOP THIS SERVER";
    try {
      await serverCommand("/api/rooms/stop", {});
      // Everyone (this player too) is sent back to the main server with the announcement.
      lastSyncAt = -Infinity;
    } catch (error) { showArenaError(error); }
  }

  // MAKE SERVER OWNER in the player menu: only on made servers, for a player who isn't the server owner yet.
  window.updateServerOwnerButton = () => {
    const button = document.querySelector("#makeServerOwner"), target = selectedModerationTarget;
    // GIVE COINS: the owner and real admins, to another player.
    document.querySelector("#giveCoinsRow").hidden = !((adminRole === "owner" || adminRole === "admin") && target && target.targetId);
    button.hidden = !(isAdmin && currentServer.id !== "main" && target && target.targetId);
    if (button.hidden) return;
    button.disabled = target.role === "host";
    button.textContent = target.role === "host" ? "ALREADY THE SERVER OWNER" : "MAKE SERVER OWNER";
  };
  document.querySelector("#makeServerOwner").addEventListener("click", async () => {
    const target = selectedModerationTarget, button = document.querySelector("#makeServerOwner"), message = document.querySelector("#moderationMessage");
    if (!isAdmin || !target?.targetId || button.disabled) return;
    button.disabled = true;
    try {
      await adminCommand("promote", {targetId: target.targetId, host: true});
      target.role = "host";
      for (const cell of remotePlayerCells) if (cell.remoteSessionId === target.targetId) cell.role = "host";
      message.textContent = `${target.name} is now the server owner.`;
    } catch (error) { message.textContent = error.message; }
    finally { window.updateServerOwnerButton(); updateAdminRoleButton(); }
  });

  document.querySelector("#applyServerLimit").addEventListener("click", applyServerLimit);
  document.querySelector("#serverLimitInput").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); applyServerLimit(); } });
  document.querySelector("#stopServer").addEventListener("click", stopServer);

  document.querySelector("#tabPlay").addEventListener("click", () => showMenuTab("play"));
  document.querySelector("#tabServers").addEventListener("click", () => showMenuTab("servers"));
  document.querySelector("#tabShop").addEventListener("click", () => showMenuTab("shop"));

  // ---- COINS from the owner or a real admin ----
  async function coinCommand(fields) {
    if (!session) throw new Error("Not connected yet.");
    const amount = Math.floor(Number(fields.amount));
    if (!(amount >= 1 && amount <= 1_000_000)) throw new Error("Choose 1 to 1,000,000 coins.");
    const response = await fetch("/api/admin/coins", {method: "POST", cache: "no-store", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({id: session.id, sessionKey: session.sessionKey, ...fields, amount})});
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Couldn't give coins.");
    walletSig = "";  // the next update brings the new balance
    return {...result, amount};
  }
  document.querySelector("#addCoins").addEventListener("click", async () => {
    const message = document.querySelector("#coinBoxMessage");
    try {
      const result = await coinCommand({amount: document.querySelector("#addCoinsAmount").value});
      message.textContent = `Added ${result.amount.toLocaleString()} coins. You have ${result.coins.toLocaleString()}.`;
    } catch (error) { message.textContent = error.message; }
  });
  document.querySelector("#giveCoins").addEventListener("click", async () => {
    const target = selectedModerationTarget, message = document.querySelector("#moderationMessage");
    if (!target?.targetId) return;
    try {
      const result = await coinCommand({targetId: target.targetId, amount: document.querySelector("#giveCoinsAmount").value});
      message.textContent = `Gave ${result.amount.toLocaleString()} coins to ${result.name}.`;
    } catch (error) { message.textContent = error.message; }
  });
  // On the home screen (SHOP tab): the owner and real admins add coins to themselves...
  document.querySelector("#shopAddCoins").addEventListener("click", async () => {
    try {
      const result = await coinCommand({amount: document.querySelector("#shopAddAmount").value});
      shopMessage(`Added ${result.amount.toLocaleString()} coins. You have ${result.coins.toLocaleString()}.`);
      await loadShop();
    } catch (error) { shopMessage(error.message); }
  });
  // ...and anyone signed in can gift some of their coins to another player by username (two clicks: gifts can't be undone).
  let giftConfirm = null, giftTimer = 0;
  const giftButton = document.querySelector("#sendGift");
  const resetGift = () => { giftConfirm = null; clearTimeout(giftTimer); giftButton.textContent = "SEND COINS"; };
  giftButton.addEventListener("click", async () => {
    const to = document.querySelector("#giftUsername").value.trim(), amount = Math.floor(Number(document.querySelector("#giftAmount").value));
    if (!to) { shopMessage("Type the player's account username."); return; }
    if (!(amount >= 1)) { shopMessage("Type how many coins to send."); return; }
    const key = `${to.toLowerCase()}:${amount}`;
    if (giftConfirm !== key) {
      resetGift();
      giftConfirm = key;
      giftButton.textContent = `SEND ${amount.toLocaleString()} TO ${to.toUpperCase()}?`;
      shopMessage("Click again to send. Gifts can't be undone.");
      giftTimer = setTimeout(resetGift, 5000);
      return;
    }
    resetGift();
    giftButton.disabled = true;
    if (await shopCommand("gift", "", `You sent ${amount.toLocaleString()} coins to ${to.toLowerCase()}.`, {to, amount})) {
      document.querySelector("#giftAmount").value = "";
    }
    giftButton.disabled = false;
  });
  for (const id of ["#giftUsername", "#giftAmount"]) document.querySelector(id).addEventListener("input", resetGift);
  for (const id of ["#addCoinsAmount", "#giveCoinsAmount"]) document.querySelector(id).addEventListener("keydown", event => event.stopPropagation());

  // ---- CHAT (lower left): one chat per server. Enter opens it while playing, Enter sends, Esc closes. ----
  const chatLogEl = document.querySelector("#chatLog"), chatInput = document.querySelector("#chatInput");
  const CHAT_TAGS = {owner: "OWNER", host: "SERVER OWNER", admin: "ADMIN", serveradmin: "ADMIN"};
  function addChatLine(message) {
    const line = document.createElement("li");
    if (message.system) { line.className = "system"; line.textContent = message.text; }
    else {
      if (CHAT_TAGS[message.role]) {
        const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = CHAT_TAGS[message.role]; line.append(tag);
      }
      const name = document.createElement("b"); name.textContent = `${message.name}: `;
      line.append(name, document.createTextNode(message.text));  // text, never HTML
    }
    const atBottom = chatLogEl.scrollHeight - chatLogEl.scrollTop - chatLogEl.clientHeight < 30;
    chatLogEl.append(line);
    while (chatLogEl.children.length > 40) chatLogEl.firstChild.remove();
    if (atBottom) chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }
  function applyChat(chat) {
    const restarted = chat.seq < lastChatSeq;  // the server restarted: start the list again
    if (restarted) chatLogEl.replaceChildren();
    for (const message of chat.messages || []) if (restarted || message.seq > lastChatSeq) addChatLine(message);
    lastChatSeq = chat.seq;
  }
  async function sendChat(text) {
    if (!session) return;
    try {
      const response = await fetch("/api/chat", {method: "POST", cache: "no-store", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({id: session.id, sessionKey: session.sessionKey, text, name: (running && player && player.name) || ui.name.value || "PLAYER"})});
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Message not sent.");
      lastSyncAt = -Infinity;  // get it back on the next update
    } catch (error) { addChatLine({system: true, text: error.message}); chatInput.value = chatInput.value || text; }
  }
  chatInput.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      const text = chatInput.value.trim();
      chatInput.value = "";
      if (text) sendChat(text);
      chatInput.blur();
    } else if (event.key === "Escape") chatInput.blur();
  });
  window.focusChat = () => {
    if (chatInput.hidden) {  // a guest: point at the note instead
      const note = document.querySelector("#chatGuestNote");
      note.classList.remove("flash"); void note.offsetWidth; note.classList.add("flash");
      return;
    }
    for (const code in keys) keys[code] = false;
    chatInput.focus();
  };
  if (matchMedia("(pointer: coarse)").matches) chatInput.placeholder = "Tap to chat";
  document.querySelector("#chat").hidden = false;
  document.querySelector("#refreshServers").addEventListener("click", loadServers);
  document.querySelector("#createServer").addEventListener("click", createServer);
  for (const id of ["#newServerName", "#newServerPassword"]) document.querySelector(id).addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); createServer(); }
  });
  document.querySelector("#menuTabs").hidden = false;
  document.querySelector("#currentServer").hidden = false;
  rememberServer();

  setInterval(syncRoom, 50);
})();
