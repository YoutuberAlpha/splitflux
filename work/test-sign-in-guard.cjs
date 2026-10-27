// Bug 4: password guessing is slowed down per account, per browser and per server; sign-up spam is capped.
const assert = require("assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
const physics = require("../physics.js");
const {captureResponse} = require("../cloud-runtime.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "splitflux-guard-"));
let clock = 2_000_000_000_000;
class TestDate extends Date { static now() { return clock; } }

function boot(state) {
  const context = vm.createContext({
    require(name) {
      if (name === "http") return {createServer: () => ({listen() {}})};
      if (name === "./physics.js") return physics;
      if (name.startsWith("./")) return require(path.join(__dirname, "..", name));
      return require(name);
    },
    __dirname: path.join(__dirname, ".."), Buffer, module: {exports: {}}, console, URL, Math, JSON, Date: TestDate,
    process: {env: {SPLITFLUX_CLOUD_MODE: "1", SPLITFLUX_DATA_DIR: directory, SPLITFLUX_OWNER_PASSWORD: "correct-owner-password"}},
    setInterval: () => ({unref() {}}),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "server.cjs"), "utf8"), context);
  if (state) context.module.exports.importState(state);
  return context.module.exports;
}

(async () => {
  try {
    let server = boot();
    async function call(route, body) {
      const response = captureResponse();
      await server.handleRequest({method: body ? "POST" : "GET", url: route, headers: {host: "test"}, body}, response);
      return {status: response.statusCode, body: JSON.parse(response.body.toString() || "{}")};
    }
    const newBrowser = async () => (await call("/api/session")).body;
    const login = (session, username, password) => call("/api/accounts/login", {id: session.id, sessionKey: session.sessionKey, username, password});
    const register = (session, username, password) => call("/api/accounts/register", {id: session.id, sessionKey: session.sessionKey, username, password});

    let attacker = await newBrowser();
    for (let i = 0; i < 5; i++) assert.equal((await login(attacker, "alpha", "guess-" + i)).status, 400);
    let blocked = await login(attacker, "alpha", "correct-owner-password");
    assert.equal(blocked.status, 429, "After 5 wrong passwords the account must pause, even for the right password");
    assert.match(blocked.body.error, /Try again in 1 minute/);

    // A fresh browser (cleared cookies) does not reset the account's lock.
    attacker = await newBrowser();
    assert.equal((await login(attacker, "alpha", "another-guess")).status, 429, "Clearing cookies must not reset the account lock");

    // The lock survives a server restart / cold start.
    server = boot(server.exportState());
    assert.equal((await login(attacker, "alpha", "another-guess")).status, 429, "The lock must survive restarts");

    // The real owner gets in once the pause ends, which also clears the count.
    clock += 61_000;
    const owner = await newBrowser();
    assert.equal((await login(owner, "alpha", "correct-owner-password")).status, 200);
    attacker = await newBrowser();
    for (let i = 0; i < 4; i++) assert.equal((await login(attacker, "alpha", "retry-" + i)).status, 400);

    // Each extra wrong password doubles the pause.
    clock += 61_000;
    assert.equal((await login(attacker, "alpha", "retry-4")).status, 400);
    assert.equal((await login(attacker, "alpha", "retry-5")).status, 429);
    clock += 61_000;
    assert.equal((await login(attacker, "alpha", "retry-6")).status, 400);
    assert.match((await login(attacker, "alpha", "retry-7")).body.error, /Try again in [2-4] minutes/);

    // One browser trying many different names gets paused too.
    clock += 3_600_000;
    const sprayer = await newBrowser();
    for (let i = 0; i < 10; i++) assert.equal((await login(sprayer, "name_" + i, "password-" + i)).status, 400);
    assert.equal((await login(sprayer, "name_99", "password")).status, 429, "Guessing across many accounts from one browser must pause");

    // Sign-up: 8+ characters for new accounts and at most 3 new accounts per browser per hour.
    clock += 3_600_000;
    const signer = await newBrowser();
    assert.match((await register(signer, "short_pw", "1234567")).body.error, /at least 8 characters/);
    for (let i = 0; i < 3; i++) assert.equal((await register(signer, "family_" + i, "long-enough-" + i)).status, 200);
    assert.equal((await register(signer, "family_3", "long-enough-3")).status, 429, "Account spam from one browser must pause");

    console.log("PASS: 5 wrong passwords pause an account (even with cleared cookies or a restart), pauses double, owner can sign in afterwards, guessing many names from one browser pauses, new passwords need 8+ characters, sign-ups are capped per browser.");
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
