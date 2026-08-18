import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KernelImproveStore } from "./mod-kernel-improve";
import { HostRoomKv, KERNEL_VALUE_MAX_BYTES } from "./mod-kernel-store";

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

const tmp = (name: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "krobust-"));
  dirs.push(d);
  return path.join(d, name);
};

describe("KernelImproveStore robustness", () => {
  it("caps proposals at MAX_PROP and revisions at MAX_REV", () => {
    const s = new KernelImproveStore(tmp("improve.json"));
    for (let i = 0; i < 30; i++) {
      s.addProposal({ packId: "p", modJs: `v${i}`, status: "pending", decision: "pending" });
    }
    expect(s.proposals).toHaveLength(20);
    // newest first
    expect(s.proposals[0]!.modJs).toBe("v29");

    for (let i = 0; i < 12; i++) {
      s.pushRevision({ packId: "p", checksum: `${i}`, manifestSource: "m", modJs: `r${i}`, at: i });
    }
    expect(s.revisions).toHaveLength(8);
    expect(s.revisions[0]!.modJs).toBe("r11");
  });

  it("lives keep only latest per packId, capped at MAX_LIVE", () => {
    const s = new KernelImproveStore(tmp("improve.json"));
    for (let i = 0; i < 30; i++) s.setLive(`p${i}`, `src${i}`);
    expect(s.lives).toHaveLength(20);
    // replace existing pack moves to front without growing
    s.setLive("p29", "updated");
    expect(s.lives).toHaveLength(20);
    expect(s.liveSource("p29")).toBe("updated");
  });

  it("corrupted store file falls back to empty instead of throwing", () => {
    const f = tmp("improve.json");
    fs.writeFileSync(f, "{ not json !!!", "utf8");
    const s = new KernelImproveStore(f);
    expect(s.autonomy).toBe(0);
    expect(s.proposals).toEqual([]);
  });

  it("autonomy outside {0,1,2} in file falls back to 0", () => {
    const f = tmp("improve.json");
    fs.writeFileSync(f, JSON.stringify({ autonomy: 7 }), "utf8");
    const s = new KernelImproveStore(f);
    expect(s.autonomy).toBe(0);
  });

  it("write is atomic via tmp+rename (no partial JSON on crash)", () => {
    const f = tmp("improve.json");
    const s = new KernelImproveStore(f);
    s.setAutonomy(2);
    // tmp file should be renamed away
    expect(fs.existsSync(`${f}.tmp`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(f, "utf8")).autonomy).toBe(2);
  });

  it("updateProposal on unknown id returns null without throwing", () => {
    const s = new KernelImproveStore(tmp("improve.json"));
    expect(s.updateProposal("nope", { status: "applied" })).toBeNull();
  });
});

describe("HostRoomKv robustness — quota boundaries", () => {
  it("value exactly at 8KiB is accepted, 8KiB+1 rejected", () => {
    const kv = new HostRoomKv(tmp("kv.json"));
    const mem = kv.namespace("memory");
    expect(mem.set("k", "x".repeat(KERNEL_VALUE_MAX_BYTES)).ok).toBe(true);
    expect(mem.set("k2", "x".repeat(KERNEL_VALUE_MAX_BYTES + 1))).toEqual({
      ok: false,
      error: "value exceeds 8KiB",
    });
  });

  it("namespace size limit accounts for utf8 multibyte", () => {
    const kv = new HostRoomKv(tmp("kv.json"));
    const mem = kv.namespace("memory");
    // each emoji is 4 bytes
    const big = "🙂".repeat(Math.floor(KERNEL_VALUE_MAX_BYTES / 4));
    const r = mem.set("emoji", big);
    expect(r.ok).toBe(true);
  });

  it("overwrite of existing key accounts for replaced bytes", () => {
    const kv = new HostRoomKv(tmp("kv.json"));
    const mem = kv.namespace("memory");
    mem.set("k", "x".repeat(KERNEL_VALUE_MAX_BYTES));
    // replacing same-size value should not blow the namespace limit
    const r = mem.set("k", "y".repeat(KERNEL_VALUE_MAX_BYTES));
    expect(r.ok).toBe(true);
  });

  it("keys with spaces or unicode are rejected by KERNEL_KEY_RE", () => {
    const kv = new HostRoomKv(tmp("kv.json"));
    const mem = kv.namespace("memory");
    for (const bad of ["has space", "中文键", "a\nb", "key!"]) {
      expect(mem.set(bad, "v")).toEqual({ ok: false, error: "invalid key" });
      expect(mem.get(bad)).toBeUndefined();
    }
  });

  it("search caps at KERNEL_SEARCH_LIMIT and rejects >256 char queries", () => {
    const kv = new HostRoomKv(tmp("kv.json"));
    const mem = kv.namespace("memory");
    for (let i = 0; i < 40; i++) mem.set(`k${i}`, `needle${i}`);
    expect(mem.search("needle")).toHaveLength(20);
    expect(mem.search("q".repeat(257))).toEqual([]);
  });

  it("remove of missing key is an explicit error, not silent ok", () => {
    const kv = new HostRoomKv(tmp("kv.json"));
    expect(kv.remove("memory", "ghost")).toEqual({ ok: false, error: "missing key" });
  });

  it("get on invalid key returns undefined without reading disk", () => {
    const kv = new HostRoomKv(tmp("kv.json"));
    const mem = kv.namespace("memory");
    mem.set("valid", "1");
    expect(mem.get("bad key")).toBeUndefined();
    expect(mem.get("valid")).toBe("1");
  });

  it("invalid namespace name yields dead ns without throwing", () => {
    const kv = new HostRoomKv(tmp("kv.json"));
    const dead = kv.namespace("bad ns!");
    expect(dead.get("k")).toBeUndefined();
    expect(dead.set("k", "v")).toEqual({ ok: false, error: "invalid namespace" });
    expect(dead.list()).toEqual([]);
    expect(dead.search("k")).toEqual([]);
  });
});
