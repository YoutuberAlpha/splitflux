const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

module.exports = function createModeration(directory, key) {
  const filename = path.join(directory, "bans.json");
  const bans = Object.assign(Object.create(null), fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : {});
  const sign = value => crypto.createHmac("sha256", key).update("device:" + value).digest("hex");
  function device(request, response) {
    const cookie = String(request.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith("splitflux_device="));
    const parts = cookie ? cookie.slice("splitflux_device=".length).split(".") : [];
    if (parts.length === 2 && /^[0-9a-f]{48}$/.test(parts[0]) && /^[0-9a-f]{64}$/.test(parts[1]) && crypto.timingSafeEqual(Buffer.from(parts[1], "hex"), Buffer.from(sign(parts[0]), "hex"))) return parts[0];
    const id = crypto.randomBytes(24).toString("hex");
    const existing = response.getHeader("Set-Cookie") || [];
    response.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : [existing]), `splitflux_device=${id}.${sign(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000`]);
    return id;
  }
  function ban(identities, durationMs) {
    if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > Number.MAX_SAFE_INTEGER - Date.now())) throw new Error("Choose a duration of at least one second, or forever.");
    const until = durationMs === null ? Number.MAX_SAFE_INTEGER : Date.now() + durationMs;
    for (const identity of identities) bans[identity] = until;
    fs.writeFileSync(filename + ".tmp", JSON.stringify(bans), { mode: 0o600 });
    fs.renameSync(filename + ".tmp", filename);
    return until;
  }
  function until(identities) {
    return Math.max(0, ...identities.map(identity => Number(bans[identity]) > Date.now() ? Number(bans[identity]) : 0));
  }
  return { device, ban, until, bannedBotTeams: () => Object.keys(bans).filter(identity => identity.startsWith("bot:") && until([identity])).map(identity => identity.slice(4)) };
};
