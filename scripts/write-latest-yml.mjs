/**
 * Generate electron-updater latest.yml from the newest NSIS installer
 * in apps/desktop/release/.
 *
 * electron-builder only writes latest.yml when publishing (--publish always).
 * We keep packaging offline, then emit the yml locally so it can be uploaded
 * next to the Setup.exe on a generic HTTP feed.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "apps", "desktop", "release");

const files = readdirSync(releaseDir).filter((f) =>
  /^CC-Desktop-Setup-.+-x64\.exe$/i.test(f),
);
if (files.length === 0) {
  console.error(`No CC-Desktop-Setup-*-x64.exe in ${releaseDir}`);
  process.exit(1);
}

function parseVersion(name) {
  const m = name.match(/CC-Desktop-Setup-(\d+\.\d+\.\d+)-x64\.exe$/i);
  return m ? m[1] : "0.0.0";
}

function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

files.sort((a, b) => cmpSemver(parseVersion(a), parseVersion(b)));
const exeName = files[files.length - 1];
const version = parseVersion(exeName);
const exePath = path.join(releaseDir, exeName);
const buf = readFileSync(exePath);
const size = statSync(exePath).size;
const sha512 = createHash("sha512").update(buf).digest("base64");
const releaseDate = new Date().toISOString();

const yml = [
  `version: ${version}`,
  `files:`,
  `  - url: ${exeName}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${exeName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  ``,
].join("\n");

const out = path.join(releaseDir, "latest.yml");
writeFileSync(out, yml, "utf8");
console.log(`wrote ${out}`);
console.log(`  version: ${version}`);
console.log(`  path:    ${exeName}`);
console.log(`  size:    ${size}`);
