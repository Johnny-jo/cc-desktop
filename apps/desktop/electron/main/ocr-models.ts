import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import manifest from "../../resources/models/ocr/ppocr_v5_mobile/manifest.json";

export function resolveOcrModelsDir(startDir = __dirname): string {
  const relative = "models/ocr/ppocr_v5_mobile";
  const archive = /^(.*)[\\/]app\.asar(?:\.unpacked)?[\\/]/.exec(startDir);
  if (archive) return path.join(archive[1], relative);
  // Rollup may place this module in out/main/chunks; do not assume a fixed depth.
  let directory = startDir;
  while (true) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      if (pkg.name === "@claude-desktop/desktop") return path.join(directory, "resources", relative);
    } catch { /* Walk to the owning app package. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("无法定位 CC Desktop 本地 OCR 资源，请修复安装。");
    directory = parent;
  }
}

export function readVerifiedOcrModels(directory: string): Record<keyof typeof manifest.files, Buffer> {
  const output = {} as Record<keyof typeof manifest.files, Buffer>;
  for (const file of Object.keys(manifest.files) as Array<keyof typeof manifest.files>) {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(path.join(directory, file)); }
    catch { throw new Error(`本地 OCR 模型缺失：${file}。请修复或重新安装 CC Desktop。`); }
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.files[file]) {
      throw new Error(`本地 OCR 模型校验失败：${file}。请修复或重新安装 CC Desktop。`);
    }
    output[file] = bytes;
  }
  return output;
}
