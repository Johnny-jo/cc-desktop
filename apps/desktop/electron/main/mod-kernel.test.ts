import { describe, expect, it } from "vitest";
import { MOD_HOST_API, MOD_KERNEL_API } from "@claude-desktop/shared";
import { parseManifest } from "./mod-package";
import {
  createModCtx,
  KernelBudgetGate,
  KERNEL_BUDGET_DEFAULT,
  ModKernel,
  parseKernelManifest,
  planKernelGraph,
  runChatInRailway,
  runKernelActivate,
  scanKernelForbiddenApis,
  type ChatInEnvelope,
  type KernelManifest,
} from "./mod-kernel";

const room = {
  id: "r1",
  seats: [{ id: "s1", kind: "human" as const, name: "A" }],
};

function man(
  partial: Partial<KernelManifest> & Pick<KernelManifest, "id">,
): KernelManifest {
  return parseKernelManifest({
    hostApi: MOD_KERNEL_API,
    version: "1.0.0",
    inject: [],
    provides: [],
    permissions: [],
    hooks: [],
    ...partial,
  });
}

describe("parseKernelManifest", () => {
  it("parses optional budget and rejects invalid values", () => {
    const def = parseKernelManifest({
      id: "x",
      version: "1",
      hostApi: 2,
    });
    expect(def.budget).toEqual(KERNEL_BUDGET_DEFAULT);
    const custom = parseKernelManifest({
      id: "x",
      version: "1",
      hostApi: 2,
      budget: { hookPerMin: 3, schedulePerMin: 2 },
    });
    expect(custom.budget).toEqual({ hookPerMin: 3, schedulePerMin: 2 });
    expect(() =>
      parseKernelManifest({
        id: "x",
        version: "1",
        hostApi: 2,
        budget: { hookPerMin: 0 },
      }),
    ).toThrow(/budget.hookPerMin/);
  });

  it("parses hostApi 2 and defaults name to id", () => {
    const m = parseKernelManifest({
      id: "shared-memory",
      version: "1.0.0",
      hostApi: 2,
      provides: ["memory"],
      permissions: ["storage:room"],
    });
    expect(m.hostApi).toBe(MOD_KERNEL_API);
    expect(m.name).toBe("shared-memory");
    expect(m.provides).toEqual(["memory"]);
    expect(m.inject).toEqual([]);
    expect(m.hooks).toEqual([]);
  });

  it("rejects hostApi 1 and unknown permissions/hooks", () => {
    expect(() =>
      parseKernelManifest({ id: "x", version: "1", hostApi: 1 }),
    ).toThrow(/hostApi must be 2/);
    expect(
      parseKernelManifest({
        id: "x",
        version: "1",
        hostApi: 2,
        permissions: ["schedule:room"],
      }).permissions,
    ).toEqual(["schedule:room"]);
    expect(() =>
      parseKernelManifest({
        id: "x",
        version: "1",
        hostApi: 2,
        permissions: ["net"],
      }),
    ).toThrow(/unknown permission: net/);
    expect(() =>
      parseKernelManifest({
        id: "x",
        version: "1",
        hostApi: 2,
        hooks: ["sdk.pre-step"],
      }),
    ).toThrow(/unknown hook/);
  });

  it("does not change play parseManifest rejecting hostApi 2", () => {
    expect(() =>
      parseManifest({
        id: "werewolf",
        name: "狼人杀",
        version: "1.0.0",
        hostApi: 2,
        permissions: [],
        seats: { min: 4, max: 12, roles: [] },
      }),
    ).toThrow(/hostApi must be 1/);
    expect(MOD_HOST_API).toBe(1);
  });
});

describe("KernelBudgetGate", () => {
  it("caps pack and room rates and rolls the window", () => {
    let now = 1_000;
    const gate = new KernelBudgetGate(
      100,
      { hookPerMin: 3, schedulePerMin: 2 },
      () => now,
    );
    expect(gate.allowHook("a", 2)).toBe(true);
    expect(gate.allowHook("a", 2)).toBe(true);
    expect(gate.allowHook("a", 2)).toBe(false);
    expect(gate.allowHook("b", 2)).toBe(true);
    expect(gate.allowHook("b", 2)).toBe(false);
    now = 1_200;
    expect(gate.allowHook("a", 2)).toBe(true);
    expect(gate.allowSchedule("a", 1)).toBe(true);
    expect(gate.allowSchedule("a", 1)).toBe(false);
  });
});

describe("scanKernelForbiddenApis", () => {
  it("allows Date and Math.random, rejects require and any import", () => {
    expect(() =>
      scanKernelForbiddenApis("export function activate() { Date.now(); Math.random(); }"),
    ).not.toThrow();
    expect(() => scanKernelForbiddenApis("require('fs')")).toThrow(/require/);
    expect(() => scanKernelForbiddenApis("import { x } from './room-service'")).toThrow(
      /import/,
    );
    expect(() => scanKernelForbiddenApis("const x = import('node:fs')")).toThrow(
      /dynamic import/,
    );
    expect(() => scanKernelForbiddenApis("setInterval(() => {}, 10)")).toThrow(
      /ctx.schedule/,
    );
    expect(() => scanKernelForbiddenApis("new Function('return 1')")).toThrow(
      /Function constructor/,
    );
    expect(() =>
      scanKernelForbiddenApis('export function activate() { return "setTimeout("; }'),
    ).not.toThrow();
  });
});

describe("planKernelGraph", () => {
  it("toposorts inject after provide", () => {
    const memory = man({ id: "mem", provides: ["memory"] });
    const user = man({ id: "user", inject: ["memory"] });
    const { order, graph } = planKernelGraph([user, memory]);
    expect(order).toEqual(["mem", "user"]);
    expect(graph.active.map((x) => x.id)).toEqual(["mem", "user"]);
    expect(graph.pending).toEqual([]);
    expect(graph.failed).toEqual([]);
  });

  it("marks missing inject as pending without failing the room", () => {
    const user = man({ id: "user", inject: ["memory"] });
    const { graph } = planKernelGraph([user]);
    expect(graph.active).toEqual([]);
    expect(graph.pending).toHaveLength(1);
    expect(graph.pending[0]?.pendingReason).toMatch(/missing inject: memory/);
    expect(graph.failed).toEqual([]);
  });

  it("fails duplicate provides and cycles; keeps independent packs", () => {
    const a = man({ id: "a", provides: ["memory"] });
    const b = man({ id: "b", provides: ["memory"] });
    const lone = man({ id: "lone", provides: ["log"] });
    const dup = planKernelGraph([a, b, lone]);
    expect(dup.graph.failed.map((x) => x.id).sort()).toEqual(["a", "b"]);
    expect(dup.graph.failed[0]?.failedReason).toMatch(/duplicate provide: memory/);
    expect(dup.graph.active.map((x) => x.id)).toEqual(["lone"]);

    const c = man({ id: "c", provides: ["x"], inject: ["y"] });
    const d = man({ id: "d", provides: ["y"], inject: ["x"] });
    const e = man({ id: "e", provides: ["z"] });
    const cyc = planKernelGraph([c, d, e]);
    expect(cyc.graph.failed.map((x) => x.id).sort()).toEqual(["c", "d"]);
    expect(cyc.graph.failed.every((x) => x.failedReason === "dependency cycle")).toBe(
      true,
    );
    expect(cyc.graph.active.map((x) => x.id)).toEqual(["e"]);
  });
});

describe("createModCtx", () => {
  it("throws on undeclared get, missing inject, and writes", () => {
    const manifest = man({ id: "hook", hooks: ["room.chat.in"] });
    const { ctx } = createModCtx({ manifest, room });
    expect(ctx.room.id).toBe("r1");
    expect(() => (ctx as unknown as { foo: unknown }).foo).toThrow(
      /undeclared ctx.foo/,
    );
    expect(() => {
      (ctx as unknown as { log: unknown }).log = () => undefined;
    }).toThrow(/read-only/);
    expect(Object.keys(ctx).sort()).toEqual(
      ["hooks", "log", "onDispose", "provide", "room"].sort(),
    );

    const needy = man({ id: "need", inject: ["memory"] });
    const { ctx: ctx2 } = createModCtx({ manifest: needy, room });
    expect(() => (ctx2 as unknown as { memory: unknown }).memory).toThrow(
      /ctx.memory is not provided/,
    );
  });

  it("rejects undeclared provide/hook and provide after seal", () => {
    const manifest = man({
      id: "mem",
      provides: ["memory"],
      hooks: ["room.chat.in"],
      permissions: ["storage:room"],
    });
    const { ctx, seal, provides } = createModCtx({
      manifest,
      room,
      storage: {
        namespace: () => ({
          get: () => undefined,
          set: () => ({ ok: true as const }),
          list: () => [],
          search: () => [],
        }),
      },
    });
    expect(() => ctx.provide("other", { get: () => 1 })).toThrow(/undeclared provide/);
    ctx.provide("memory", { get: () => "x", set: () => undefined });
    expect(provides[0]?.methods.sort()).toEqual(["get", "set"]);
    ctx.hooks.on("room.chat.in", (env) => ({ action: "continue", value: env }));
    seal();
    expect(() => ctx.provide("memory", { get: () => 1 })).toThrow(/after activate/);
  });

  it("exposes schedule.every only with schedule:room and clamps interval", () => {
    const bare = man({ id: "bare" });
    const { ctx } = createModCtx({ manifest: bare, room });
    expect(() => (ctx as { schedule?: { every: () => void } }).schedule?.every()).toThrow(
      /undeclared ctx.schedule/,
    );
    const scheduled = man({
      id: "tick",
      permissions: ["schedule:room"],
    });
    const session = createModCtx({ manifest: scheduled, room });
    session.ctx.schedule!.every(50, () => ({ text: "n" }));
    expect(session.schedules).toHaveLength(1);
    expect(session.schedules[0]?.ms).toBe(1000);
    session.seal();
    expect(() => session.ctx.schedule!.every(1000, () => undefined)).toThrow(
      /after activate/,
    );
  });
});

describe("runKernelActivate", () => {
  it("activates fixtures in order and records provide methods", () => {
    const seen: string[] = [];
    const { graph, provides } = runKernelActivate(
      [
        {
          manifest: man({ id: "user", inject: ["memory"] }),
          activate: () => {
            seen.push("user");
          },
        },
        {
          manifest: man({ id: "mem", provides: ["memory"] }),
          activate: (ctx) => {
            seen.push("mem");
            ctx.provide("memory", { get: () => "v" });
          },
        },
      ],
      room,
    );
    expect(seen).toEqual(["mem", "user"]);
    expect(graph.active.map((x) => x.id)).toEqual(["mem", "user"]);
    expect(provides).toEqual([{ name: "memory", methods: ["get"] }]);
  });

  it("moves activate throw to failed and dependents to pending", () => {
    const { graph } = runKernelActivate(
      [
        {
          manifest: man({ id: "mem", provides: ["memory"] }),
          activate: () => {
            throw new Error("boom");
          },
        },
        {
          manifest: man({ id: "user", inject: ["memory"] }),
          activate: () => {
            throw new Error("should not run");
          },
        },
      ],
      room,
    );
    expect(graph.failed.map((x) => x.id)).toEqual(["mem"]);
    expect(graph.failed[0]?.failedReason).toBe("boom");
    expect(graph.pending.map((x) => x.id)).toEqual(["user"]);
    expect(graph.active).toEqual([]);
  });
});

describe("ModKernel", () => {
  it("runs disposers in reverse and is idempotent", async () => {
    const order: string[] = [];
    const kernel = new ModKernel();
    kernel.start(
      [
        {
          manifest: man({ id: "a", provides: ["x"] }),
          activate: (ctx) => {
            ctx.onDispose(() => {
              order.push("a");
            });
            ctx.provide("x", { ping: () => 1 });
          },
        },
        {
          manifest: man({ id: "b", inject: ["x"] }),
          activate: (ctx) => {
            ctx.onDispose(() => {
              order.push("b");
            });
          },
        },
      ],
      room,
    );
    expect(kernel.snapshot().active.map((x) => x.id)).toEqual(["a", "b"]);
    await kernel.dispose();
    expect(order).toEqual(["b", "a"]);
    await kernel.dispose();
    expect(order).toEqual(["b", "a"]);
    expect(kernel.snapshot().active.every((x) => x.state === "disposed")).toBe(true);
  });

  it("injects a host memory stub, not a dummy provided flag", async () => {
    const { HostRoomKv } = await import("./mod-kernel-store");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kinj-"));
    const kv = new HostRoomKv(path.join(dir, "s.json"));
    kv.namespace("memory").set("hi", "你好");
    let seen = "";
    const kernel = new ModKernel(kv);
    kernel.start(
      [
        {
          manifest: man({ id: "mem", provides: ["memory"], permissions: ["storage:room"] }),
          activate: (ctx) => {
            ctx.provide("memory", {
              get: () => {
                throw new Error("author closure must not run");
              },
            });
          },
        },
        {
          manifest: man({
            id: "user",
            inject: ["memory"],
            hooks: ["room.chat.in"],
          }),
          activate: (ctx) => {
            const mem = (ctx as unknown as { memory: { get: (k: string) => string } })
              .memory;
            seen = mem.get("hi");
          },
        },
      ],
      room,
    );
    expect(seen).toBe("你好");
    await kernel.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("only publishes provides that activate actually registered", () => {
    const kernel = new ModKernel();
    kernel.start(
      [
        {
          manifest: man({ id: "mem", provides: ["memory"] }),
          activate: () => {
            // declared memory but never provide()
          },
        },
        {
          manifest: man({ id: "user", inject: ["memory"] }),
          activate: () => {
            throw new Error("should stay pending");
          },
        },
      ],
      room,
    );
    const snap = kernel.snapshot();
    expect(snap.failed.map((x) => x.id)).toEqual(["mem"]);
    expect(snap.failed[0]?.failedReason).toMatch(/provides mismatch/);
    expect(snap.pending.map((x) => x.id)).toEqual(["user"]);
    expect(snap.active).toEqual([]);
  });
});

const envOf = (text: string): ChatInEnvelope => ({
  roomId: "r1",
  seatId: "s1",
  authorUserId: "u1",
  authorLabel: "A",
  text,
  at: 1,
});

describe("runChatInRailway", () => {
  it("replaces then drops; thrown handler is skipped", async () => {
    const seen: string[] = [];
    const out = await runChatInRailway(
      [
        (e) => {
          seen.push(`a:${e.text}`);
          return { action: "replace", value: { ...e, text: "rewritten" } };
        },
        () => {
          throw new Error("boom");
        },
        (e) => {
          seen.push(`c:${e.text}`);
          return { action: "drop", reason: "blocked" };
        },
        () => {
          seen.push("d");
          return { action: "continue", value: envOf("nope") };
        },
      ],
      envOf("hello"),
    );
    expect(out).toEqual({ action: "drop", reason: "blocked" });
    expect(seen).toEqual(["a:hello", "c:rewritten"]);
  });

  it("empty chain is identity continue", async () => {
    const e = envOf("plain");
    await expect(runChatInRailway([], e)).resolves.toEqual({
      action: "continue",
      value: e,
    });
  });
});
