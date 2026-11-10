import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRuntime } from "./provider-runtime";
import { ProviderManager } from "./provider-manager";
import { CredentialManager } from "./credential-manager";
import { OAuthHandler } from "./oauth-handler";
import { QuotaManager } from "./provider-quota-manager";
import type { ProviderConfig } from "@claude-desktop/shared";
import type { forwardProviderMessage } from "./provider-protocol";

let dir: string;
let manager: ProviderManager;
let runtime: ProviderRuntime;
const config = (id = "openai-1"): ProviderConfig => ({ id, name: id, type: "openai", enabled: true, auth: { type: "openai", authMethod: "api-key" } });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-runtime-")); manager = new ProviderManager({ userDataDir: dir }); });
afterEach(() => { runtime?.stopIfManaged(); vi.unstubAllGlobals(); fs.rmSync(dir, { recursive: true, force: true }); });
function setup(native = false) {
  const credentials = new CredentialManager({ encrypt: p => p, decrypt: c => c });
  const oauth = new OAuthHandler(manager, credentials);
  const forward = vi.fn<typeof forwardProviderMessage>(async () => new Response('{"type":"message"}', { headers: { "content-type": "application/json" } }));
  const changed = vi.fn();
  runtime = new ProviderRuntime({ providerManager: manager, credentials, oauthHandler: oauth, quotaManager: new QuotaManager(), getDefaultModel: () => "openai-1/gpt-test", onCatalogChanged: changed, forward: native ? undefined : forward });
  return { credentials, oauth, forward, changed };
}
describe("native ProviderRuntime", () => {
  it("removes host cloud authentication modes so the SDK cannot bypass native routing", async () => {
    setup();
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) vi.stubEnv(key, "host-secret-or-flag");
    try {
      await runtime.ensureReady();
      const env = runtime.buildProcessEnv();
      expect(env.ENABLE_TOOL_SEARCH).toBe("false");
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("openai-1/gpt-test");
      expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("openai-1/gpt-test");
      for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) expect(env[key]).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
  it("syncs models directly and exposes provider-qualified IDs", async () => {
    const { credentials, changed } = setup();
    manager.addConfig(config()); manager.saveApiKey("openai-1", credentials.encrypt("sk-a"));
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "gpt-test", context_window: 200000 }] }));
    vi.stubGlobal("fetch", upstream);
    const result = await runtime.syncProvider("openai-1");
    expect(result.error).toBeUndefined();
    expect(upstream.mock.calls[0][0]).toBe("https://api.openai.com/v1/models");
    expect(runtime.getModelCatalog()).toMatchObject([{ id: "openai-1/gpt-test", contextLimit: 200000 }]);
    expect(changed).toHaveBeenCalled();
    expect((await runtime.providerStatus("openai-1"))?.authenticated).toBe(true);
  });
  it("uses only the selected provider's credential", async () => {
    const { credentials, forward } = setup();
    manager.addConfig(config()); manager.addConfig(config("openai-2"));
    manager.saveApiKey("openai-1", credentials.encrypt("key-one")); manager.saveApiKey("openai-2", credentials.encrypt("key-two"));
    await runtime.message({ model: "openai-2/gpt-test", messages: [] }, new AbortController().signal);
    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ id: "openai-2" }), "key-two", expect.objectContaining({ model: "gpt-test" }), expect.anything());
  });
  it("does not use an API key left over on an OAuth config", async () => {
    const { credentials, oauth, forward } = setup();
    manager.addConfig({ ...config(), auth: { type: "openai", authMethod: "oauth2" } });
    manager.saveApiKey("openai-1", credentials.encrypt("old-key"));
    oauth.saveOAuthToken("openai-1", { access_token: "oauth-token", account_id: "account" });
    await runtime.message({ model: "openai-1/gpt-test", messages: [] }, new AbortController().signal);
    expect(forward.mock.calls[0][1]).toBe("oauth-token");
  });
  it("rejects ambiguous models rather than routing to an arbitrary account", async () => {
    const { credentials } = setup();
    for (const id of ["openai-1", "openai-2"]) { manager.addConfig(config(id)); manager.saveApiKey(id, credentials.encrypt(id)); }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-test" }] })));
    await runtime.listModelCatalog();
    await expect(runtime.message({ model: "gpt-test", messages: [] }, new AbortController().signal)).rejects.toThrow(/多个 Provider/);
  });
  it("rejects disabled or deleted providers before making an upstream request", async () => {
    const { forward } = setup();
    manager.addConfig({ ...config(), enabled: false });
    await expect(runtime.message({ model: "openai-1/gpt-test", messages: [] }, new AbortController().signal)).rejects.toThrow(/未启用|不存在/);
    expect(forward).not.toHaveBeenCalled();
  });
  it("protects the loopback endpoint and does not send local bearer tokens upstream", async () => {
    const { credentials, forward } = setup();
    manager.addConfig(config()); manager.saveApiKey("openai-1", credentials.encrypt("upstream-key"));
    expect((await runtime.ensureReady()).state).toBe("ready");
    const env = runtime.buildProcessEnv();
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const denied = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    const ok = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}` }, body: JSON.stringify({ model: "openai-1/gpt-test", messages: [] }) });
    expect(ok.status).toBe(200);
    expect(forward.mock.calls[0][1]).toBe("upstream-key");
  });
  it("streams an SDK Messages request through the native compatible adapter to an upstream HTTP server", async () => {
    const { credentials } = setup(true);
    const observed = vi.fn();
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        observed(req.url, req.headers.authorization, JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "native answer" }, finish_reason: null }] })}\n\n`);
        res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const port = (upstream.address() as AddressInfo).port;
      manager.addConfig({ ...config("compat-1"), type: "openai-compatible", auth: { type: "openai-compatible", authMethod: "api-key", baseUrl: `http://127.0.0.1:${port}/v1` } });
      manager.saveApiKey("compat-1", credentials.encrypt("upstream-only-key"));
      await runtime.ensureReady();
      const target = runtime.getProxyTarget()!;
      const response = await fetch(`${target.origin}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${target.token}` }, body: JSON.stringify({ model: "compat-1/echo-model", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }) });
      expect(response.status).toBe(200);
      const stream = await response.text();
      expect(stream).toContain("message_start"); expect(stream).toContain("native answer"); expect(stream).toContain("message_stop");
      expect(observed).toHaveBeenCalledWith("/v1/chat/completions", "Bearer upstream-only-key", expect.objectContaining({ model: "echo-model", stream: true }));
    } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
  });
});
