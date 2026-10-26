const assert = require("assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tricksplit-accounts-"));
const base = "http://127.0.0.1:11002";
let child;
async function start() {
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.cjs")], {
    env: { ...process.env, PORT: "11002", SPLITFLUX_OWNER_PASSWORD: "test-owner-password", SPLITFLUX_DATA_DIR: dataDirectory }, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Test server startup timed out")), 10000);
    child.once("error", reject);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on("data", data => { if (data.toString().includes("OWNER PC:")) { clearTimeout(timeout); resolve(); } });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => { child.once("exit", resolve); child.kill(); });
}
async function newSession(cookie = "") {
  return (await fetch(base + "/api/session", { headers: { Cookie: cookie } })).json();
}
async function action(route, session, username, password, cookie = "") {
  const response = await fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ id: session.id, sessionKey: session.sessionKey, username, password, role: "owner", isAdmin: true }),
  });
  return { status: response.status, body: await response.json(), cookie: (response.headers.get("set-cookie") || "").split(";")[0] };
}
(async () => {
  try {
    await start();
    const guest = await newSession();
    assert.equal(guest.isAdmin, false);
    assert.equal((await action("/api/accounts/login", guest, "alpha", "wrongpassword")).status, 400);
    const owner = await action("/api/accounts/login", guest, "ALPHA", "test-owner-password");
    assert.equal(owner.body.isAdmin, true);
    assert.equal(owner.body.account.role, "owner");
    assert.equal((await newSession(owner.cookie)).isAdmin, true);
    const regular = await action("/api/accounts/register", guest, "test_player", "testpassword123");
    assert.equal(regular.status, 200);
    assert.equal(regular.body.isAdmin, false);
    assert.equal(regular.body.account.role, "player");
    assert.equal((await action("/api/accounts/register", guest, "alpha", "testpassword123")).status, 400);
    assert.equal((await action("/api/accounts/register", guest, "TEST_PLAYER", "testpassword123")).status, 400);
    const denied = await action("/api/admin/kill-all", guest, "", "", regular.cookie);
    assert.equal(denied.status, 403);
    assert.equal((await newSession("tricksplit_account=forged.abcdef")).isAdmin, false);
    const saved = fs.readFileSync(path.join(dataDirectory, "accounts.json"), "utf8");
    assert(!saved.includes("test-owner-password"));
    assert(!saved.includes("testpassword123"));
    await stop(); await start();
    assert.equal((await newSession(owner.cookie)).isAdmin, true);
    const session = await newSession();
    const login = await action("/api/accounts/login", session, "test_player", "testpassword123");
    assert.equal(login.body.account.username, "test_player");
    assert.equal(login.body.isAdmin, false);
    const logout = await action("/api/accounts/logout", session, "", "", login.cookie);
    assert.equal(logout.body.account, null);
    assert.equal(logout.body.isAdmin, false);
    assert.equal((await newSession(logout.cookie)).account, null);
    console.log("PASS: owner login, regular registration, duplicate names, wrong passwords, admin denial, remembered login, restart persistence, hashed passwords, and logout.");
  } finally {
    await stop();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
