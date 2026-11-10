import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "./provider-manager";
import { ProviderRuntime } from "./provider-runtime";
import { ProviderUsageStore } from "./provider-usage-store";
import { CredentialManager } from "./credential-manager";
import { OAuthHandler } from "./oauth-handler";
import { QuotaManager } from "./provider-quota-manager";
import type { forwardProviderMessage } from "./provider-protocol";

let dir: string;
let runtime: ProviderRuntime;
let store: ProviderUsageStore;
let manager: ProviderManager;
let forward: ReturnType<typeof vi.fn<typeof forwardProviderMessage>>;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-runtime-usage-"));
  manager = new ProviderManager({ userDataDir: dir });
  store = ProviderUsageStore.open(dir)!;
  const credentials = new CredentialManager({ encrypt: plain => plain, decrypt: value => value });
  manager.addConfig({ id: "openai-1", name: "Primary", type: "openai", enabled: true, auth: { type: "openai", authMethod: "api-key" } });
  manager.saveApiKey("openai-1", credentials.encrypt("fake-key"));
  forward = vi.fn<typeof forwardProviderMessage>();
  runtime = new ProviderRuntime({ providerManager: manager, credentials, oauthHandler: new OAuthHandler(manager, credentials), quotaManager: new QuotaManager(), getDefaultModel: () => "openai-1/model", forward, usageStore: store });
});
afterEach(() => { runtime.stopIfManaged(); store.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const body = { model: "openai-1/model", max_tokens: 100, messages: [{ role: "user", content: "hello" }] };
describe("Provider inference telemetry integration", () => {
  it("persists the actual completed JSON response and not model discovery calls", async () => {
    forward.mockResolvedValueOnce(Response.json({ type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 8 } }));
    const response = await runtime.message(body, new AbortController().signal);
    expect(runtime.getUsage("24h").metrics.requests).toBe(0);
    await response.text();
    const snapshot = runtime.getUsage("24h");
    expect(snapshot.metrics).toMatchObject({ successes: 1, failures: 0, totalTokens: 25, successRate: 1 });
    expect(snapshot.providers[0].providerName).toBe("Primary");
    await runtime.providerStatus("openai-1");
    expect(runtime.getUsage("24h").metrics.requests).toBe(1);
  });
  it("counts HTTP failure and thrown network failures once each without fictitious usage", async () => {
    forward.mockResolvedValueOnce(Response.json({ error: { message: "denied" } }, { status: 401 }));
    await (await runtime.message(body, new AbortController().signal)).text();
    forward.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(runtime.message(body, new AbortController().signal)).rejects.toThrow("network unavailable");
    expect(runtime.getUsage("24h").metrics).toMatchObject({ requests: 2, failures: 2, unreportedUsageRequests: 2, totalTokens: 0, successRate: 0 });
  });
  it("records a user-cancelled stream separately from provider failure", async () => {
    forward.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":10}}}\n\n')); } }), { headers: { "content-type": "text/event-stream" } }));
    const response = await runtime.message(body, new AbortController().signal);
    const reader = response.body!.getReader();
    await reader.read(); await reader.cancel();
    expect(runtime.getUsage("24h").metrics).toMatchObject({ requests: 1, cancellations: 1, failures: 0, inputTokens: 10, successRate: null });
  });
  it("retains usage for a deleted account and still lists configured accounts with zero requests", () => {
    store.record({ at: Date.now() - 1, providerId: "deleted", providerName: "Historical", providerType: "deepseek", outcome: "success", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, usageReported: true });
    const snapshot = runtime.getUsage("30d");
    expect(snapshot.providers.map(provider => provider.providerName).sort()).toEqual(["Historical", "Primary"]);
    expect(snapshot.metrics.totalTokens).toBe(3);
  });
  it("counts cached input exactly once through the actual Chat Completions adapter", async () => {
    runtime.stopIfManaged();
    const credentials = new CredentialManager({ encrypt: plain => plain, decrypt: value => value });
    runtime = new ProviderRuntime({ providerManager: manager, credentials, oauthHandler: new OAuthHandler(manager, credentials), quotaManager: new QuotaManager(), getDefaultModel: () => "openai-1/model", usageStore: store });
    const chunks = [
      { choices: [{ delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })));
    await (await runtime.message({ ...body, stream: true }, new AbortController().signal)).text();
    expect(runtime.getUsage("24h").metrics).toMatchObject({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, totalTokens: 150, successes: 1 });
  });
  it("keeps inference usable when recording fails and exposes a dashboard error", async () => {
    vi.spyOn(store, "record").mockImplementation(() => { throw new Error("disk full"); });
    forward.mockResolvedValueOnce(Response.json({ type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "still works" }], usage: { input_tokens: 2, output_tokens: 3 } }));
    expect(await (await runtime.message(body, new AbortController().signal)).text()).toContain("still works");
    expect(() => runtime.getUsage("24h")).toThrow(/统计写入失败/);
  });
});
