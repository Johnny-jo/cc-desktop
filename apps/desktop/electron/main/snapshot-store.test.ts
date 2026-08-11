import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotStore } from "./snapshot-store";

describe("SnapshotStore", () => {
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

  it("captures first write only (first-write-wins)", () => {
    const p = workFile("a.txt", "original");
    store.capture("s1", p);
    fs.writeFileSync(p, "edited", "utf8");
    store.capture("s1", p); // must NOT overwrite snapshot
    expect(store.has("s1", p)).toBe(true);
    expect(store.restore("s1", p)).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("original");
  });

  it("restores absent files by deleting them", () => {
    const p = workFile("new.txt"); // does not exist yet
    store.capture("s1", p);
    fs.writeFileSync(p, "created by agent", "utf8");
    expect(store.restore("s1", p)).toBe(true);
    expect(fs.existsSync(p)).toBe(false);
  });

  it("restore returns false when no snapshot exists", () => {
    const p = workFile("b.txt", "x");
    expect(store.restore("s1", p)).toBe(false);
  });

  it("list returns snapshotted paths per session", () => {
    const a = workFile("a.txt", "1");
    const b = workFile("b.txt", "2");
    store.capture("s1", a);
    store.capture("s1", b);
    store.capture("s2", workFile("other.txt", "3"));
    expect(store.list("s1").sort()).toEqual([a, b].sort());
    expect(store.list("s2")).toHaveLength(1);
    expect(store.list("nope")).toEqual([]);
  });

  it("restoreAll restores every snapshot and reports failures", () => {
    const a = workFile("a.txt", "orig-a");
    const b = workFile("b.txt", "orig-b");
    store.capture("s1", a);
    store.capture("s1", b);
    fs.writeFileSync(a, "changed-a", "utf8");
    fs.writeFileSync(b, "changed-b", "utf8");
    const res = store.restoreAll("s1");
    expect(res.failed).toEqual([]);
    expect(res.restored.sort()).toEqual([a, b].sort());
    expect(fs.readFileSync(a, "utf8")).toBe("orig-a");
    expect(fs.readFileSync(b, "utf8")).toBe("orig-b");
  });

  it("drop / dropAll remove snapshots", () => {
    const a = workFile("a.txt", "1");
    const b = workFile("b.txt", "2");
    store.capture("s1", a);
    store.capture("s1", b);
    store.drop("s1", a);
    expect(store.has("s1", a)).toBe(false);
    expect(store.has("s1", b)).toBe(true);
    store.dropAll("s1");
    expect(store.list("s1")).toEqual([]);
  });

  it("snapshots survive store re-instantiation (restart)", () => {
    const p = workFile("a.txt", "original");
    store.capture("s1", p);
    fs.writeFileSync(p, "edited", "utf8");
    const again = new SnapshotStore(userDataDir);
    expect(again.has("s1", p)).toBe(true);
    expect(again.restore("s1", p)).toBe(true);
    expect(fs.readFileSync(p, "utf8")).toBe("original");
  });
});
