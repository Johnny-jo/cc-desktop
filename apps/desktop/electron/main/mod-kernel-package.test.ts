import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseManifest } from "./mod-package";
import { listKernelPacks, loadKernelDir, peekHostApi } from "./mod-kernel-package";
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

describe("kernel package loader", () => {
  it("loads official shared-memory and rejects play packs", () => {
    const bundled = path.resolve(__dirname, "../../resources/mods");
    expect(peekHostApi(path.join(bundled, "shared-memory"))).toBe(2);
    const loaded = loadKernelDir(path.join(bundled, "shared-memory"));
    expect(loaded.manifest.id).toBe("shared-memory");
    expect(loaded.manifest.provides).toContain("memory");
    expect(() => loadKernelDir(path.join(bundled, "werewolf"))).toThrow(/host.js/);
    expect(() =>
      parseManifest({
        id: "shared-memory",
        name: "x",
        version: "1",
        hostApi: 2,
        permissions: [],
        seats: { min: 1, max: 2, roles: [] },
      }),
    ).toThrow(/hostApi must be 1/);
  });

  it("lists kernel packs separately from play packs", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "klist-"));
    dirs.push(userDataDir);
    const env: RuntimePathEnv = {
      isPackaged: false,
      userDataDir,
    };
    const list = listKernelPacks(env);
    expect(list.some((p) => p.id === "shared-memory")).toBe(true);
    expect(list.some((p) => p.id === "werewolf")).toBe(false);
  });
});
