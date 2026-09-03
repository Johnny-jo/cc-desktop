import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotStore } from "./snapshot-store";

describe("SnapshotStore (per-operation)", () => {
  let userDataDir: string;
  let workDir: string;
  let store: SnapshotStore;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-userdata-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-work-"));
    store = new SnapshotStore(userDataDir);
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function workFile(name: string, content?: string): string {
    const p = path.join(workDir, name);
    if (content !== undefined) fs.writeFileSync(p, content, "utf8");
    return p;
  }

  it("captures per-event snapshots; each event restores its own pre-op state", () => {
    const p = workFile("demo.txt", "v0");
    // op1 creates/modifies → snapshot v0
    store.capture("s1", "ev-1", p);
    fs.writeFileSync(p, "v1", "utf8");
    // op2 modifies → snapshot v1
    store.capture("s1", "ev-2", p);
    fs.writeFileSync(p, "v2", "utf8");
    // op3 modifies → snapshot v2
    store.capture("s1", "ev-3", p);
    fs.writeFileSync(p, "v3", "utf8");

    // Rolling back op3 returns to the state after op2 (v2), not pre-session.
    expect(store.restore("s1", "ev-3")).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("v2");
    // Rolling back op1 returns to pre-session (v0).
    expect(store.restore("s1", "ev-1")).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("v0");
  });

  it("restores absent files by deleting them (file created by the op)", () => {
    const p = workFile("new.txt"); // does not exist yet
    store.capture("s1", "ev-1", p);
    fs.writeFileSync(p, "created by agent", "utf8");
    expect(store.restore("s1", "ev-1")).toBe(true);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("pathOf returns the recorded file path", () => {
    const p = workFile("a.txt", "x");
    store.capture("s1", "ev-9", p);
    expect(store.pathOf("s1", "ev-9")).toBe(p);
    expect(store.pathOf("s1", "nope")).toBeNull();
  });

  it("restore returns false when no snapshot exists", () => {
    expect(store.restore("s1", "ev-missing")).toBe(false);
  });

  it("list returns event ids per session", () => {
    const p = workFile("a.txt", "1");
    store.capture("s1", "ev-1", p);
    store.capture("s1", "ev-2", p);
    store.capture("s2", "ev-1", workFile("b.txt", "2"));
    expect(store.list("s1").sort()).toEqual(["ev-1", "ev-2"]);
    expect(store.list("s2")).toEqual(["ev-1"]);
    expect(store.list("nope")).toEqual([]);
  });

  it("drop removes snapshot + sidecar", () => {
    const p = workFile("a.txt", "1");
    store.capture("s1", "ev-1", p);
    store.drop("s1", "ev-1");
    expect(store.has("s1", "ev-1")).toBe(false);
    expect(store.pathOf("s1", "ev-1")).toBeNull();
  });

  it("snapshots survive store re-instantiation (restart)", () => {
    const p = workFile("a.txt", "original");
    store.capture("s1", "ev-1", p);
    fs.writeFileSync(p, "edited", "utf8");
    const again = new SnapshotStore(userDataDir);
    expect(again.has("s1", "ev-1")).toBe(true);
    expect(again.pathOf("s1", "ev-1")).toBe(p);
    expect(again.restore("s1", "ev-1")).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("original");
  });

  it("compresses larger snapshots and restores them transparently", () => {
    store = new SnapshotStore(userDataDir, {
      compressionThresholdBytes: 16,
    });
    const original = "compress me\n".repeat(200);
    const p = workFile("large.txt", original);
    store.capture("s1", "ev-gzip", p);

    expect(
      fs.existsSync(
        path.join(userDataDir, "snapshots", "s1", "ev-gzip.snap.gz"),
      ),
    ).toBe(true);
    fs.writeFileSync(p, "changed", "utf8");
    expect(store.restore("s1", "ev-gzip")).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe(original);
  });

  it("skips a file larger than the per-snapshot limit", () => {
    store = new SnapshotStore(userDataDir, { maxFileBytes: 3 });
    const p = workFile("too-large.txt", "1234");
    store.capture("s1", "ev-large", p);
    expect(store.has("s1", "ev-large")).toBe(false);
  });

  it("startup cleanup removes snapshots for sessions that no longer exist", () => {
    const p = workFile("a.txt", "a");
    store.capture("keep", "ev-1", p);
    store.capture("orphan", "ev-2", p);

    const result = store.cleanup(new Set(["keep"]));
    expect(store.has("keep", "ev-1")).toBe(true);
    expect(store.has("orphan", "ev-2")).toBe(false);
    expect(result.removedSessions).toBe(1);
  });

  it("startup cleanup expires old snapshots", () => {
    store = new SnapshotStore(userDataDir, {
      retentionMs: 1_000,
      compressionThresholdBytes: Number.MAX_SAFE_INTEGER,
    });
    const p = workFile("old.txt", "old");
    store.capture("s1", "ev-old", p);
    const dir = path.join(userDataDir, "snapshots", "s1");
    const old = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(dir, "ev-old.snap"), old, old);
    fs.utimesSync(path.join(dir, "ev-old.json"), old, old);

    const result = store.cleanup(new Set(["s1"]), old.getTime() + 2_000);
    expect(store.has("s1", "ev-old")).toBe(false);
    expect(result.removedEvents).toBe(1);
  });

  it("enforces the total capacity after capture", () => {
    store = new SnapshotStore(userDataDir, {
      maxTotalBytes: 1,
      compressionThresholdBytes: Number.MAX_SAFE_INTEGER,
    });
    const p = workFile("cap.txt", "content");
    store.capture("s1", "ev-cap", p);
    expect(store.has("s1", "ev-cap")).toBe(false);
  });
});
