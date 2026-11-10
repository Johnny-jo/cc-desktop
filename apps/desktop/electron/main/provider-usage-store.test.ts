import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderUsageStore } from "./provider-usage-store";

let dir: string;
let store: ProviderUsageStore;
let now: number;
const hour = 60 * 60 * 1000;
function add(patch: Partial<Parameters<ProviderUsageStore["record"]>[0]> = {}) {
  store.record({ at: now - 1, providerId: "one", providerName: "OpenAI", providerType: "openai", outcome: "success", inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 0, usageReported: true, ...patch });
}
beforeEach(() => {
  now = Date.UTC(2026, 10, 9, 15, 50);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-usage-"));
  store = ProviderUsageStore.open(dir, () => now)!;
  if (!store) throw new Error("SQLite required for usage tests");
});
afterEach(() => { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
describe("Provider usage persistence", () => {
  it("starts with explicit empty buckets, not fabricated success or historical usage", () => {
    const snapshot = store.dashboard("24h");
    expect(snapshot.buckets).toHaveLength(24);
    expect(snapshot.metrics).toMatchObject({ requests: 0, totalTokens: 0, successRate: null });
    expect(snapshot.buckets.every(bucket => bucket.successRate === null)).toBe(true);
    expect(snapshot.recordingSince).toBe(now);
  });
  it("uses real totals and excludes cancellation from the success-rate denominator", () => {
    add(); add({ outcome: "failure", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, usageReported: false });
    add({ outcome: "cancelled", inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 });
    const { metrics } = store.dashboard("24h");
    expect(metrics).toMatchObject({ requests: 3, successes: 1, failures: 1, cancellations: 1, successRate: 0.5, totalTokens: 160, unreportedUsageRequests: 1 });
  });
  it("filters metrics and curves while retaining the account selector's complete provider list", () => {
    add(); add({ providerId: "two", providerName: "DeepSeek", providerType: "deepseek", outcome: "failure" });
    const snapshot = store.dashboard("7d", "two");
    expect(snapshot.providers).toHaveLength(2);
    expect(snapshot.buckets).toHaveLength(7);
    expect(snapshot.metrics).toMatchObject({ requests: 1, failures: 1, successRate: 0 });
    expect(snapshot.buckets.reduce((total, bucket) => total + bucket.requests, 0)).toBe(1);
  });
  it("persists through restart without retaining prompts, response bodies or credentials", () => {
    add(); store.close(); now += hour;
    store = ProviderUsageStore.open(dir, () => now)!;
    expect(store.dashboard("30d").metrics.totalTokens).toBe(150);
    expect(store.dashboard("30d").recordingSince).toBe(now - hour);
    expect(fs.readdirSync(dir).some(name => name.endsWith(".sqlite3"))).toBe(true);
  });
  it("uses exact sliding windows with hour/day buckets and does not count older data", () => {
    add({ at: now - 2 * hour }); add({ at: now - 2 * 24 * hour }); add({ at: now - 8 * 24 * hour }); add({ at: now - 31 * 24 * hour });
    expect(store.dashboard("24h").metrics.requests).toBe(1);
    expect(store.dashboard("7d").metrics.requests).toBe(2);
    expect(store.dashboard("30d").metrics.requests).toBe(3);
    expect(store.dashboard("30d").buckets).toHaveLength(30);
  });
  it("rejects invalid range/usage values before database writes", () => {
    expect(() => store.dashboard("forever" as never)).toThrow();
    expect(() => add({ inputTokens: -5 })).toThrow();
    expect(store.dashboard("24h").metrics.requests).toBe(0);
  });
});
