// Servers: anyone can make a server (name, optional password, bots or not). Each server is its own arena; its host
// gets the admin panel there, admins can make other players admins, their bans only cover their server, and
// REMOVE ALL BOTS is a switch on every server (main included). Empty servers close after 5 minutes.
const assert = require("assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const {createEngine, captureResponse, arenaOf} = require("../cloud-runtime.cjs");
const {createLiveRuntime} = require("../live-runtime.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "splitflux-servers-test-")), savedEnv = {...process.env};
let payload;
const pool = {
  async connect() { let pending; return {async query(sql, values) {
    if (sql.includes("SELECT")) return {rows: [{payload: JSON.parse(JSON.stringify(payload))}]};
    if (sql.startsWith("UPDATE")) pending = JSON.parse(values[0]);
    if (sql === "COMMIT") payload = pending;
    return {rows: []};
  }, release() {}}; },
  async query(sql, values) {
    if (!sql.startsWith("UPDATE")) return {rows: []};
    if (values[1] !== payload.liveEpoch) return {rowCount: 0};
    payload = JSON.parse(values[0]); return {rowCount: 1};
  },
};

// A tiny browser that keeps its cookies.
function browser(runtime) {
  const jar = new Map();
  async function call(route, body, method) {
    const response = captureResponse();
    await runtime.dispatch({method: method || (body ? "POST" : "GET"), url: route, body,
      headers: {host: "test.invalid", cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ")}}, response);
    for (const line of [response.getHeader("Set-Cookie") || []].flat()) {
      const part = line.split(";")[0], index = part.indexOf("=");
      jar.set(part.slice(0, index), part.slice(index + 1));
    }
    return {status: response.statusCode, body: JSON.parse(response.body.toString() || "{}"), length: response.getHeader("Content-Length"), bytes: response.body.length};
  }
  const who = {call, session: null, snapshot: null};
  who.join = async (room, extra = {}) => {
    const result = room === "main" ? await call("/api/session") : await call("/api/session", {room, ...extra});
    // A stale Content-Length once cut this answer short in real browsers (the server adds a "pass" to it).
    if (result.length !== undefined) assert.equal(Number(result.length), result.bytes, "Content-Length must match the answer");
    if (result.status === 200) { who.session = result.body; who.snapshot = null; }
    return result;
  };
  who.post = (route, fields = {}) => call(route, {id: who.session.id, sessionKey: who.session.sessionKey, ...fields});
  who.state = async (fields = {}) => {
    const result = await who.post("/api/state", {running: true, view: 2, name: who.name || "P", ackRevision: who.snapshot?.self.revision || 0,
      cells: who.cells || [{netId: "c-" + who.session.id, x: 1000 + Math.random() * 3000, y: 1000 + Math.random() * 3000, mass: 28, alive: true}], ...fields});
    if (result.status === 200) { who.snapshot = result.body; if (result.body.self.cells) who.cells = result.body.self.cells; }
    return result;
  };
  return who;
}

(async () => {
  let runtime;
  try {
    process.env.SPLITFLUX_OWNER_PASSWORD = "test-owner-password";
    const seed = path.join(directory, "seed"), engine = createEngine(null, seed), files = {};
    for (const name of ["accounts.json", "admin-key.json"]) files[name] = fs.readFileSync(path.join(seed, name), "utf8");
    payload = {version: 1, arena: engine.exportState(), files};
    runtime = await createLiveRuntime(pool, {directory: path.join(directory, "live"), origin: "https://game.example", timers: false});
    const tick = ms => { for (let done = 0; done < ms; done += 40) runtime.rooms.tick(); };

    // At first there is only the main server.
    const alice = browser(runtime), bob = browser(runtime), carol = browser(runtime), owner = browser(runtime);
    alice.name = "ALICE"; bob.name = "BOB"; carol.name = "CAROL"; owner.name = "OWNER";
    let list = await alice.call("/api/rooms");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.rooms.map(room => room.name), ["MAIN SERVER"]);
    assert.equal(list.body.rooms[0].main, true); assert.equal(list.body.canCreate, true);

    // Making a server: the name is checked, the password is optional.
    assert.equal((await alice.call("/api/rooms/create", {name: "x"})).status, 400, "Names need 3+ characters");
    assert.equal((await alice.call("/api/rooms/create", {name: "main server"})).status, 409, "The main server's name is taken");
    assert.equal((await alice.call("/api/rooms/create", {name: "Alice's Room", password: "abc"})).status, 400, "Passwords need 4+ characters");
    const made = await alice.call("/api/rooms/create", {name: "Alice's Room", password: "secret-pw", bots: false});
    assert.equal(made.status, 200); assert.equal(made.body.room.private, true);
    const roomId = made.body.room.id;
    assert.equal((await bob.call("/api/rooms/create", {name: "alice's room"})).status, 409, "Two servers can't share a name");
    assert.match((await alice.call("/api/rooms/create", {name: "Second Room"})).body.error, /already host/, "One server per host");

    list = await bob.call("/api/rooms");
    const listed = list.body.rooms.find(room => room.id === roomId);
    assert.deepEqual({name: listed.name, private: listed.private, bots: listed.bots, host: listed.host, mine: listed.mine},
      {name: "Alice's Room", private: true, bots: false, host: "guest", mine: false});
    assert.equal((await alice.call("/api/rooms")).body.rooms.find(room => room.id === roomId).mine, true);

    // The host joins without the password and gets the admin panel there.
    assert.equal((await alice.join(roomId)).status, 200);
    assert.equal(alice.session.isAdmin, true); assert.equal(alice.session.adminRole, "host");
    assert.equal(alice.session.server.name, "Alice's Room");

    // Others need the password; the right one gives a pass for rejoining.
    let joined = await bob.join(roomId);
    assert.equal(joined.status, 403); assert.equal(joined.body.needsPassword, true);
    assert.equal((await bob.join(roomId, {password: "wrong-pw"})).status, 403);
    joined = await bob.join(roomId, {password: "secret-pw"});
    assert.equal(joined.status, 200); assert.equal(bob.session.isAdmin, false);
    const pass = joined.body.pass; assert(pass);
    assert.equal((await bob.join(roomId, {pass})).status, 200, "The pass rejoins without the password");

    // Each server is its own arena: no bots here, and main players can't see room players.
    await carol.join("main");
    tick(2000);
    await alice.state(); let bobView = await bob.state(); await carol.state();
    bobView = await bob.state();
    assert.equal(bobView.body.world.bots.length, 0, "A server made without bots has none");
    assert.equal(bobView.body.world.botsOff, true);
    assert(bobView.body.players.some(player => player.name === "ALICE"), "Players in the same server see each other");
    const carolView = await carol.state();
    assert(carolView.body.world.bots.length > 0, "The main server still has its bots");
    assert(!carolView.body.players.some(player => player.name === "ALICE" || player.name === "BOB"), "Main doesn't see the made server's players");

    // Players see who the host is; the host makes Bob an admin.
    assert.equal(bobView.body.players.find(player => player.name === "ALICE").role, "host");
    assert.equal((await bob.post("/api/admin/promote", {targetId: alice.session.id, admin: false})).status, 403, "Players can't use admin commands");
    let promoted = await alice.post("/api/admin/promote", {targetId: bob.session.id, admin: true});
    assert.equal(promoted.status, 200); assert.equal(promoted.body.admin, true);
    bobView = await bob.state();
    assert.equal(bobView.body.isAdmin, true); assert.equal(bobView.body.adminRole, "admin");
    assert.equal((await bob.post("/api/admin/promote", {targetId: alice.session.id, admin: false})).status, 403, "The host always stays admin");

    // Admins flip the REMOVE ALL BOTS switch: off brings bots, on removes them and keeps them away.
    let arena = await bob.post("/api/admin/arena", {view: 2, botsOff: false});
    assert.equal(arena.status, 200); assert.equal(arena.body.world.botsOff, false);
    tick(3000);
    assert((await bob.state()).body.world.bots.length > 0, "Bots come back when the switch is off");
    arena = await bob.post("/api/admin/arena", {view: 2, botsOff: true});
    assert.equal(arena.body.world.bots.length, 0);
    tick(3000);
    assert.equal((await bob.state()).body.world.bots.length, 0, "Removed bots stay removed");

    // An admin can't ban the host; the host's ban only covers this server.
    assert.equal((await bob.post("/api/admin/ban", {targetId: alice.session.id, durationMs: 60_000})).status, 403);
    const dave = browser(runtime); dave.name = "DAVE";
    await dave.join(roomId, {password: "secret-pw"}); await dave.state();
    assert.equal((await alice.post("/api/admin/ban", {targetId: dave.session.id, durationMs: 60_000})).status, 200);
    assert.equal((await dave.state()).status, 403, "A banned player is removed from the server");
    assert.equal((await dave.join(roomId, {password: "secret-pw"})).status, 403, "and can't rejoin it");
    assert.equal((await dave.join("main")).status, 200, "but can still play on the main server");
    assert.equal((await dave.state()).status, 200);

    // Taking admin away works too.
    promoted = await alice.post("/api/admin/promote", {targetId: bob.session.id, admin: false});
    assert.equal(promoted.body.admin, false);
    assert.equal((await bob.state()).body.isAdmin, false);
    assert.equal((await bob.post("/api/admin/arena", {botsOff: false})).status, 403, "A removed admin loses the commands");

    // Main server: the owner flips REMOVE ALL BOTS and can make a player admin there (saved with the arena).
    await owner.join("main");
    assert.equal((await owner.post("/api/accounts/login", {username: "alpha", password: "test-owner-password"})).status, 200);
    assert.equal((await owner.state()).body.adminRole, "owner");
    arena = await owner.post("/api/admin/arena", {view: 2, botsOff: true});
    assert.equal(arena.body.world.bots.length, 0); tick(3000);
    assert.equal((await carol.state()).body.world.bots.length, 0, "Main bots stay removed while the switch is on");
    await owner.post("/api/admin/arena", {view: 2, botsOff: false}); tick(3000);
    assert((await carol.state()).body.world.bots.length > 0, "and come back when it is off");
    assert.equal((await owner.post("/api/admin/promote", {targetId: carol.session.id, admin: true})).status, 200);
    assert.equal((await carol.state()).body.adminRole, "admin");
    assert(arenaOf(payload).promotedAdmins.length === 1, "Main server admins are saved right away");
    assert.equal((await carol.post("/api/admin/ban", {targetId: owner.session.id, durationMs: 60_000})).status, 403, "Nobody can ban the owner");

    // The owner gets into private servers without the password.
    assert.equal((await owner.join(roomId)).status, 200);
    assert.equal(owner.session.adminRole, "owner");

    // A server closes 5 minutes after its last player leaves.
    const room = runtime.rooms.rooms.get(roomId);
    for (const {id} of room.engine.exportState().sessions) room.engine.getSession(id).lastSeen = 0;  // everyone left
    runtime.rooms.tick();
    assert(runtime.rooms.rooms.has(roomId), "Still open right after everyone left");
    room.emptySince = Date.now() - runtime.rooms.EMPTY_CLOSE_MS - 1;
    runtime.rooms.tick();
    assert(!runtime.rooms.rooms.has(roomId), "Closed after 5 empty minutes");
    joined = await bob.join(roomId, {pass});
    assert.equal(joined.status, 404); assert.equal(joined.body.roomGone, true, "Joining a closed server says it closed");

    console.log("PASS: make servers (name, optional password, bots or not), separate arenas, host gets admin, admins make admins, server-only bans, REMOVE ALL BOTS switch on main and made servers, owner powers everywhere, empty servers close after 5 minutes.");
  } finally {
    await runtime?.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
