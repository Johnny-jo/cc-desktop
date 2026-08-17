import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostRoomKv, KERNEL_NS_MAX_KEYS } from "./mod-kernel-store";

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

function storeFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kstore-"));
  dirs.push(d);
  return path.join(d, "room.kernel-store.json");
}

describe("HostRoomKv", () => {
  it("round-trips string values and persists", () => {
    const file = storeFile();
    const kv = new HostRoomKv(file);
    const mem = kv.namespace("memory");
    expect(mem.set("note", "hello")).toEqual({ ok: true });
    expect(mem.get("note")).toBe("hello");
    expect(mem.list()).toEqual(["note"]);
    expect(mem.search("ell")).toEqual([{ key: "note", value: "hello" }]);

    const again = new HostRoomKv(file);
    expect(again.namespace("memory").get("note")).toBe("hello");
  });

  it("enforces quotas and rejects bad keys without throwing", () => {
    const kv = new HostRoomKv(storeFile());
    const mem = kv.namespace("memory");
    expect(mem.set("bad key", "a")).toEqual({ ok: false, error: "invalid key" });
    expect(mem.set("k", "x".repeat(KERNEL_NS_MAX_KEYS * 40))).toMatchObject({
      ok: false,
    });
    for (let i = 0; i < KERNEL_NS_MAX_KEYS; i++) {
      expect(mem.set(`k${i}`, "v")).toEqual({ ok: true });
    }
    expect(mem.set("overflow", "v")).toEqual({
      ok: false,
      error: "namespace key limit",
    });
    expect(mem.get("k0")).toBe("v");
    expect(mem.search("")).toEqual([]);
  });

  it("seal blocks writes; deleteFile removes persist", () => {
    const file = storeFile();
    const kv = new HostRoomKv(file);
    kv.namespace("memory").set("a", "1");
    kv.seal();
    expect(kv.namespace("memory").set("b", "2")).toEqual({
      ok: false,
      error: "store is sealed",
    });
    expect(kv.namespace("memory").get("a")).toBe("1");
    kv.deleteFile();
    expect(fs.existsSync(file)).toBe(false);
  });
});
