import { describe, expect, it } from "vitest";
import {
  compileKernelActivate,
  KernelBudgetGate,
  runChatInRailway,
  scanKernelForbiddenApis,
  type ChatInEnvelope,
  type ChatInHandler,
  type KernelBudget,
} from "./mod-kernel";

const env = (text: string): ChatInEnvelope => ({
  roomId: "r",
  seatId: "s",
  authorUserId: "u",
  authorLabel: "U",
  text,
  at: 1,
});

describe("scanKernelForbiddenApis robustness", () => {
  it("flags evasion: whitespace inside require(", () => {
    expect(() => scanKernelForbiddenApis("const x = require\n('fs')")).toThrow();
  });
  it("flags evasion: setTimeout with newline before (", () => {
    expect(() => scanKernelForbiddenApis("setTimeout\n(() => {}, 1)")).toThrow();
  });
  it("flags indirect reference `const f = setTimeout`", () => {
    expect(() =>
      scanKernelForbiddenApis("const f = setTimeout; f(() => {}, 1)"),
    ).toThrow(/setTimeout is forbidden/);
  });
  it("flags globalThis['setTimeout'] computed access", () => {
    expect(() =>
      scanKernelForbiddenApis("globalThis['setTimeout'](() => {}, 1)"),
    ).toThrow(/setTimeout is forbidden/);
  });
  it("flags string-constructed dynamic import", () => {
    expect(() => scanKernelForbiddenApis("const f = import;")).toThrow();
    expect(() => scanKernelForbiddenApis("import ('x')")).toThrow(/dynamic import/);
  });
  it("flags Function constructor escape hatch", () => {
    expect(() =>
      scanKernelForbiddenApis("new Function('return process')()"),
    ).toThrow(/Function constructor is forbidden/);
  });
});

describe("compileKernelActivate sandbox robustness", () => {
  it("rejects Function constructor at compile time", () => {
    expect(() =>
      compileKernelActivate(
        "export function activate(ctx) { ctx.log('info', String(typeof new Function('return typeof process')())); }",
      ),
    ).toThrow(/Function constructor is forbidden/);
  });
  it("allows setTimeout mentioned only in a string or comment", () => {
    expect(() =>
      compileKernelActivate(
        'export function activate(ctx) { ctx.log("info", "mentions setTimeout( in docs"); }',
      ),
    ).not.toThrow();
    expect(() =>
      compileKernelActivate(
        "export function activate(ctx) { /* setTimeout(() => {}, 1) */ }",
      ),
    ).not.toThrow();
  });
  it("rejects infinite loop at module top-level via vm timeout", () => {
    expect(() =>
      compileKernelActivate("while (true) {} export function activate() {}"),
    ).toThrow();
  });
  it("mod cannot name process/require — scanner rejects the identifiers", () => {
    expect(() =>
      compileKernelActivate(
        "export function activate(ctx) { ctx.log('info', String(typeof process), String(typeof require)); }",
      ),
    ).toThrow(/process is forbidden/);
  });
  it("async activate that never resolves does not hang compile", () => {
    const activate = compileKernelActivate(
      "async function activate(ctx) { await new Promise(() => {}); } exports.activate = activate;",
    );
    expect(typeof activate).toBe("function");
  });
  it("globalThis leak: mod can mutate shared intrinsics (pollution check)", () => {
    const activate = compileKernelActivate(
      "export function activate(ctx) { Array.prototype.__pwned = 1; }",
    );
    activate({
      room: { id: "r", seats: [] },
      log: () => undefined,
      onDispose: () => undefined,
      provide: () => undefined,
      hooks: { on: () => undefined },
    } as never);
    expect((Array.prototype as unknown as Record<string, unknown>).__pwned).toBe(1);
    delete (Array.prototype as unknown as Record<string, unknown>).__pwned;
  });
});

describe("runChatInRailway robustness", () => {
  it("a slow handler is timed out and the chain continues with current value", async () => {
    const slow: ChatInHandler = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ action: "replace", value: env("late") }), 500),
      );
    const fast: ChatInHandler = (e) => ({ action: "replace", value: { ...e, text: e.text + "!" } });
    const result = await runChatInRailway([slow, fast], env("hi"));
    if (result.action === "drop") throw new Error("unexpected drop");
    expect(result.value.text).toBe("hi!");
  });

  it("handler returning malformed result shape is skipped", async () => {
    const bad: ChatInHandler = () => ({ action: "explode", value: env("x") }) as never;
    const good: ChatInHandler = (e) => ({ action: "replace", value: { ...e, text: e.text + "+" } });
    const result = await runChatInRailway([bad, good], env("a"));
    if (result.action === "drop") throw new Error("unexpected drop");
    expect(result.value.text).toBe("a+");
  });

  it("handler returning null is skipped, chain continues", async () => {
    const bad: ChatInHandler = () => null as never;
    const good: ChatInHandler = (e) => ({ action: "replace", value: { ...e, text: e.text + "+" } });
    const result = await runChatInRailway([bad, good], env("a"));
    if (result.action === "drop") throw new Error("unexpected drop");
    expect(result.value.text).toBe("a+");
  });

  it("replace with undefined value keeps previous envelope", async () => {
    const bad: ChatInHandler = () => ({ action: "replace", value: undefined as never });
    const result = await runChatInRailway([bad], env("keep"));
    if (result.action === "drop") throw new Error("unexpected drop");
    expect(result.value.text).toBe("keep");
  });

  it("synchronously throwing handler is skipped", async () => {
    const boom: ChatInHandler = () => {
      throw new Error("boom");
    };
    const good: ChatInHandler = (e) => ({ action: "replace", value: { ...e, text: "ok" } });
    const result = await runChatInRailway([boom, good], env("a"));
    if (result.action === "drop") throw new Error("unexpected drop");
    expect(result.value.text).toBe("ok");
  });

  it("drop short-circuits later handlers", async () => {
    const order: string[] = [];
    const a: ChatInHandler = () => {
      order.push("a");
      return { action: "drop", reason: "x" };
    };
    const b: ChatInHandler = (e) => {
      order.push("b");
      return { action: "continue", value: e };
    };
    const result = await runChatInRailway([a, b], env("a"));
    expect(result.action).toBe("drop");
    expect(order).toEqual(["a"]);
  });
});

describe("KernelBudgetGate robustness", () => {
  it("pack limit caps repeated allows inside one window", () => {
    let t = 1; // avoid t=0 sentinel bug
    const gate = new KernelBudgetGate(
      1000,
      { hookPerMin: 100, schedulePerMin: 100 },
      () => t,
    );
    for (let i = 0; i < 5; i++) expect(gate.allowHook("p", 5)).toBe(true);
    expect(gate.allowHook("p", 5)).toBe(false); // pack limit reached
    t = 999;
    expect(gate.allowHook("p", 5)).toBe(false); // still same window
    t = 1001;
    expect(gate.allowHook("p", 5)).toBe(true); // window rolled
  });

  it("room limit shared across packs", () => {
    const gate = new KernelBudgetGate(
      60_000,
      { hookPerMin: 3, schedulePerMin: 100 },
      () => 1,
    );
    expect(gate.allowHook("a", 10)).toBe(true);
    expect(gate.allowHook("b", 10)).toBe(true);
    expect(gate.allowHook("c", 10)).toBe(true);
    expect(gate.allowHook("d", 10)).toBe(false); // room cap hit
  });

  it("schedule budget is tracked independently of hook budget", () => {
    const gate = new KernelBudgetGate(
      60_000,
      { hookPerMin: 100, schedulePerMin: 100 },
      () => 1,
    );
    expect(gate.allowHook("p", 2)).toBe(true);
    expect(gate.allowHook("p", 2)).toBe(true);
    expect(gate.allowHook("p", 2)).toBe(false);
    expect(gate.allowSchedule("p", 2)).toBe(true); // schedule lane unaffected
    expect(gate.allowSchedule("p", 2)).toBe(true);
    expect(gate.allowSchedule("p", 2)).toBe(false);
  });

  it("clock moving backwards does not reset the window", () => {
    let t = 5000;
    const gate = new KernelBudgetGate(
      1000,
      { hookPerMin: 100, schedulePerMin: 100 },
      () => t,
    );
    expect(gate.allowHook("p", 1)).toBe(true);
    expect(gate.allowHook("p", 1)).toBe(false);
    t = 0; // clock jump backwards
    expect(gate.allowHook("p", 1)).toBe(false); // window must NOT have rolled
  });

  it("first call at t=0 still enforces the pack limit", () => {
    let t = 0;
    const gate = new KernelBudgetGate(
      60_000,
      { hookPerMin: 100, schedulePerMin: 100 },
      () => t,
    );
    expect(gate.allowHook("p", 1)).toBe(true);
    expect(gate.allowHook("p", 1)).toBe(false);
  });
});

describe("budget parsing edge cases", () => {
  it("rejects zero, negative, fractional, and non-integer budget", async () => {
    const { parseKernelManifest } = await import("./mod-kernel");
    const base = { id: "x", version: "1", hostApi: 2 };
    for (const bad of [0, -1, 1.5, NaN, Infinity, "5", null]) {
      expect(() =>
        parseKernelManifest({ ...base, budget: { hookPerMin: bad } }),
      ).toThrow();
    }
    expect(() =>
      parseKernelManifest({ ...base, budget: { hookPerMin: 10001 } }),
    ).toThrow();
    expect(
      parseKernelManifest({ ...base, budget: { hookPerMin: 10000 } }).budget.hookPerMin,
    ).toBe(10000);
  });
});
