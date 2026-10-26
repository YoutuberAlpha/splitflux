const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const configuredOrigin = process.env.SPLITFLUX_BACKEND_ORIGIN;
if (!configuredOrigin) throw new Error("Set SPLITFLUX_BACKEND_ORIGIN in Vercel to the public HTTPS URL of the multiplayer backend before deploying.");
const backend = new URL(configuredOrigin);
if (backend.protocol !== "https:" || backend.username || backend.password || backend.pathname !== "/" || backend.search || backend.hash || /^(localhost|127\.|\[::1\])/.test(backend.hostname)) {
  throw new Error("SPLITFLUX_BACKEND_ORIGIN must be a public HTTPS origin without credentials, a path, or query parameters.");
}
const output = path.join(root, ".vercel", "output");
const staticDirectory = path.join(output, "static");
// Clear only this generated output, then publish an explicit asset allowlist.
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(staticDirectory, { recursive: true });
for (const file of ["index.html", "style.css", "physics.js", "game.js", "multiplayer.js", "THIRD-PARTY-NOTICES.txt"]) {
  fs.copyFileSync(path.join(root, file), path.join(staticDirectory, file));
}
fs.cpSync(path.join(root, "licenses"), path.join(staticDirectory, "licenses"), { recursive: true });
const config = { version: 3, routes: [
  { src: "/api/(.*)", dest: backend.origin + "/api/$1", headers: { "Cache-Control": "no-store" } },
  { src: "/(?:owner|mobile|mobile-owner)/?", dest: "/index.html" },
  { handle: "filesystem" },
  { src: "/", dest: "/index.html" },
] };
fs.writeFileSync(path.join(output, "config.json"), JSON.stringify(config, null, 2));
console.log("Built SPLITFLUX frontend. Multiplayer requests route to the configured backend.");
