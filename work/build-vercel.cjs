const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const staticDirectory = path.join(root, "public");
// Clear only this generated output, then publish an explicit asset allowlist.
if (path.relative(root,staticDirectory)!=="public" || fs.existsSync(staticDirectory)&&fs.lstatSync(staticDirectory).isSymbolicLink()) throw new Error("Unsafe build output directory");
fs.rmSync(staticDirectory, { recursive: true, force: true });
fs.mkdirSync(staticDirectory, { recursive: true });
for (const file of ["index.html", "style.css", "physics.js", "game.js", "multiplayer.js", "THIRD-PARTY-NOTICES.txt"]) {
  fs.copyFileSync(path.join(root, file), path.join(staticDirectory, file));
}
fs.cpSync(path.join(root, "licenses"), path.join(staticDirectory, "licenses"), { recursive: true });
console.log("Built SPLITFLUX public assets. Vercel compiles the private API separately.");
