const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

// A login stays valid for 30 days after the last visit (each visit renews it). Every account has a
// "token version": changing or resetting the password raises it, which signs out every other browser.
const LOGIN_DAYS = 30;
const LOGIN_MS = LOGIN_DAYS * 24 * 60 * 60 * 1000;

module.exports = function createAccounts(directory, signingKey, ownerPassword) {
  const filename = path.join(directory, "accounts.json");
  const accounts = Object.assign(Object.create(null), fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : {});
  function save() {
    fs.writeFileSync(filename + ".tmp", JSON.stringify(accounts), { mode: 0o600 });
    fs.renameSync(filename + ".tmp", filename);
  }
  if (!accounts.alpha) {
    if (!ownerPassword) throw new Error("Set SPLITFLUX_OWNER_PASSWORD before starting a new SPLITFLUX server.");
    const salt = crypto.randomBytes(16).toString("hex");
    accounts.alpha = { salt, hash: crypto.scryptSync(ownerPassword, salt, 64).toString("hex"), role: "owner" };
    save();
  }
  function profile(username) {
    const account = Object.hasOwn(accounts, username) && accounts[username];
    return account ? { username, role: account.role, isAdmin: account.role === "owner" } : null;
  }
  function sign(value) { return crypto.createHmac("sha256", signingKey).update(value).digest("hex"); }
  function fromRequest(request) {
    const cookie = String(request.headers.cookie || "").split(";").map(value => value.trim())
      .find(value => value.startsWith("tricksplit_account="));
    if (!cookie) return null;
    const value = cookie.slice("tricksplit_account=".length);
    const parts = value.split(".");
    if (parts.length !== 2 || !/^[0-9a-f]{64}$/.test(parts[1])) return null;
    if (!crypto.timingSafeEqual(Buffer.from(parts[1], "hex"), Buffer.from(sign(parts[0]), "hex"))) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      const account = Object.hasOwn(accounts, payload.username) && accounts[payload.username];
      if (!account || !(payload.expires > Date.now()) || (Number(payload.v) || 0) !== (account.tokenVersion || 0)) return null;
      return profile(payload.username);
    } catch { return null; }
  }
  function remember(response, username) {
    const version = Object.hasOwn(accounts, username) ? accounts[username].tokenVersion || 0 : 0;
    const value = Buffer.from(JSON.stringify({ username, v: version, expires: Date.now() + LOGIN_MS })).toString("base64url");
    const existing = response.getHeader("Set-Cookie") || [];
    response.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : [existing]), `tricksplit_account=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${LOGIN_MS / 1000}`]);
  }
  function forget(response) {
    response.setHeader("Set-Cookie", [
      "tricksplit_account=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
      "tricksplit_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    ]);
  }
  async function authenticate(username, password, register) {
    username = String(username || "").trim().toLowerCase();
    password = String(password || "");
    if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error("Use 3-20 letters, numbers, or underscores for your username.");
    if (password.length < 6 || password.length > 128) throw new Error("Use a password with 6-128 characters.");
    if (register) {
      if (Object.hasOwn(accounts, username)) throw new Error("That username is already taken.");
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = (await scrypt(password, salt, 64)).toString("hex");
      if (Object.hasOwn(accounts, username)) throw new Error("That username is already taken.");
      accounts[username] = { salt, hash, role: "player" };
      save();
    } else {
      const account = Object.hasOwn(accounts, username) && accounts[username];
      const hash = await scrypt(password, account ? account.salt : "unknown-account", 64);
      if (!account || !crypto.timingSafeEqual(hash, Buffer.from(account.hash, "hex"))) throw new Error("Incorrect username or password.");
    }
    return profile(username);
  }
  function checkNewPassword(password) {
    if (typeof password !== "string" || password.length < 8 || password.length > 128) throw new Error("Use a new password with 8-128 characters.");
  }
  async function setPassword(account, password) {
    const salt = crypto.randomBytes(16).toString("hex");
    account.salt = salt;
    account.hash = (await scrypt(password, salt, 64)).toString("hex");
    account.tokenVersion = (account.tokenVersion || 0) + 1;
    save();
  }
  // The signed-in player changes their own password (they must know the current one).
  async function changePassword(username, currentPassword, newPassword) {
    const account = Object.hasOwn(accounts, username) && accounts[username];
    if (!account) throw new Error("Sign in first.");
    const hash = await scrypt(String(currentPassword || ""), account.salt, 64);
    if (!crypto.timingSafeEqual(hash, Buffer.from(account.hash, "hex"))) throw new Error("Incorrect username or password.");
    checkNewPassword(newPassword);
    await setPassword(account, newPassword);
    return profile(username);
  }
  // The owner gives a player who forgot their password a temporary one.
  async function resetPassword(username, newPassword) {
    username = String(username || "").trim().toLowerCase();
    const account = Object.hasOwn(accounts, username) && accounts[username];
    if (!account) throw new Error("No account with that username.");
    if (account.role === "owner") throw new Error("Change the owner password with CHANGE PASSWORD instead.");
    checkNewPassword(newPassword);
    await setPassword(account, newPassword);
    return profile(username);
  }
  return { fromRequest, remember, forget, authenticate, changePassword, resetPassword };
};
