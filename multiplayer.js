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
  let skinSource = null;
  let networkSkin = "";
  let lastSentSkin = null;
  let teamRevision = 0;
  let nextSyncAt = 0;
  function updateNetworkSkin() {
    if (skinSource === playerBlobImageData) return;
    skinSource = playerBlobImageData;
    if (!playerBlobImageData) { networkSkin=""; return; }
    if (!playerBlobImage?.complete || !playerBlobImage.naturalWidth) {skinSource=null;return;}
    const thumbnail=document.createElement("canvas");thumbnail.width=128;thumbnail.height=128;
    thumbnail.getContext("2d").drawImage(playerBlobImage,0,0,128,128);
    networkSkin=thumbnail.toDataURL("image/webp",.75);
  }
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

  function applyWorld(world, forceOwnerCorrection = false, preserveLocalMapSize = false) {
    if (!world) return;
    lastWorld = world;
    if (!preserveLocalMapSize) worldSize = Math.max(5200, Number(world.worldSize) || 5200);
    updateMapSizeLabel();
    if (Array.isArray(world.bots)) {
        const currentBots = new Map(bots.map(bot => [bot.netId, bot]));
        bots = world.bots.map(bot => ({
          ...mergeNetworkCell(currentBots.get(bot.netId), bot),
          isPlayer: false,
        }));
    }
    if (Array.isArray(world.viruses)) viruses = world.viruses;
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
      ejected = world.ejected.map(pellet => {
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
          createdAt: localCreatedAt,
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

  function applyBotMassOnly(world) {
    if (!world || !Array.isArray(world.bots)) return;
    const byId = new Map(bots.map(bot => [bot.netId, bot]));
    for (const serverBot of world.bots) {
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
      if (!remote.running) continue;
      for (const cell of remote.cells || []) {
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
          botTeam: `remote-${remote.id}`,
        });
        const cachedSkin=remoteSkinImages.get(remote.id);
        if (remote.skinVersion && cachedSkin?.version!==remote.skinVersion) {
          const image=new Image();image.src=`/api/skins/${encodeURIComponent(remote.id)}?v=${remote.skinVersion}`;
          remoteSkinImages.set(remote.id,{image,version:remote.skinVersion});
        } else if (!remote.skinVersion) remoteSkinImages.delete(remote.id);
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

  function updateAdminAccess() {
    isAdmin = Boolean(session && session.isAdmin);
    document.querySelector("#botBanOptions").hidden = !isAdmin;
    if (!isAdmin) document.querySelector("#moderationMenu").classList.add("hidden");
    updateBlobImageAccess();
    document.querySelector("#mobileRole").textContent = isAdmin ? "OWNER" : "GUEST";
    adminShortcut.classList.toggle("hidden", !isAdmin);
    adminShortcut.classList.toggle("inactive", !isAdmin || !running);
    if (!isAdmin) ui.admin.classList.add("hidden");
    const account = session && session.account;
    document.querySelector("#adminUnlockStatus").textContent = account
      ? `Signed in as ${account.username}${isAdmin ? " - OWNER / ADMIN" : " - PLAYER"}` : "Playing as guest. Sign in or create an account.";
    document.querySelector("#accountLogout").hidden = !account;
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
      session.account = result.account;
      updateAdminAccess();
      document.querySelector("#accountPassword").value = "";
    } catch (error) {
      message.textContent = error.message || "Unable to connect to server.";
    } finally {
      accountBusy = false;
      document.querySelectorAll(".account-actions button").forEach(button => { button.disabled = false; });
    }
  }
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

  async function createSession() {
    const params = new URLSearchParams(location.search);
    const ownerKey = params.get("owner") || "";
    const response = await fetch(`/api/session${ownerKey ? `?owner=${encodeURIComponent(ownerKey)}` : ""}`, {
      cache: "no-store",
    });
    if (response.status===403) {
      const blocked=await response.json();
      if (blocked.bannedUntil) {showBan(blocked.bannedUntil);session=null;return;}
    }
    if (!response.ok) throw new Error("The room server did not answer.");
    session = await response.json();
    networkRevision = 0;
    worldRevision = 0;
    botRevision = 0;
    botMassRevision = 0;
    teamRevision = 0;
    forceMenuVersion = 0;
    pendingFeedCommands.clear();
    ejected = [];
    ejectedCache.clear();
    lastSentSkin=null;
    updateAdminAccess();
    connected = true;
    if (isAdmin) {
      adminShortcut.classList.remove("hidden");
      if (running) adminShortcut.classList.remove("inactive");
    } else {
      adminShortcut.classList.add("hidden", "inactive");
      ui.admin.classList.add("hidden");
    }
    status.innerHTML = `<i class="status-dot"></i> ONLINE - ${isAdmin ? "OWNER" : "GUEST"}`;
  }

  async function syncRoom() {
    if (currentBanUntil>Date.now()) return;
    if (!session || syncing) return;
    if (!running && performance.now() < nextSyncAt) return;
    nextSyncAt = performance.now() + (running ? 75 : 1500);
    syncing = true;
    try {
      updateNetworkSkin();
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
      };
      if (networkSkin!==lastSentSkin) payload.skin=networkSkin;
      for (const cell of playerCells) cell._syncMassWeights = { [cell.netId]: 1 };
      const sentMapSize = worldSize;
      const requestAt=performance.now();
      const response = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
      if (response.status === 401) {
        await createSession();
        return;
      }
      if (response.status===403) {
        const blocked=await response.json();
        if (blocked.bannedUntil) {showBan(blocked.bannedUntil);return;}
      }
      if (!response.ok) throw new Error("Room sync failed.");
      const snapshot = await response.json();
      networkDelay=Math.min(.15,(performance.now()-requestAt)/2000);
      if (Object.hasOwn(payload,"skin")) lastSentSkin=payload.skin;
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
      if (!accountBusy && (session.isAdmin !== snapshot.isAdmin || JSON.stringify(session.account) !== JSON.stringify(snapshot.account))) {
        session.isAdmin = snapshot.isAdmin;
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
      if (hasPlayerCorrection) applyOwnCells(snapshot.self && snapshot.self.cells, payload.cells);
      applyRemotePlayers(snapshot.players);
      applyWorld(snapshot.world || lastWorld, hasBotCorrection, isAdmin && worldSize !== sentMapSize);
      if (!hasBotCorrection && hasBotMassCorrection) applyBotMassOnly(snapshot.world || lastWorld);
      status.innerHTML = `<i class="status-dot"></i> ONLINE - ${lastPlayerCount} PLAYER${lastPlayerCount === 1 ? "" : "S"}`;
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

  createSession().catch(() => {
    status.innerHTML = '<i class="status-dot"></i> SERVER OFFLINE';
  });

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
    const response=await fetch(`/api/admin/${route}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:session.id,sessionKey:session.sessionKey,...command})});
    const result=await response.json();
    if (!response.ok) throw new Error(result.error||"Admin command failed");
    return result;
  }
  window.banPlayerOnline=async(target,durationMs)=>adminCommand("ban",{...target,durationMs});
  window.paintSpikesOnline=async(points)=>{
    const result=await adminCommand("paint-spikes",{points});
    viruses=result.viruses;
    return result;
  };
  window.configureArenaOnline=async(command)=>{
    const result=await adminCommand("arena",command);
    const oldSize=worldSize;
    applyWorld(result.world,true);
    if (worldSize!==oldSize) {
      const scale=worldSize/oldSize;
      food.forEach(dot=>{dot.x*=scale;dot.y*=scale;});
      playerCells.forEach(cell=>{cell.x*=scale;cell.y*=scale;});
      camera.x*=scale;camera.y*=scale;
      saveMapSizePreference(worldSize);
    }
    return result;
  };

  setInterval(syncRoom, 75);
})();
