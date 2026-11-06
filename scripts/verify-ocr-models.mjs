import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "apps/desktop/resources/models/ocr/ppocr_v5_mobile");
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
for (const [file, expected] of Object.entries(manifest.files)) {
  const actual = createHash("sha256").update(readFileSync(join(directory, file))).digest("hex");
  if (actual !== expected) throw new Error(`Bundled OCR model checksum mismatch: ${file}`);
}
console.log(`Verified ${manifest.model}: detection, recognition and dictionary.`);
