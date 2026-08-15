import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashModFiles } from "@claude-desktop/shared/mod-hash";
import { MOD_BUNDLE_MAX_BYTES } from "@claude-desktop/shared";
import {
  hasModCache,
  listModPacks,
  loadModCache,
  loadModDir,
  parseManifest,
  readModBytes,
  writeModBytes,
  writeModCache,
} from "./mod-package";
import type { RuntimePathEnv } from "./runtime-paths";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dirs.length = 0;
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mod-pkg-"));
  dirs.push(d);
  return d;
}

function envFor(userDataDir: string): RuntimePathEnv {
  return { isPackaged: false, userDataDir, platform: "win32" };
}

const VALID_MANIFEST = {
  id: "werewolf",
  name: "狼人杀",
  version: "1.0.0",
  hostApi: 1,
  permissions: [] as string[],
  seats: { min: 4, max: 12, roles: ["seer", "wolf", "villager", "judge"] },
  agent: true,
};

const VALID_HOST = "export function createGame() { return {}; }\n";

function writePack(
  dir: string,
  opts?: {
    manifest?: unknown;
    hostJs?: string | null;
    uiJs?: string;
    manifestText?: string;
  },
): string {
  fs.mkdirSync(dir, { recursive: true });
  const text =
    opts?.manifestText ??
    JSON.stringify(opts?.manifest ?? VALID_MANIFEST, null, 2);
  fs.writeFileSync(path.join(dir, "manifest.json"), text, "utf8");
  if (opts?.hostJs !== null) {
    fs.writeFileSync(path.join(dir, "host.js"), opts?.hostJs ?? VALID_HOST, "utf8");
  }
  if (opts?.uiJs !== undefined) {
    fs.writeFileSync(path.join(dir, "ui.js"), opts.uiJs, "utf8");
  }
  return dir;
}

describe("parseManifest", () => {
  it("accepts a valid v1 manifest", () => {
    const m = parseManifest(VALID_MANIFEST);
    expect(m.id).toBe("werewolf");
    expect(m.hostApi).toBe(1);
    expect(m.permissions).toEqual([]);
    expect(m.seats.min).toBe(4);
    expect(m.seats.max).toBe(12);
    expect(m.agent).toBe(true);
  });

  it("rejects permissions: [\"net\"]", () => {
    expect(() =>
      parseManifest({ ...VALID_MANIFEST, permissions: ["net"] }),
    ).toThrow(/permissions/);
  });

  it("rejects hostApi: 2", () => {
    expect(() => parseManifest({ ...VALID_MANIFEST, hostApi: 2 })).toThrow(
      /hostApi/,
    );
  });
});

describe("loadModDir", () => {
  it("loads a valid pack and checksum === hashModFiles", () => {
    const dir = writePack(path.join(tmp(), "pack"));
    const loaded = loadModDir(dir);
    expect(loaded.manifest.id).toBe("werewolf");
    expect(loaded.checksum).toBe(
      hashModFiles(loaded.manifestSource, loaded.hostJsSource),
    );
    expect(loaded.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects missing host.js", () => {
    const dir = writePack(path.join(tmp(), "pack"), { hostJs: null });
    expect(() => loadModDir(dir)).toThrow(/host\.js/);
  });

  it("rejects ui.js present", () => {
    const dir = writePack(path.join(tmp(), "pack"), { uiJs: "export {}\n" });
    expect(() => loadModDir(dir)).toThrow(/ui\.js/);
  });

  it("rejects permissions: [\"net\"]", () => {
    const dir = writePack(path.join(tmp(), "pack"), {
      manifest: { ...VALID_MANIFEST, permissions: ["net"] },
    });
    expect(() => loadModDir(dir)).toThrow(/permissions/);
  });

  it("rejects hostApi: 2", () => {
    const dir = writePack(path.join(tmp(), "pack"), {
      manifest: { ...VALID_MANIFEST, hostApi: 2 },
    });
    expect(() => loadModDir(dir)).toThrow(/hostApi/);
  });
});

describe("mod cache", () => {
  it("write + loadModCache round-trips", () => {
    const root = tmp();
    const dir = writePack(path.join(root, "pack"));
    const loaded = loadModDir(dir);
    const e = envFor(path.join(root, "ud"));
    const dest = writeModCache(e, loaded);
    expect(fs.existsSync(path.join(dest, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "host.js"))).toBe(true);
    const cached = loadModCache(e, loaded.checksum);
    expect(cached.checksum).toBe(loaded.checksum);
    expect(cached.manifestSource).toBe(loaded.manifestSource);
    expect(cached.hostJsSource).toBe(loaded.hostJsSource);
    expect(cached.manifest.id).toBe("werewolf");
  });

  it("rejects an envelope larger than MOD_BUNDLE_MAX_BYTES", () => {
    const e = envFor(path.join(tmp(), "ud"));
    const hostJs = `${VALID_HOST}${"x".repeat(MOD_BUNDLE_MAX_BYTES)}`;
    const bytes = Buffer.from(
      JSON.stringify({ manifest: JSON.stringify(VALID_MANIFEST), hostJs }),
      "utf8",
    );
    expect(bytes.length).toBeGreaterThan(MOD_BUNDLE_MAX_BYTES);
    expect(() => writeModBytes(e, bytes)).toThrow(/exceeds|bytes|envelope/i);
  });

  it("readModBytes / writeModBytes round-trip through cache", () => {
    const root = tmp();
    const loaded = loadModDir(writePack(path.join(root, "pack")));
    const bytes = readModBytes(loaded);
    expect(bytes.length).toBeLessThanOrEqual(MOD_BUNDLE_MAX_BYTES);
    const e = envFor(path.join(root, "ud"));
    const written = writeModBytes(e, bytes);
    expect(written.checksum).toBe(loaded.checksum);
    expect(written.hostJsSource).toBe(loaded.hostJsSource);
  });

  it("listModPacks returns bundled then uncached cache entries", () => {
    const root = tmp();
    const bundledRoot = path.join(root, "bundled");
    const a = loadModDir(writePack(path.join(bundledRoot, "vote")));
    const e = envFor(path.join(root, "ud"));
    writeModCache(e, a);
    const other = loadModDir(
      writePack(path.join(root, "other"), {
        manifest: { ...VALID_MANIFEST, id: "vote-extra", name: "Extra" },
      }),
    );
    writeModCache(e, other);
    const listed = listModPacks(e, bundledRoot);
    expect(listed.some((p) => p.source === "bundled" && p.id === "werewolf")).toBe(
      true,
    );
    expect(listed.filter((p) => p.checksum === a.checksum)).toHaveLength(1);
    expect(listed.some((p) => p.source === "cache" && p.id === "vote-extra")).toBe(
      true,
    );
    expect(hasModCache(e, a.checksum)).toBe(true);
    expect(hasModCache(e, "ab".repeat(32))).toBe(false);
  });
});
