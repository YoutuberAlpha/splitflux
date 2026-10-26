const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

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
      return payload.expires > Date.now() ? profile(payload.username) : null;
    } catch { return null; }
  }
  function remember(response, username) {
    const value = Buffer.from(JSON.stringify({ username, expires: Date.now() + 315360000000 })).toString("base64url");
    response.setHeader("Set-Cookie", `tricksplit_account=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000`);
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
  return { fromRequest, remember, forget, authenticate };
};
