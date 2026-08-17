import fs from "node:fs";
import path from "node:path";
import { hashModFiles } from "@claude-desktop/shared/mod-hash";
import { MOD_KERNEL_API } from "@claude-desktop/shared";
import {
  compileKernelActivate,
  parseKernelManifest,
  type KernelActivatePack,
  type KernelManifest,
} from "./mod-kernel";
import {
  getBundledModsDir,
  getKernelCacheDir,
  type RuntimePathEnv,
} from "./runtime-paths";

export type LoadedKernelMod = {
  dir: string;
  manifest: KernelManifest;
  manifestSource: string;
  modJsSource: string;
  checksum: string;
};

export type KernelPackInfo = {
  id: string;
  name: string;
  version: string;
  checksum: string;
  packDir: string;
  source: "bundled" | "cache";
  hostApi: typeof MOD_KERNEL_API;
};

export function peekHostApi(dir: string): 1 | 2 | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as { hostApi?: unknown };
    if (parsed.hostApi === 1) return 1;
    if (parsed.hostApi === 2) return 2;
    return undefined;
  } catch {
    return undefined;
  }
}

export function loadKernelDir(dir: string): LoadedKernelMod {
  if (fs.existsSync(path.join(dir, "ui.js"))) {
    throw new Error("ui.js is not allowed");
  }
  if (fs.existsSync(path.join(dir, "host.js"))) {
    throw new Error("host.js is not allowed in kernel packs");
  }
  const manifestPath = path.join(dir, "manifest.json");
  const modPath = path.join(dir, "mod.js");
  if (!fs.existsSync(manifestPath)) throw new Error("manifest.json is required");
  if (!fs.existsSync(modPath)) throw new Error("mod.js is required");
  const manifestSource = fs.readFileSync(manifestPath, "utf8");
  const modJsSource = fs.readFileSync(modPath, "utf8");
  if (/\bcreateGame\b/.test(modJsSource)) {
    throw new Error("createGame is not allowed in kernel packs");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestSource);
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  const manifest = parseKernelManifest(parsed);
  return {
    dir,
    manifest,
    manifestSource,
    modJsSource,
    checksum: hashModFiles(manifestSource, modJsSource),
  };
}

export function toKernelActivatePack(loaded: LoadedKernelMod): KernelActivatePack {
  return {
    manifest: loaded.manifest,
    activate: compileKernelActivate(loaded.modJsSource),
  };
}

export function writeKernelCache(
  env: RuntimePathEnv,
  loaded: LoadedKernelMod,
): string {
  const dest = path.join(getKernelCacheDir(env), loaded.checksum);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "manifest.json"), loaded.manifestSource, "utf8");
  fs.writeFileSync(path.join(dest, "mod.js"), loaded.modJsSource, "utf8");
  return dest;
}

function readDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root)
      .map((name) => path.join(root, name))
      .filter((dir) => {
        try {
          return fs.statSync(dir).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

export function listKernelPacks(env: RuntimePathEnv): KernelPackInfo[] {
  const out: KernelPackInfo[] = [];
  const seen = new Set<string>();
  for (const dir of [...readDirs(getBundledModsDir(env)), ...readDirs(getKernelCacheDir(env))]) {
    if (peekHostApi(dir) !== MOD_KERNEL_API) continue;
    try {
      const loaded = loadKernelDir(dir);
      if (seen.has(loaded.checksum)) continue;
      seen.add(loaded.checksum);
      const source = dir.startsWith(getKernelCacheDir(env)) ? "cache" : "bundled";
      out.push({
        id: loaded.manifest.id,
        name: loaded.manifest.name,
        version: loaded.manifest.version,
        checksum: loaded.checksum,
        packDir: loaded.dir,
        source,
        hostApi: MOD_KERNEL_API,
      });
    } catch {
      // skip
    }
  }
  return out;
}
