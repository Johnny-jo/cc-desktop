import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(path.join(root, "apps/desktop/package.json"));
const requireVite = createRequire(requireDesktop.resolve("vite"));
const { build } = requireVite("esbuild");
const output = path.join(root, "scripts/room-relay-server.mjs");
const result = await build({
  entryPoints: [path.join(root, "apps/desktop/electron/server/room-server.ts")],
  outfile: output,
  metafile: true,
  bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["bufferutil", "utf-8-validate", "electron"],
  banner: { js: '// Generated from electron/server/room-server.ts. Do not edit by hand.\nimport { createRequire as __serverRequire } from "node:module";\nimport { fileURLToPath as __serverFile } from "node:url";\nimport { dirname as __serverDir } from "node:path";\nconst require = __serverRequire(import.meta.url);\nconst __filename = __serverFile(import.meta.url);\nconst __dirname = __serverDir(__filename);' },
});
// Keep dependency license notices inside the single deployable artifact.
const notices = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.replaceAll("\\", "/").includes("node_modules/")) continue;
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const license = fs.readdirSync(directory).find(name => /^licen[sc]e(?:\.|$)/i.test(name));
      if (!license) throw new Error(`Missing bundled dependency license: ${pkg.name}`);
      notices.set(`${pkg.name}@${pkg.version}`, fs.readFileSync(path.join(directory, license), "utf8"));
      break;
    }
    directory = path.dirname(directory);
  }
}
for (const [name, notice] of notices) fs.appendFileSync(output, `\n/*! Bundled dependency: ${name}\n${notice.replaceAll("*/", "* /")}\n*/\n`);
console.log("Built scripts/room-relay-server.mjs (standalone; no npm install on server)");
