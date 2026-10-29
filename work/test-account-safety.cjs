// Hosting batch, account safety: logins last 30 days (renewed on each visit) and can be cancelled, players can
// change their password (which signs out their other browsers), the owner can reset a forgotten password,
// old logins keep working after the update, and limits stop one browser or script from hogging the server.
const assert = require("assert/strict");
const {spawn} = require("child_process");
const crypto = require("crypto");
const fs = require("fs"), os = require("os"), path = require("path");
const {createServer} = require("./server-harness.cjs");
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "splitflux-safety-"));
const base = "http://127.0.0.1:11012";
let child;

// A tiny browser: keeps its own cookies.
function browser() {
  const jar = new Map();
  const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  async function call(route, body) {
    const response = await fetch(base + route, {method: body ? "POST" : "GET", headers: {"Content-Type": "application/json", Cookie: cookie()}, body: body ? JSON.stringify(body) : undefined});
    for (const line of response.headers.getSetCookie()) {
      const part = line.split(";")[0], split = part.indexOf("=");
      if (part.slice(split + 1)) jar.set(part.slice(0, split), part.slice(split + 1)); else jar.delete(part.slice(0, split));
    }
    return {status: response.status, body: await response.json(), setCookie: response.headers.getSetCookie()};
  }
  const who = {jar, call, session: null};
  who.open = async () => { const result = await call("/api/session"); who.session = result.body; return result; };
  who.post = (route, fields) => call(route, {id: who.session.id, sessionKey: who.session.sessionKey, ...fields});
  who.account = async () => (await who.open()).body.account?.username || null;
  return who;
}

(async () => {
  try {
    child = spawn(process.execPath, [path.join(__dirname, "..", "server.cjs")], {
      env: {...process.env, PORT: "11012", SPLITFLUX_OWNER_PASSWORD: "test-owner-password", SPLITFLUX_DATA_DIR: dataDirectory}, stdio: ["ignore", "pipe", "pipe"]});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server did not start")), 10000);
      child.once("exit", code => reject(new Error("Server exited " + code)));
      child.stdout.on("data", data => { if (data.toString().includes("OWNER PC:")) { clearTimeout(timer); resolve(); } });
    });

    // Sign up on one browser, sign in on another.
    const laptop = browser(), phone = browser(), owner = browser();
    await laptop.open(); await phone.open(); await owner.open();
    const signup = await laptop.post("/api/accounts/register", {username: "friend", password: "first-password"});
    assert.equal(signup.status, 200);
    const loginCookie = signup.setCookie.find(line => line.startsWith("tricksplit_account="));
    assert.match(loginCookie, /Max-Age=2592000/, "Logins last 30 days");
    const payload = JSON.parse(Buffer.from(laptop.jar.get("tricksplit_account").split(".")[0], "base64url"));
    assert(payload.expires - Date.now() < 31 * 86400000 && payload.expires - Date.now() > 29 * 86400000);
    assert.equal((await phone.post("/api/accounts/login", {username: "friend", password: "first-password"})).status, 200);
    assert.equal(await laptop.account(), "friend");
    assert.equal(await phone.account(), "friend");

    // Logins made before this update (no version, 10-year expiry) still work, and get renewed as 30-day logins.
    const key = JSON.parse(fs.readFileSync(path.join(dataDirectory, "admin-key.json"), "utf8")).key;
    const oldValue = Buffer.from(JSON.stringify({username: "friend", expires: Date.now() + 315360000000})).toString("base64url");
    const oldBrowser = browser();
    oldBrowser.jar.set("tricksplit_account", `${oldValue}.${crypto.createHmac("sha256", key).update(oldValue).digest("hex")}`);
    const renewed = await oldBrowser.open();
    assert.equal(renewed.body.account.username, "friend", "Old logins keep working");
    assert.match(renewed.setCookie.find(line => line.startsWith("tricksplit_account=")), /Max-Age=2592000/, "and are renewed as 30-day logins");

    // Changing the password needs the current one, and signs out every other browser.
    await laptop.open();
    let change = await laptop.post("/api/accounts/password", {currentPassword: "wrong-password", newPassword: "second-password"});
    assert.equal(change.status, 400); assert.match(change.body.error, /current password/);
    change = await laptop.post("/api/accounts/password", {currentPassword: "first-password", newPassword: "short"});
    assert.equal(change.status, 400); assert.match(change.body.error, /8-128/);
    change = await laptop.post("/api/accounts/password", {currentPassword: "first-password", newPassword: "second-password"});
    assert.equal(change.status, 200);
    assert.equal(await laptop.account(), "friend", "The browser that changed it stays signed in");
    assert.equal(await phone.account(), null, "Other browsers are signed out");
    assert.equal(await oldBrowser.account(), null, "Old logins stop working too");
    assert.equal((await phone.post("/api/accounts/login", {username: "friend", password: "first-password"})).status, 400, "The old password no longer works");
    assert.equal((await phone.post("/api/accounts/login", {username: "friend", password: "second-password"})).status, 200);

    // Guests can't change passwords; players can't reset other people's.
    const guest = browser(); await guest.open();
    assert.equal((await guest.post("/api/accounts/password", {currentPassword: "x", newPassword: "whatever-new"})).status, 403);
    assert.equal((await phone.post("/api/admin/reset-password", {username: "friend", newPassword: "hacked-password"})).status, 403);

    // The owner resets a forgotten password: the player's logins end, the temporary password works.
    assert.equal((await owner.post("/api/accounts/login", {username: "alpha", password: "test-owner-password"})).status, 200);
    let reset = await owner.post("/api/admin/reset-password", {username: "nobody_here", newPassword: "temporary-pass"});
    assert.equal(reset.status, 400); assert.match(reset.body.error, /No account/);
    reset = await owner.post("/api/admin/reset-password", {username: "alpha", newPassword: "temporary-pass"});
    assert.equal(reset.status, 400, "The owner account is changed with CHANGE PASSWORD, not reset");
    reset = await owner.post("/api/admin/reset-password", {username: "Friend", newPassword: "temporary-pass"});
    assert.equal(reset.status, 200); assert.equal(reset.body.reset, "friend");
    assert.equal(await laptop.account(), null, "A reset signs the player out everywhere");
    assert.equal((await laptop.post("/api/accounts/login", {username: "friend", password: "temporary-pass"})).status, 200);
    assert.equal(await owner.account(), "alpha", "The owner stays signed in");

    // The owner can change their own password too.
    assert.equal((await owner.post("/api/accounts/password", {currentPassword: "test-owner-password", newPassword: "new-owner-password"})).status, 200);
    assert.equal((await guest.post("/api/accounts/login", {username: "alpha", password: "new-owner-password"})).status, 200);

    // One browser can have at most 6 game tabs at once; the 7th waits (closed tabs free up after 15 s).
    const tabs = browser();
    for (let i = 0; i < 6; i++) assert.equal((await tabs.open()).status, 200);
    const seventh = await tabs.open();
    assert.equal(seventh.status, 503); assert.equal(seventh.body.full, true);

    // A player can send at most ~25 updates a second; a flood is turned away cheaply.
    await guest.open();
    const statuses = [];
    for (let i = 0; i < 70; i++) statuses.push((await guest.post("/api/state", {running: false, cells: []})).status);
    assert(statuses.slice(0, 35).every(status => status === 200), "Normal play is never limited");
    assert(statuses.includes(429), "A flood of updates is limited");

    // At most 60 new connections a minute for the whole server (the owner can always get in).
    let refused = null;
    for (let i = 0; i < 80 && !refused; i++) { const result = await browser().open(); if (result.status === 503) refused = result; }
    assert(refused, "A flood of new connections is limited"); assert.equal(refused.body.full, true);
    assert.equal((await owner.open()).status, 200, "The owner still gets in");

    // Limits checked with the test clock: full server, skin download budget.
    const game = createServer();
    game.run(`for (let i = 0; i < MAX_SESSIONS; i++) sessions.set("s" + i, {id: "s" + i, deviceId: "d" + i, lastSeen: Date.now(), cells: [], running: false})`);
    assert.equal((await game.call("/api/session")).status, 503, "A full server turns new players away");
    game.run("sessions.clear()");
    assert.equal(game.run("takeSkinBudget(19_000_000, Date.now())"), true);
    assert.equal(game.run("takeSkinBudget(2_000_000, Date.now())"), false, "Skin downloads stop at 20 MB an hour");
    game.advance(3_600_000);
    assert.equal(game.run("takeSkinBudget(2_000_000, Date.now())"), true, "and start again the next hour");

    console.log("PASS: 30-day renewable logins, old logins still work, password change signs out other browsers, owner password reset, 6 tabs per browser, 25 updates/s per player, 60 new connections/min, full-server and skin download limits.");
  } finally {
    if (child && child.exitCode === null) await new Promise(resolve => { child.once("exit", resolve); child.kill(); });
    fs.rmSync(dataDirectory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
