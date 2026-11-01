// SERVERS: the main server plus the servers players make from the SERVERS tab.
// Each made server runs in its own copy of the game engine (its own arena, bots, food and players), so nothing
// that happens in one can affect another. Accounts, bans, sign-in limits and the live connection are shared
// with the main server. Made servers live in memory: they close after 10 minutes without players (bots don't count).
const crypto = require("crypto");
const {captureResponse} = require("./cloud-runtime.cjs");

const MAX_SERVERS = 10;                 // made servers at once (the free game server only has a small CPU share)
const EMPTY_CLOSE_MS = 10 * 60_000;     // a made server closes after 10 minutes with no players in it (bots don't count)
const CREATES_PER_HOUR = 5;             // per browser or account
const JOIN_FAILURES_PER_10_MIN = 10;    // wrong passwords per browser
const NAME_PATTERN = /^[\p{L}\p{N} _'!?.&#-]{3,24}$/u;

function createRoomManager({main, loadEngine, now = () => Date.now(), tickMain = true}) {
  const rooms = new Map();         // id -> {id, name, salt, passwordHash, createdAt, emptySince, engine}
  const stopped = new Map();       // id -> when an admin stopped it (so its players are told why it's gone)
  const sessionRooms = new Map();  // player session id -> made server id
  const creations = new Map();     // host identity -> times a server was made (last hour)
  const joinFailures = new Map();  // browser -> times a wrong password was tried (last 10 minutes)
  const secret = crypto.randomBytes(32);

  const shared = () => main.shared();
  const hash = (salt, password) => crypto.createHash("sha256").update(salt).update(String(password)).digest();
  // A private server hands out a "pass" after the right password, so a page refresh can rejoin without retyping it.
  const passFor = room => crypto.createHmac("sha256", secret).update(room.id + room.salt).digest("base64url");
  // The server owner can change (an admin can hand the server to someone else), so always ask the server itself.
  const isHostOf = (room, deviceId, account) => {
    const host = room.engine.roomHost();
    return host.username ? account?.username === host.username : host.deviceId === deviceId;
  };
  const recent = (map, key, windowMs) => (map.get(key) || []).filter(time => now() - time < windowMs);

  function sendJson(response, status, body) {
    response.writeHead(status, {"Content-Type": "application/json", "Cache-Control": "no-store"});
    response.end(JSON.stringify(body));
  }

  async function readJson(request) {
    if (request.body !== undefined) return typeof request.body === "string" || Buffer.isBuffer(request.body) ? JSON.parse(String(request.body) || "{}") : request.body;
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 2_000_000) throw new Error("Request too large"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  // The browser's id (a signed cookie). A first-time visitor gets a new one; it is also added to the request we
  // pass on, so the server they join sees the same id (it decides who the host is and what a ban covers).
  function withDevice(request, response) {
    const deviceId = shared().moderation.device(request, response);
    const fresh = [response.getHeader("Set-Cookie") || []].flat().map(line => String(line).split(";")[0]).filter(part => part.startsWith("splitflux_device="));
    const old = String(request.headers.cookie || "").split(";").map(part => part.trim()).filter(part => part && !(fresh.length && part.startsWith("splitflux_device=")));
    return {deviceId, headers: {...request.headers, cookie: [...fresh, ...old].join("; ")}};
  }

  function engineFor(sessionId) {
    const room = rooms.get(sessionRooms.get(String(sessionId || "")));
    return room ? room.engine : main;
  }

  function listing(request, response) {
    const account = shared().accounts.fromRequest(request), {deviceId} = withDevice(request, response);
    main.cleanupSessions();
    const list = [{...main.serverInfo(), main: true, private: false, ...main.summary()}];
    for (const room of rooms.values()) {
      room.engine.cleanupSessions();
      list.push({id: room.id, name: room.name, private: Boolean(room.passwordHash), host: room.engine.roomHost().username || "guest",
        mine: isHostOf(room, deviceId, account), ...room.engine.summary(), people: room.engine.playerCount(), maxPlayers: room.engine.serverInfo().maxPlayers});
    }
    return {rooms: list, canCreate: rooms.size < MAX_SERVERS, max: MAX_SERVERS};
  }

  async function create(request, response) {
    const body = await readJson(request);
    const {accounts, moderation} = shared();
    const account = accounts.fromRequest(request), {deviceId} = withDevice(request, response);
    const identities = [`device:${deviceId}`, ...(account ? [`account:${account.username}`] : [])];
    if (!account?.isAdmin && moderation.until(identities)) return sendJson(response, 403, {error: "You are banned from this arena."});
    const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
    if (!NAME_PATTERN.test(name)) return sendJson(response, 400, {error: "Use 3-24 letters, numbers or spaces for the server name."});
    const taken = [main.serverInfo().name, ...[...rooms.values()].map(room => room.name)].some(other => other.toLowerCase() === name.toLowerCase());
    if (taken) return sendJson(response, 409, {error: "A server with that name already exists."});
    const password = typeof body.password === "string" ? body.password : "";
    if (password && (password.length < 4 || password.length > 64)) return sendJson(response, 400, {error: "Use a password with 4-64 characters, or leave it empty."});
    const mine = [...rooms.values()].find(room => isHostOf(room, deviceId, account));
    if (mine) return sendJson(response, 409, {error: `You already host "${mine.name}". It closes after 10 minutes with no players.`});
    if (rooms.size >= MAX_SERVERS) return sendJson(response, 503, {error: `All ${MAX_SERVERS} server slots are in use. Try again later.`});
    const hostKey = account ? `account:${account.username}` : `device:${deviceId}`;
    const made = recent(creations, hostKey, 3_600_000);
    if (made.length >= CREATES_PER_HOUR) return sendJson(response, 429, {error: "You made a lot of servers this hour. Try again later."});
    creations.set(hostKey, [...made, now()]);

    const maxPlayers = Math.round(Number(body.maxPlayers ?? 10));
    if (!(maxPlayers >= 2 && maxPlayers <= 50)) return sendJson(response, 400, {error: "Choose 2-50 players."});
    const engine = loadEngine();
    engine.useShared(shared());
    const id = crypto.randomBytes(6).toString("base64url");
    const host = {username: account?.username || null, deviceId: account ? null : deviceId};
    engine.configureRoom({id, name, host, bots: body.bots !== false, maxPlayers});
    const salt = crypto.randomBytes(16).toString("hex");
    const room = {id, name, salt, passwordHash: password ? hash(salt, password) : null, createdAt: now(), emptySince: now(), engine};
    rooms.set(id, room);
    sendJson(response, 200, {room: {id, name, private: Boolean(password)}, pass: passFor(room)});
  }

  // Joining a server = starting a new player session in that server's engine.
  async function join(request, response) {
    const body = await readJson(request);
    const roomId = String(body.room || "main");
    if (roomId === "main") return main.handleRequest({method: "GET", url: "/api/session", headers: request.headers}, response);
    const room = rooms.get(roomId);
    if (!room && stopped.has(roomId)) return sendJson(response, 404, {error: "The server owner or an admin has stopped this server.", roomGone: true, stopped: true});
    if (!room) return sendJson(response, 404, {error: "That server has closed.", roomGone: true});
    const account = shared().accounts.fromRequest(request), {deviceId, headers} = withDevice(request, response);
    // The player limit counts people (bots don't). The owner and the server owner can always get in.
    const limit = room.engine.serverInfo().maxPlayers, people = room.engine.playerCount(deviceId);
    if (people >= limit && !account?.isAdmin && !isHostOf(room, deviceId, account)) {
      return sendJson(response, 503, {error: `This server is full (${people}/${limit} players).`, full: true});
    }
    if (room.passwordHash && !account?.isAdmin && !isHostOf(room, deviceId, account)) {
      const pass = typeof body.pass === "string" ? body.pass : "";
      const passOk = pass.length > 0 && pass.length < 100 && crypto.timingSafeEqual(Buffer.from(pass.padEnd(64)), Buffer.from(passFor(room).padEnd(64)));
      if (!passOk) {
        const failures = recent(joinFailures, deviceId, 600_000);
        if (failures.length >= JOIN_FAILURES_PER_10_MIN) return sendJson(response, 429, {error: "Too many wrong passwords. Try again in a few minutes."});
        if (!crypto.timingSafeEqual(hash(room.salt, body.password ?? ""), room.passwordHash)) {
          joinFailures.set(deviceId, [...failures, now()]);
          return sendJson(response, 403, {error: body.password ? "Wrong password." : "This server is private. Enter its password.", needsPassword: true});
        }
      }
    }
    const captured = captureResponse();
    await room.engine.handleRequest({method: "GET", url: "/api/session", headers}, captured);
    let answer = captured.body;
    if (captured.statusCode === 200) {
      const session = JSON.parse(captured.body.toString());
      sessionRooms.set(session.id, room.id);
      room.emptySince = 0;
      answer = Buffer.from(JSON.stringify({...session, pass: room.passwordHash ? passFor(room) : undefined}));
    }
    const cookies = [...[response.getHeader("Set-Cookie") || []].flat(), ...[captured.getHeader("Set-Cookie") || []].flat()];
    // The answer gained a "pass", so its length changed: don't copy the old Content-Length.
    for (const [name, value] of captured.headers) if (!["set-cookie", "content-length"].includes(name.toLowerCase())) response.setHeader(name, value);
    if (cookies.length) response.setHeader("Set-Cookie", [...new Set(cookies)]);
    response.writeHead(captured.statusCode);
    response.end(answer);
  }

  // STOP THIS SERVER (server owner or admin): everyone in it is sent back to the main server with a message.
  async function stop(request, response) {
    const body = await readJson(request);
    const room = rooms.get(sessionRooms.get(String(body.id || "")));
    if (!room) return sendJson(response, 404, {error: "You're not on a server you can stop."});
    if (!room.engine.roleFor(body.id, body.sessionKey, request)) return sendJson(response, 403, {error: "Only the server owner or an admin can stop this server."});
    rooms.delete(room.id);
    stopped.set(room.id, now());
    for (const [id, time] of stopped) if (now() - time > 3_600_000) stopped.delete(id);
    sendJson(response, 200, {stopped: room.name});
  }

  // MAX PLAYERS (server owner or admin), any time. Lowering it doesn't kick anyone; it only stops new players.
  async function setLimit(request, response) {
    const body = await readJson(request);
    const room = rooms.get(sessionRooms.get(String(body.id || "")));
    if (!room) return sendJson(response, 404, {error: "The main server has no player limit to change."});
    if (!room.engine.roleFor(body.id, body.sessionKey, request)) return sendJson(response, 403, {error: "Only the server owner or an admin can change this."});
    try { sendJson(response, 200, {maxPlayers: room.engine.setRoomLimit(body.maxPlayers)}); }
    catch (error) { sendJson(response, 400, {error: error.message}); }
  }

  async function handle(request, response) {
    const url = new URL(request.url, "http://game.invalid");
    try {
      if (request.method === "GET" && url.pathname === "/api/rooms") return sendJson(response, 200, listing(request, response));
      if (request.method === "POST" && url.pathname === "/api/rooms/create") return await create(request, response);
      if (request.method === "POST" && url.pathname === "/api/session") return await join(request, response);
      if (request.method === "POST" && url.pathname === "/api/rooms/stop") return await stop(request, response);
      if (request.method === "POST" && url.pathname === "/api/rooms/limit") return await setLimit(request, response);
      let engine = main;
      if (request.method === "POST" && url.pathname.startsWith("/api/")) {
        request.body = await readJson(request);
        engine = engineFor(request.body.id);
      } else if (request.method === "GET" && url.pathname.startsWith("/api/skins/")) {
        engine = engineFor(decodeURIComponent(url.pathname.slice("/api/skins/".length)));
      }
      await engine.handleRequest(request, response);
    } catch {
      if (!response.headersSent && !response.ended) sendJson(response, 400, {error: "Invalid request"});
    }
  }

  // Every 40 ms: the main server always runs; a made server only runs while a player is in it (players on its
  // menu count, bots don't). After 10 minutes with no players at all, the server is gone.
  // (On a PC the main server has its own timer, so tickMain is false there.)
  function tick() {
    if (tickMain) main.advanceArena();
    for (const room of rooms.values()) {
      room.engine.cleanupSessions();
      if (room.engine.summary().connected) { room.emptySince = 0; room.engine.advanceArena(); continue; }
      room.emptySince ||= now();
      if (now() - room.emptySince >= EMPTY_CLOSE_MS) rooms.delete(room.id);
    }
    for (const [sessionId, roomId] of sessionRooms) {
      const room = rooms.get(roomId);
      if (!room || !room.engine.getSession(sessionId)) sessionRooms.delete(sessionId);
    }
  }

  return {handle, tick, getSession: id => engineFor(id).getSession(id), rooms, MAX_SERVERS, EMPTY_CLOSE_MS};
}

module.exports = {createRoomManager};
