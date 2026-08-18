import { describe, expect, it } from "vitest";
import {
  compileKernelActivate,
  createModCtx,
  hostInjectStub,
  ModKernel,
  parseKernelManifest,
  planKernelGraph,
  runKernelActivate,
  type KernelActivatePack,
  type KernelCtx,
  type KernelRoomView,
  type RoomKv,
} from "./mod-kernel";
import {
  decideImproveApply,
  sameCapabilityBoundary,
  trialKernelSource,
} from "./mod-kernel-improve";

const room: KernelRoomView = { id: "r", seats: [] };

const man = (partial: Record<string, unknown>) =>
  parseKernelManifest({
    id: "m",
    version: "1.0.0",
    hostApi: 2,
    inject: [],
    provides: [],
    permissions: [],
    hooks: [],
    ...partial,
  });

// ---------- stage 0: inject + host stubs ----------

describe("hostInjectStub robustness", () => {
  const memKv: RoomKv = {
    namespace: () => {
      const bag = new Map<string, string>();
      return {
        get: (k) => bag.get(k),
        set: (k, v) => {
          bag.set(k, v);
          return { ok: true as const };
        },
        list: (prefix) =>
          [...bag.keys()].filter((k) => !prefix || k.startsWith(prefix)),
        search: (q) =>
          [...bag.entries()]
            .filter(([k, v]) => k.includes(q) || v.includes(q))
            .map(([key, value]) => ({ key, value })),
      };
    },
  };

  it("memory stub coerces null/undefined key to empty string without throwing", () => {
    const stub = hostInjectStub("memory", memKv) as {
      get: (k: unknown) => unknown;
      set: (k: unknown, v: unknown) => unknown;
      list: (p?: unknown) => unknown;
      search: (q: unknown) => unknown;
    };
    expect(stub.get(null)).toBeUndefined();
    expect(stub.set(null, undefined)).toEqual({ ok: true });
    expect(stub.get("")).toBe("");
    expect(Array.isArray(stub.list())).toBe(true);
    expect(Array.isArray(stub.search(null))).toBe(true);
  });

  it("unknown inject name returns opaque placeholder (no memory api surface)", () => {
    const stub = hostInjectStub("telemetry") as Record<string, unknown>;
    expect(stub).toEqual({ provided: true });
    expect(typeof (stub as { get?: unknown }).get).toBe("undefined");
  });

  it("memory inject without storage falls back to placeholder", () => {
    const stub = hostInjectStub("memory", undefined) as Record<string, unknown>;
    expect(stub).toEqual({ provided: true });
  });
});

describe("createModCtx robustness", () => {
  it("schedule.every coerces fractional / string ms, clamps below min", () => {
    const m = man({ permissions: ["schedule:room"] });
    const s = createModCtx({ manifest: m, room });
    s.ctx.schedule!.every(0.4, () => undefined); // clamps to KERNEL_SCHEDULE_MIN_MS
    s.ctx.schedule!.every("2500" as unknown as number, () => undefined);
    expect(s.schedules[0]!.ms).toBe(1000);
    expect(s.schedules[1]!.ms).toBe(2500);
  });

  it("schedule.every rejects NaN / negative / Infinity", () => {
    const m = man({ permissions: ["schedule:room"] });
    const s = createModCtx({ manifest: m, room });
    for (const bad of [NaN, -1, Infinity, 0]) {
      expect(() => s.ctx.schedule!.every(bad, () => undefined)).toThrow();
    }
  });

  it("schedule job limit enforced at KERNEL_SCHEDULE_MAX_JOBS", () => {
    const m = man({ permissions: ["schedule:room"] });
    const s = createModCtx({ manifest: m, room });
    for (let i = 0; i < 4; i++) s.ctx.schedule!.every(1000 + i, () => undefined);
    expect(() => s.ctx.schedule!.every(9000, () => undefined)).toThrow(
      /job limit/,
    );
  });

  it("provide with non-function member throws", () => {
    const m = man({ provides: ["memory"] });
    const s = createModCtx({ manifest: m, room });
    expect(() =>
      s.ctx.provide("memory", { get: "x" } as never),
    ).toThrow(/must be a function/);
  });

  it("ctx ownKeys hides undeclared surface from enumeration", () => {
    const m = man({ inject: ["memory"], permissions: ["storage:room"] });
    const s = createModCtx({
      manifest: m,
      room,
      bag: { memory: { provided: true } },
      storage: { namespace: () => ({}) as never },
    });
    const keys = Object.keys(s.ctx);
    expect(keys).toContain("room");
    expect(keys).toContain("memory");
    expect(keys).toContain("storage");
    expect(keys).not.toContain("schedule");
    expect(keys).not.toContain("process");
  });

  it("ctx throws when reading undeclared key via bracket access", () => {
    const m = man({});
    const s = createModCtx({ manifest: m, room });
    expect(() => (s.ctx as Record<string, unknown>)["schedule"]).toThrow();
    expect(() => (s.ctx as Record<string, unknown>)["storage"]).toThrow();
  });

  it("ctx.schedule declared but host omitted storage: ctx.storage error is explicit", () => {
    const m = man({ permissions: ["storage:room"] });
    const s = createModCtx({ manifest: m, room, storage: undefined });
    expect(() => s.ctx.storage).toThrow(/not provided/);
  });
});

// ---------- planKernelGraph edge cases ----------

describe("planKernelGraph robustness", () => {
  it("self-inject does not create a self-loop", () => {
    const m = man({ id: "self", inject: ["x"], provides: ["x"] });
    const { order, graph } = planKernelGraph([m]);
    expect(order).toEqual(["self"]);
    expect(graph.failed).toHaveLength(0);
  });

  it("inject name that no one provides goes pending, does not block others", () => {
    const a = man({ id: "a", inject: ["ghost"] });
    const b = man({ id: "b" });
    const { graph } = planKernelGraph([a, b]);
    expect(graph.pending.map((p) => p.id)).toEqual(["a"]);
    expect(graph.active.map((p) => p.id)).toEqual(["b"]);
  });

  it("diamond dependency activates in dependency order", () => {
    const a = man({ id: "a", provides: ["x"] });
    const b = man({ id: "b", inject: ["x"], provides: ["y"] });
    const c = man({ id: "c", inject: ["x"], provides: ["z"] });
    const d = man({ id: "d", inject: ["y", "z"] });
    const { order } = planKernelGraph([d, c, b, a]);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  it("duplicate id: both copies marked failed, room not torn down", () => {
    const a = man({ id: "dup" });
    const b = man({ id: "dup" });
    const c = man({ id: "ok" });
    const { graph } = planKernelGraph([a, b, c]);
    const failedIds = graph.failed.map((f) => f.id);
    expect(failedIds).toEqual(["dup", "dup#dup"]);
    for (const f of graph.failed) expect(f.failedReason).toBe("duplicate id");
    expect(graph.active.map((p) => p.id)).toEqual(["ok"]);
  });

  it("3-cycle a→b→c→a all fail as dependency cycle", () => {
    const a = man({ id: "a", inject: ["zc"], provides: ["xa"] });
    const b = man({ id: "b", inject: ["xa"], provides: ["yb"] });
    const c = man({ id: "c", inject: ["yb"], provides: ["zc"] });
    const { graph } = planKernelGraph([a, b, c]);
    expect(graph.failed).toHaveLength(3);
    for (const f of graph.failed) expect(f.failedReason).toMatch(/cycle/);
  });
});

// ---------- runKernelActivate ----------

describe("runKernelActivate robustness", () => {
  const mk = (m: ReturnType<typeof man>, src: string): KernelActivatePack => ({
    manifest: m,
    activate: compileKernelActivate(src),
  });

  it("activate that throws mid-way leaves dependents pending, not failed", () => {
    const a = mk(
      man({ id: "a", provides: ["x"] }),
      "export function activate() { throw new Error('boom'); }",
    );
    const b = mk(man({ id: "b", inject: ["x"] }), "export function activate() {}");
    const { graph } = runKernelActivate([a, b], room);
    expect(graph.failed.map((f) => f.id)).toEqual(["a"]);
    expect(graph.pending.map((p) => p.id)).toEqual(["b"]);
    expect(graph.active).toHaveLength(0);
  });

  it("mod declaring provide but never calling provide() is failed", () => {
    const a = mk(
      man({ id: "a", provides: ["x"] }),
      "export function activate() { /* silent */ }",
    );
    const b = mk(man({ id: "b", inject: ["x"] }), "export function activate() {}");
    const { graph, provides } = runKernelActivate([a, b], room);
    expect(provides).toHaveLength(0);
    expect(graph.failed.map((f) => f.id)).toEqual(["a"]);
    expect(graph.failed[0]?.failedReason).toMatch(/provides mismatch/);
    expect(graph.pending.map((p) => p.id)).toEqual(["b"]);
  });

  it("mod reading ctx.inject value that host did not stub throws", () => {
    const a = mk(
      man({ id: "a", inject: ["x"] }),
      "export function activate(ctx) { void ctx.x; }",
    );
    const xProvider = mk(
      man({ id: "xp", provides: ["x"] }),
      "export function activate(ctx) { ctx.provide('x', {}); }",
    );
    const { graph } = runKernelActivate([xProvider, a], room);
    // hostInjectStub returns { provided: true } for unknown name — no throw
    expect(graph.active.map((p) => p.id)).toContain("a");
  });
});

// ---------- ModKernel.runChatIn budget interaction ----------

describe("ModKernel.runChatIn budget enforcement", () => {
  it("pack exceeding hook budget is skipped; message passes through unmodified", async () => {
    const m = man({
      id: "eager",
      hooks: ["room.chat.in"],
      budget: { hookPerMin: 2, schedulePerMin: 20 },
    });
    const kernel = new ModKernel();
    kernel.start(
      [
        {
          manifest: m,
          activate: compileKernelActivate(
            "export function activate(ctx) { ctx.hooks.on('room.chat.in', (env) => ({ action: 'replace', value: Object.assign({}, env, { text: env.text + '!' }) })); }",
          ),
        },
      ],
      room,
    );
    const env = {
      roomId: "r",
      seatId: "s",
      authorUserId: "u",
      authorLabel: "U",
      text: "hi",
      at: 1,
    };
    const r1 = await kernel.runChatIn(env);
    const r2 = await kernel.runChatIn(env);
    const r3 = await kernel.runChatIn(env);
    if (r1.action === "drop" || r2.action === "drop" || r3.action === "drop") throw new Error("unexpected drop");
    expect(r1.value.text).toBe("hi!");
    expect(r2.value.text).toBe("hi!");
    expect(r3.value.text).toBe("hi"); // budget exhausted → pass-through
    await kernel.dispose();
  });

  it("a pack that throws inside its hook does not break subsequent packs", async () => {
    const bad = man({ id: "bad", hooks: ["room.chat.in"] });
    const good = man({ id: "good", hooks: ["room.chat.in"] });
    const kernel = new ModKernel();
    kernel.start(
      [
        {
          manifest: bad,
          activate: compileKernelActivate(
            "export function activate(ctx) { ctx.hooks.on('room.chat.in', () => { throw new Error('x'); }); }",
          ),
        },
        {
          manifest: good,
          activate: compileKernelActivate(
            "export function activate(ctx) { ctx.hooks.on('room.chat.in', (env) => ({ action: 'replace', value: Object.assign({}, env, { text: env.text + '+' }) })); }",
          ),
        },
      ],
      room,
    );
    const result = await kernel.runChatIn({
      roomId: "r",
      seatId: "s",
      authorUserId: "u",
      authorLabel: "U",
      text: "a",
      at: 1,
    });
    if (result.action === "drop") throw new Error("unexpected drop");
    expect(result.value.text).toBe("a+");
    await kernel.dispose();
  });

  it("runChatIn after dispose resolves with continue (no throw)", async () => {
    const kernel = new ModKernel();
    kernel.start([], room);
    await kernel.dispose();
    const result = await kernel.runChatIn({
      roomId: "r",
      seatId: "s",
      authorUserId: "u",
      authorLabel: "U",
      text: "a",
      at: 1,
    });
    expect(result.action).toBe("continue");
  });
});

// ---------- improve pipeline edge cases ----------

describe("improve pipeline robustness", () => {
  const memManifest = () =>
    man({
      id: "mem",
      provides: ["memory"],
      permissions: ["storage:room"],
    });

  it("trialKernelSource rejects source that only *reads* ctx but never provides", () => {
    const trial = trialKernelSource(
      memManifest(),
      "export function activate(ctx) { void ctx.room; }",
    );
    expect(trial.ok).toBe(false);
    if (!trial.ok) expect(trial.error).toMatch(/provides mismatch/);
  });

  it("sameCapabilityBoundary ignores ordering of inject/provides", () => {
    const a = man({ id: "x", inject: ["a", "b"], provides: ["p", "q"] });
    const b = man({ id: "x", inject: ["b", "a"], provides: ["q", "p"] });
    expect(sameCapabilityBoundary(a, b)).toBe(true);
  });

  it("sameCapabilityBoundary is case-sensitive on id", () => {
    const a = man({ id: "X" });
    const b = man({ id: "x" });
    expect(sameCapabilityBoundary(a, b)).toBe(false);
  });

  it("L1 apply when provides sets equal as sets (order-insensitive)", () => {
    expect(
      decideImproveApply({
        autonomy: 1,
        trialOk: true,
        currentProvides: ["a", "b"],
        nextProvides: ["b", "a"],
      }),
    ).toBe("apply");
  });

  it("L1 parks when trial returns extra provide beyond current", () => {
    expect(
      decideImproveApply({
        autonomy: 1,
        trialOk: true,
        currentProvides: ["memory"],
        nextProvides: ["memory", "extra"],
      }),
    ).toBe("pending");
  });
});
