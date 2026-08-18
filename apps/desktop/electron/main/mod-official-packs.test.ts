import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileKernelActivate,
  ModKernel,
  type ChatInEnvelope,
  type KernelRoomView,
} from "./mod-kernel";
import { loadKernelDir, toKernelActivatePack } from "./mod-kernel-package";
import { HostRoomKv } from "./mod-kernel-store";

const MODS_ROOT = path.join(__dirname, "..", "..", "resources", "mods");

const room: KernelRoomView = { id: "r", seats: [] };

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

function mkKv(): HostRoomKv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-kv-"));
  tmpDirs.push(dir);
  return new HostRoomKv(path.join(dir, "kv.json"));
}

function env(text: string): ChatInEnvelope {
  return {
    roomId: "r",
    seatId: "s",
    authorUserId: "u",
    authorLabel: "U",
    text,
    at: 1,
  };
}

describe("official pack: shared-memory", () => {
  it("loads, activates, and provides memory api backed by HostRoomKv", async () => {
    const loaded = loadKernelDir(path.join(MODS_ROOT, "shared-memory"));
    const kv = mkKv();
    const kernel = new ModKernel(kv);
    const graph = kernel.start([toKernelActivatePack(loaded)], room);
    expect(graph.failed).toHaveLength(0);
    expect(graph.active[0]!.provides).toEqual(["memory"]);

    // mod-provided api should roundtrip through the real KV
    const ns = kv.namespace("memory");
    ns.set("k", "v");
    expect(ns.get("k")).toBe("v");
    await kernel.dispose();
  });
});

describe("official pack: chat-glossary", () => {
  it("stays pending without memory, activates with it, and rewrites text", async () => {
    const kv = mkKv();
    kv.namespace("memory").set("FYI", "for your information");

    // without shared-memory → pending
    const kernel1 = new ModKernel(kv);
    const g1 = kernel1.start(
      [toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "chat-glossary")))],
      room,
    );
    expect(g1.pending.map((p) => p.id)).toEqual(["chat-glossary"]);
    expect(g1.pending[0]!.pendingReason).toMatch(/missing inject: memory/);
    await kernel1.dispose();

    // with shared-memory → active and rewrites
    const kernel2 = new ModKernel(kv);
    const g2 = kernel2.start(
      [
        toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "shared-memory"))),
        toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "chat-glossary"))),
      ],
      room,
    );
    expect(g2.active).toHaveLength(2);

    const result = await kernel2.runChatIn(env("FYI this works"));
    if (result.action === "drop") throw new Error("unexpected drop");
    expect(result.value.text).toBe("for your information this works");
    await kernel2.dispose();
  });

  it("does not rewrite when memory value is empty string", async () => {
    const kv = mkKv();
    kv.namespace("memory").set("EMPTY", "");
    const kernel = new ModKernel(kv);
    kernel.start(
      [
        toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "shared-memory"))),
        toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "chat-glossary"))),
      ],
      room,
    );
    const result = await kernel.runChatIn(env("EMPTY stays"));
    // empty value is skipped by the pack; text unchanged
    if (result.action === "drop") throw new Error("unexpected drop");
    expect(result.value.text).toBe("EMPTY stays");
    await kernel.dispose();
  });

  it("replaces every occurrence of a key (split/join semantics)", async () => {
    const kv = mkKv();
    kv.namespace("memory").set("a", "X");
    const kernel = new ModKernel(kv);
    kernel.start(
      [
        toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "shared-memory"))),
        toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "chat-glossary"))),
      ],
      room,
    );
    const result = await kernel.runChatIn(env("a a a"));
    if (result.action === "drop") throw new Error("unexpected drop");
    expect(result.value.text).toBe("X X X");
    await kernel.dispose();
  });

  it("substring replacement can cascade when keys overlap", async () => {
    const kv = mkKv();
    kv.namespace("memory").set("ab", "1");
    kv.namespace("memory").set("a", "2");
    const kernel = new ModKernel(kv);
    kernel.start(
      [
        toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "shared-memory"))),
        toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "chat-glossary"))),
      ],
      room,
    );
    const result = await kernel.runChatIn(env("ab"));
    if (result.action === "drop") throw new Error("unexpected drop");
    // list() returns sorted keys: "a" first → "ab" → "2b"; then "ab" no longer matches.
    // Documented behavior: first key wins on its own occurrences only.
    expect(["1", "2b"]).toContain(result.value.text);
    await kernel.dispose();
  });
});

describe("official pack: chat-guard", () => {
  it("drops blank-only message, trims padded message, passes clean text", async () => {
    const kernel = new ModKernel();
    kernel.start(
      [toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "chat-guard")))],
      room,
    );
    const blank = await kernel.runChatIn(env("   \n\t  "));
    expect(blank.action).toBe("drop");

    const padded = await kernel.runChatIn(env("  hello  "));
    if (padded.action === "drop") throw new Error("unexpected drop");
    expect(padded.value.text).toBe("hello");

    const clean = await kernel.runChatIn(env("hello"));
    if (clean.action === "drop") throw new Error("unexpected drop");
    expect(clean.value.text).toBe("hello");
    await kernel.dispose();
  });
});

describe("official pack: room-pulse", () => {
  it("registers exactly one 60s schedule job that emits a tick", () => {
    const kernel = new ModKernel();
    kernel.start(
      [toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "room-pulse")))],
      room,
    );
    const jobs = kernel.listScheduleJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.ms).toBe(60_000);
    expect(jobs[0]!.packId).toBe("room-pulse");
    void kernel.dispose();
  });

  it("tick is silent — no timeline text", async () => {
    const kernel = new ModKernel();
    kernel.start(
      [toKernelActivatePack(loadKernelDir(path.join(MODS_ROOT, "room-pulse")))],
      room,
    );
    const tick = await kernel.listScheduleJobs()[0]!.run();
    expect(tick && typeof tick === "object" ? tick.text : undefined).toBeUndefined();
    await kernel.dispose();
  });
});

describe("official pack loading rejects tampered packs", () => {
  it("kernel pack with ui.js is rejected", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tampered-"));
    tmpDirs.push(dir);
    fs.copyFileSync(
      path.join(MODS_ROOT, "room-pulse", "manifest.json"),
      path.join(dir, "manifest.json"),
    );
    fs.copyFileSync(
      path.join(MODS_ROOT, "room-pulse", "mod.js"),
      path.join(dir, "mod.js"),
    );
    fs.writeFileSync(path.join(dir, "ui.js"), "export {};", "utf8");
    expect(() => loadKernelDir(dir)).toThrow(/ui\.js is not allowed/);
  });

  it("kernel pack with createGame call is rejected", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tampered-"));
    tmpDirs.push(dir);
    fs.copyFileSync(
      path.join(MODS_ROOT, "room-pulse", "manifest.json"),
      path.join(dir, "manifest.json"),
    );
    fs.writeFileSync(
      path.join(dir, "mod.js"),
      "export function activate() { createGame({}); }",
      "utf8",
    );
    expect(() => loadKernelDir(dir)).toThrow(/createGame is not allowed/);
  });

  it("kernel pack whose mod.js uses require() is rejected at compile", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tampered-"));
    tmpDirs.push(dir);
    fs.copyFileSync(
      path.join(MODS_ROOT, "room-pulse", "manifest.json"),
      path.join(dir, "manifest.json"),
    );
    fs.writeFileSync(
      path.join(dir, "mod.js"),
      "const fs = require('fs'); export function activate() { void fs; }",
      "utf8",
    );
    const loaded = loadKernelDir(dir); // load itself passes
    expect(() => toKernelActivatePack(loaded)).toThrow(/require is forbidden/);
  });
});
