/**
 * Rasterize the app icon SVG to the PNG electron-builder expects.
 * Run from apps/desktop (has sharp in devDependencies):
 *   cd apps/desktop && node ../../scripts/build-icons.mjs
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const desktopDir = path.join(root, "apps", "desktop");
const require = createRequire(path.join(desktopDir, "package.json"));
const sharp = require("sharp");

const src = path.join(desktopDir, "build", "icon.svg");
const outPng = path.join(desktopDir, "build", "icon.png");

const info = await sharp(src, { density: 384 })
  .resize(512, 512)
  .png()
  .toFile(outPng);

console.log("Wrote", outPng, `${info.width}x${info.height}`);
