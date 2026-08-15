import fs from "node:fs";
import path from "node:path";
import { hashModFiles } from "@claude-desktop/shared/mod-hash";
import { MOD_BUNDLE_MAX_BYTES, MOD_HOST_API } from "@claude-desktop/shared";
import {
  getBundledModsDir,
  getModCacheDir,
  getModCachePath,
  type RuntimePathEnv,
} from "./runtime-paths";

export type ModPackInfo = {
  id: string;
  name: string;
  version: string;
  checksum: string;
  packDir: string;
  source: "bundled" | "cache";
};

export type ModManifest = {
  id: string;
  name: string;
  version: string;
  hostApi: number;
  permissions: string[];
  seats: { min: number; max: number; roles: string[] };
  agent: boolean;
};

export type LoadedMod = {
  dir: string;
  manifest: ModManifest;
  manifestSource: string;
  hostJsSource: string;
  checksum: string;
};

export type BundleFile = { name: string; bytes: Buffer };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function parseManifest(raw: unknown): ModManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("manifest must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.id)) throw new Error("id is required");
  if (!isNonEmptyString(o.name)) throw new Error("name is required");
  if (!isNonEmptyString(o.version)) throw new Error("version is required");
  if (o.hostApi !== MOD_HOST_API) {
    throw new Error(`hostApi must be ${MOD_HOST_API}`);
  }
  if (o.permissions !== undefined) {
    if (!Array.isArray(o.permissions)) {
      throw new Error("permissions must be an empty array");
    }
    if (o.permissions.length > 0) {
      throw new Error("permissions must be empty");
    }
  }
  if (!o.seats || typeof o.seats !== "object" || Array.isArray(o.seats)) {
    throw new Error("seats is required");
  }
  const seatsRaw = o.seats as Record<string, unknown>;
  if (!isInt(seatsRaw.min) || !isInt(seatsRaw.max)) {
    throw new Error("seats.min/max must be integers");
  }
  if (seatsRaw.min < 1 || seatsRaw.max < seatsRaw.min) {
    throw new Error("seats.min/max invalid");
  }
  let roles: string[] = [];
  if (seatsRaw.roles !== undefined) {
    if (
      !Array.isArray(seatsRaw.roles) ||
      seatsRaw.roles.some((r) => typeof r !== "string")
    ) {
      throw new Error("seats.roles must be strings");
    }
    roles = seatsRaw.roles as string[];
  }
  if (o.agent !== undefined && typeof o.agent !== "boolean") {
    throw new Error("agent must be a boolean");
  }
  return {
    id: o.id.trim(),
    name: o.name.trim(),
    version: o.version.trim(),
    hostApi: MOD_HOST_API,
    permissions: [],
    seats: { min: seatsRaw.min, max: seatsRaw.max, roles },
    agent: o.agent === true,
  };
}

export function loadModDir(dir: string): LoadedMod {
  const uiPath = path.join(dir, "ui.js");
  if (fs.existsSync(uiPath)) {
    throw new Error("ui.js is not allowed");
  }
  const hostPath = path.join(dir, "host.js");
  if (!fs.existsSync(hostPath)) {
    throw new Error("host.js is required");
  }
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json is required");
  }
  const manifestSource = fs.readFileSync(manifestPath, "utf8");
  const hostJsSource = fs.readFileSync(hostPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestSource);
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  const manifest = parseManifest(parsed);
  const checksum = hashModFiles(manifestSource, hostJsSource);
  return { dir, manifest, manifestSource, hostJsSource, checksum };
}

function writeAtomicDir(dest: string, files: { name: string; body: string }[]): void {
  const parent = path.dirname(dest);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(
    parent,
    `.tmp-${path.basename(dest)}-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const f of files) {
      fs.writeFileSync(path.join(tmp, f.name), f.body, "utf8");
    }
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

export function writeModCache(env: RuntimePathEnv, loaded: LoadedMod): string {
  const dest = getModCachePath(env, loaded.checksum);
  writeAtomicDir(dest, [
    { name: "manifest.json", body: loaded.manifestSource },
    { name: "host.js", body: loaded.hostJsSource },
  ]);
  return dest;
}

export function loadModCache(env: RuntimePathEnv, checksum: string): LoadedMod {
  const dir = getModCachePath(env, checksum);
  if (!fs.existsSync(dir)) {
    throw new Error(`mod cache miss: ${checksum}`);
  }
  const loaded = loadModDir(dir);
  if (loaded.checksum !== checksum) {
    throw new Error("mod cache checksum mismatch");
  }
  return loaded;
}

export function hasModCache(env: RuntimePathEnv, checksum: string): boolean {
  try {
    loadModCache(env, checksum);
    return true;
  } catch {
    return false;
  }
}

function packInfo(loaded: LoadedMod, source: "bundled" | "cache"): ModPackInfo {
  return {
    id: loaded.manifest.id,
    name: loaded.manifest.name,
    version: loaded.manifest.version,
    checksum: loaded.checksum,
    packDir: loaded.dir,
    source,
  };
}

function readPackDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if (fs.statSync(dir).isDirectory()) out.push(dir);
    } catch {
      // skip
    }
  }
  return out;
}

export function listModPacks(
  env: RuntimePathEnv,
  bundledDir = getBundledModsDir(env),
): ModPackInfo[] {
  const out: ModPackInfo[] = [];
  const seen = new Set<string>();
  for (const dir of readPackDirs(bundledDir)) {
    try {
      const loaded = loadModDir(dir);
      if (seen.has(loaded.checksum)) continue;
      seen.add(loaded.checksum);
      out.push(packInfo({ ...loaded, dir }, "bundled"));
    } catch {
      // skip invalid packs
    }
  }
  for (const dir of readPackDirs(getModCacheDir(env))) {
    try {
      const loaded = loadModDir(dir);
      if (seen.has(loaded.checksum)) continue;
      seen.add(loaded.checksum);
      out.push(packInfo(loaded, "cache"));
    } catch {
      // skip invalid / incomplete cache
    }
  }
  return out;
}

export function listBundleFiles(loaded: LoadedMod): BundleFile[] {
  return [
    { name: "manifest.json", bytes: Buffer.from(loaded.manifestSource, "utf8") },
    { name: "host.js", bytes: Buffer.from(loaded.hostJsSource, "utf8") },
  ];
}

export function readModBytes(loaded: LoadedMod): Buffer {
  const bytes = Buffer.from(
    JSON.stringify({
      manifest: loaded.manifestSource,
      hostJs: loaded.hostJsSource,
    }),
    "utf8",
  );
  if (bytes.length > MOD_BUNDLE_MAX_BYTES) {
    throw new Error(`mod envelope exceeds ${MOD_BUNDLE_MAX_BYTES} bytes`);
  }
  return bytes;
}

export function writeModBytes(env: RuntimePathEnv, bytes: Buffer): LoadedMod {
  if (bytes.length > MOD_BUNDLE_MAX_BYTES) {
    throw new Error(`mod envelope exceeds ${MOD_BUNDLE_MAX_BYTES} bytes`);
  }
  let parsed: { manifest?: unknown; hostJs?: unknown };
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as typeof parsed;
  } catch {
    throw new Error("mod envelope is not valid JSON");
  }
  if (typeof parsed.manifest !== "string" || typeof parsed.hostJs !== "string") {
    throw new Error("mod envelope requires manifest and hostJs strings");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(parsed.manifest);
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  const manifest = parseManifest(raw);
  const checksum = hashModFiles(parsed.manifest, parsed.hostJs);
  const loaded: LoadedMod = {
    dir: getModCachePath(env, checksum),
    manifest,
    manifestSource: parsed.manifest,
    hostJsSource: parsed.hostJs,
    checksum,
  };
  writeModCache(env, loaded);
  return loaded;
}
