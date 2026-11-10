import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC } from "@claude-desktop/shared";
import type { ProviderConfig } from "@claude-desktop/shared";
import { ProviderManager } from "./provider-manager";
import { CredentialManager } from "./credential-manager";
import { QuotaManager } from "./provider-quota-manager";
import type { OAuthHandler, StartOAuthResult } from "./oauth-handler";
import type { ProviderRuntime } from "./provider-runtime";
import { registerProviderHandlers, validateProviderConfig } from "./provider-ipc-handlers";

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: any) => Promise<any>>(), openExternal: vi.fn(async () => {}) }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: any) => electron.handlers.set(name, handler) }, shell: { openExternal: electron.openExternal } }));
let dir: string;
let manager: ProviderManager;
const config: ProviderConfig = { id: "openai-1", type: "openai", name: "account", enabled: true, auth: { type: "openai", authMethod: "oauth2" } };
const call = (name: string, payload: unknown) => electron.handlers.get(name)!({}, payload);
beforeEach(() => { vi.clearAllMocks(); electron.handlers.clear(); dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-ipc-")); manager = new ProviderManager({ userDataDir: dir }); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  let complete!: (token: { access_token: string }) => void;
  const completion = new Promise<{ access_token: string }>(resolve => { complete = resolve; });
  const oauth = { start: vi.fn(async () => ({ state: "s", authorizationUrl: "https://auth.example/authorize", completion })), cancel: vi.fn(), saveOAuthToken: vi.fn(), deleteOAuthToken: vi.fn(), submitCallback: vi.fn() };
  const runtime = { providerStatus: vi.fn(async (id: string) => manager.getStatus(id)), syncProvider: vi.fn(async () => ({ models: [{ id: "gpt" }] })), setError: vi.fn(), invalidate: vi.fn() };
  registerProviderHandlers({ providerManager: manager, credentials: new CredentialManager(null), quotaManager: new QuotaManager(), oauthHandler: oauth as unknown as OAuthHandler, runtime: runtime as unknown as ProviderRuntime, sendToRenderer: vi.fn() });
  return { oauth, runtime, complete };
}
describe("Provider IPC", () => {
  it.each(["auto", "x-api-key", "bearer"])("accepts and persists Claude API-key auth mode %s", async apiKeyAuth => {
    setup();
    const next = { ...config, id: "claude-gateway", type: "claude", auth: { type: "claude", authMethod: "api-key", apiKey: "key", baseUrl: "https://gateway.example/v1", apiKeyAuth } } as ProviderConfig;
    expect(await call(IPC.providerAddConfig, { config: next })).toMatchObject({ ok: true });
    expect(manager.getConfig(next.id)?.auth).toMatchObject({ apiKeyAuth });
  });
  it.each(["invalid", "", null, 1])("rejects invalid Claude API-key auth mode %s", apiKeyAuth => {
    const next = { ...config, type: "claude", auth: { type: "claude", authMethod: "api-key", apiKeyAuth } } as unknown as ProviderConfig;
    expect(() => validateProviderConfig(next)).toThrow(/鉴权/);
  });
  it("rejects a Claude-specific auth mode on another provider", () => {
    expect(() => validateProviderConfig({ ...config, auth: { ...config.auth, apiKeyAuth: "bearer" } } as unknown as ProviderConfig)).toThrow(/鉴权/);
  });
  it.each(["claude", "openai", "deepseek", "kimi", "xai", "gemini"] as const)("validates optional %s API Base URLs at the main-process boundary", type => {
    const next: ProviderConfig = { ...config, type, auth: { type, authMethod: "api-key", baseUrl: "https://gateway.example/api" } };
    expect(() => validateProviderConfig(next)).not.toThrow();
    next.auth.baseUrl = "https://user:password@gateway.example/api";
    expect(() => validateProviderConfig(next)).toThrow(/Base URL/);
  });
  it("rejects an API override on OAuth configs", () => {
    expect(() => validateProviderConfig({ ...config, auth: { type: "openai", authMethod: "oauth2", baseUrl: "https://gateway.example/api" } })).toThrow(/OAuth/);
  });
  it("validates integer limits at the main-process boundary", () => {
    expect(() => validateProviderConfig({ ...config, contextLimitOverride: 200000 })).not.toThrow();
    expect(() => validateProviderConfig({ ...config, contextLimitOverride: 200000.5 })).toThrow(/整数/);
  });
  it("stores API keys separately and connects a newly added key to the runtime", async () => {
    const { runtime } = setup();
    expect(await call(IPC.providerAddConfig, { config: { ...config, auth: { type: "openai", authMethod: "api-key", apiKey: " sk-key ", baseUrl: "https://gateway.example/v1" } } })).toMatchObject({ ok: true });
    expect(manager.loadApiKey(config.id)).toBeTruthy();
    expect(manager.listConfigs()[0].auth.apiKey).toBeUndefined();
    expect(new ProviderManager({ userDataDir: dir }).getConfig(config.id)?.auth).toEqual({ type: "openai", authMethod: "api-key", baseUrl: "https://gateway.example/v1" });
    expect(runtime.syncProvider).toHaveBeenCalledWith(config.id);
  });
  it("clears the API Base URL when an API-key account switches to OAuth", async () => {
    const { complete } = setup();
    manager.addConfig({ ...config, auth: { type: "openai", authMethod: "api-key", baseUrl: "https://gateway.example/v1" } });
    expect(await call(IPC.providerStartOAuth, { id: config.id })).toMatchObject({ ok: true });
    complete({ access_token: "account-token" });
    await vi.waitFor(() => expect(manager.getConfig(config.id)?.auth.authMethod).toBe("oauth2"));
    expect(manager.getConfig(config.id)?.auth.baseUrl).toBeUndefined();
    expect(() => validateProviderConfig(manager.getConfig(config.id)!)).not.toThrow();
  });
  it("does not save tokens from a deleted authorization", async () => {
    const { oauth, complete } = setup(); manager.addConfig(config);
    await call(IPC.providerStartOAuth, { id: config.id });
    await call(IPC.providerDeleteConfig, { id: config.id });
    complete({ access_token: "late-token" }); await Promise.resolve(); await Promise.resolve();
    expect(oauth.cancel).toHaveBeenCalledWith("s");
    expect(oauth.saveOAuthToken).not.toHaveBeenCalled();
  });
  it("cancels an authorization that finishes starting after its config was deleted and re-added", async () => {
    const { oauth, complete } = setup(); manager.addConfig(config);
    let started!: (value: Partial<StartOAuthResult>) => void;
    oauth.start.mockImplementationOnce(() => new Promise<any>(resolve => { started = resolve; }));
    const login = call(IPC.providerStartOAuth, { id: config.id });
    await call(IPC.providerDeleteConfig, { id: config.id }); manager.addConfig(config);
    started({ state: "old", authorizationUrl: "https://auth.example/authorize", completion: Promise.resolve({ access_token: "late-token" }) });
    expect(await login).toMatchObject({ ok: false });
    complete({ access_token: "unused" });
    expect(electron.openExternal).not.toHaveBeenCalled(); expect(oauth.cancel).toHaveBeenCalledWith("old");
  });
  it("publishes authorization errors and does not leave a pending session when the browser fails to open", async () => {
    const { oauth } = setup(); manager.addConfig(config);
    electron.openExternal.mockRejectedValueOnce(new Error("browser unavailable"));
    expect(await call(IPC.providerStartOAuth, { id: config.id })).toMatchObject({ ok: false, error: "browser unavailable" });
    expect(oauth.cancel).toHaveBeenCalledWith("s");
    expect((await call(IPC.providerGetStatus, { id: config.id })).oauthPending).toBe(false);
  });
});
