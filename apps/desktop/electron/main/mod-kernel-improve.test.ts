import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKernelManifest } from "./mod-kernel";
import {
  decideImproveApply,
  KernelImproveStore,
  sameCapabilityBoundary,
  trialKernelSource,
} from "./mod-kernel-improve";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpDirs.length = 0;
});

const man = (partial: Record<string, unknown>) =>
  parseKernelManifest({
    id: "mem",
    version: "1.0.0",
    hostApi: 2,
    inject: [],
    provides: ["memory"],
    permissions: ["storage:room"],
    hooks: [],
    ...partial,
  });

describe("sameCapabilityBoundary", () => {
  it("ignores name/version/budget but rejects permission or provide changes", () => {
    const a = man({ name: "A", version: "1.0.0", budget: { hookPerMin: 1 } });
    const b = man({ name: "B", version: "2.0.0", budget: { hookPerMin: 9 } });
    expect(sameCapabilityBoundary(a, b)).toBe(true);
    expect(sameCapabilityBoundary(a, man({ permissions: [] }))).toBe(false);
    expect(sameCapabilityBoundary(a, man({ provides: ["memory", "other"] }))).toBe(
      false,
    );
  });
});

describe("trialKernelSource", () => {
  const okSrc = `
    export function activate(ctx) {
      ctx.provide("memory", { get: function () { return "x"; } });
    }
  `;
  it("accepts a same-manifest activate and rejects forbidden imports", () => {
    const m = man({});
    const ok = trialKernelSource(m, okSrc);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.provides).toEqual(["memory"]);
    const bad = trialKernelSource(m, "import fs from 'node:fs'; export function activate() {}");
    expect(bad.ok).toBe(false);
  });
});

describe("decideImproveApply", () => {
  it("L0 parks, L1 applies only same provides, L2 applies after trial", () => {
    expect(
      decideImproveApply({
        autonomy: 0,
        trialOk: true,
        currentProvides: ["memory"],
        nextProvides: ["memory"],
      }),
    ).toBe("pending");
    expect(
      decideImproveApply({
        autonomy: 1,
        trialOk: true,
        currentProvides: ["memory"],
        nextProvides: ["memory"],
      }),
    ).toBe("apply");
    expect(
      decideImproveApply({
        autonomy: 1,
        trialOk: true,
        currentProvides: ["memory"],
        nextProvides: [],
      }),
    ).toBe("pending");
    expect(
      decideImproveApply({
        autonomy: 2,
        trialOk: true,
        currentProvides: ["memory"],
        nextProvides: [],
      }),
    ).toBe("apply");
    expect(
      decideImproveApply({
        autonomy: 2,
        trialOk: false,
        currentProvides: [],
        nextProvides: [],
      }),
    ).toBe("reject");
  });
});

describe("KernelImproveStore live source", () => {
  it("persists the latest live mod.js per pack across reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "improve-live-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "improve.json");
    const a = new KernelImproveStore(file);
    a.setLive("rewriter", "export function activate() {}");
    const b = new KernelImproveStore(file);
    expect(b.liveSource("rewriter")).toBe("export function activate() {}");
    expect(b.liveSource("other")).toBeUndefined();
  });
});
