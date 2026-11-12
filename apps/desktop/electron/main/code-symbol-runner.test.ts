import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => [] as EventEmitter[]);
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    constructor() { super(); workers.push(this); }
    terminate() { this.emit("exit", 1); return Promise.resolve(1); }
  },
}));
import { runCodeSymbolLookup } from "./code-symbol-runner";

afterEach(() => { workers.length = 0; vi.useRealTimers(); });

it("cancels queued and active lookups and releases capacity for another workspace", async () => {
  const active = new AbortController();
  const queued = new AbortController();
  const query = { name: "work" };
  const first = runCodeSymbolLookup("one", query, active.signal);
  const second = runCodeSymbolLookup("two", query);
  const third = runCodeSymbolLookup("three", query, queued.signal);
  const fourth = runCodeSymbolLookup("four", query);
  expect(workers).toHaveLength(2);
  queued.abort();
  await expect(third).rejects.toMatchObject({ name: "AbortError" });
  active.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(workers).toHaveLength(3);
  for (const worker of workers.slice(1)) {
    worker.emit("message", { result: { status: "found" } });
    worker.emit("exit", 0);
  }
  expect(await Promise.all([second, fourth])).toEqual([{ status: "found" }, { status: "found" }]);
});

it("reports worker failures even when it exits without sending a reply", async () => {
  const result = runCodeSymbolLookup("one", { name: "work" });
  workers[0].emit("exit", 1);
  await expect(result).rejects.toThrow();
});
