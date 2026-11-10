import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSettings } from "./ProviderSettings";
import { IPC, type ProviderConfig, type ProviderStatus } from "@claude-desktop/shared";

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(), useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    const slots = hooks.slots;
    if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
    return [slots[i], (next: unknown) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
  },
}));
function elements(tree: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  return React.Children.toArray(tree).flatMap(child => React.isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as React.ReactNode)] : []);
}
function modal(onSubmit = vi.fn(async () => {})) {
  hooks.cursor = 0;
  const parent = ProviderSettings();
  const element = elements(parent).find(n => typeof n.props.onSubmit === "function")!;
  const Component = element.type as (props: Record<string, unknown>) => React.ReactNode;
  hooks.cursor = 0;
  hooks.slots = [];
  const render = () => { hooks.cursor = 0; return Component({ ...element.props, isOpen: true, onSubmit }); };
  return { render, onSubmit };
}
function field(tree: React.ReactNode, id: string) {
  const element = elements(tree).find(n => n.props.id === id);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}
function change(tree: React.ReactNode, id: string, value: string) {
  (field(tree, id).props.onChange as (e: unknown) => void)({ target: { value } });
}
async function submit(tree: React.ReactNode) {
  await (elements(tree).find(n => n.type === "form")!.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault() {} });
}
beforeEach(() => { hooks.cursor = 0; hooks.slots = []; hooks.effects = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Provider add form", () => {
  it("defaults Claude service authentication to automatic", async () => {
    const { render, onSubmit } = modal();
    expect(field(render(), "provider-key-auth").props.value).toBe("auto");
    change(render(), "provider-key", "token");
    change(render(), "provider-base-url", "https://gateway.example/v1");
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ type: "claude", auth: expect.objectContaining({ authMethod: "api-key", baseUrl: "https://gateway.example/v1" }) }));
  });
  it.each(["x-api-key", "bearer"])("saves the explicit Claude service auth mode %s", async mode => {
    const { render, onSubmit } = modal();
    change(render(), "provider-key", "token");
    change(render(), "provider-key-auth", mode);
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ auth: expect.objectContaining({ type: "claude", authMethod: "api-key", apiKeyAuth: mode }) }));
  });
  it("hides and omits Claude service auth when switching provider or signing in with OAuth", async () => {
    const { render, onSubmit } = modal();
    change(render(), "provider-key-auth", "bearer");
    change(render(), "provider-auth", "oauth2");
    expect(elements(render()).some(n => n.props.id === "provider-key-auth")).toBe(false);
    await submit(render());
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ auth: { type: "claude", authMethod: "oauth2" } }));
    change(render(), "provider-type", "deepseek");
    expect(elements(render()).some(n => n.props.id === "provider-key-auth")).toBe(false);
    change(render(), "provider-key", "key");
    await submit(render());
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ auth: { type: "deepseek", authMethod: "api-key", apiKey: "key" } }));
  });
  it.each(["claude", "openai", "deepseek", "kimi", "xai", "gemini"])("offers an optional Base URL for %s API keys", async type => {
    const { render, onSubmit } = modal();
    change(render(), "provider-type", type);
    expect(field(render(), "provider-base-url")).toBeDefined();
    change(render(), "provider-key", "sk-proxy");
    change(render(), "provider-base-url", " https://gateway.example/custom/v1/ ");
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ auth: { type, authMethod: "api-key", apiKey: "sk-proxy", baseUrl: "https://gateway.example/custom/v1/" } }));
  });
  it("omits the API Base URL when switching to OAuth", async () => {
    const { render, onSubmit } = modal();
    change(render(), "provider-base-url", "https://gateway.example/v1");
    change(render(), "provider-auth", "oauth2");
    expect(elements(render()).find(n => n.props.id === "provider-base-url")).toBeUndefined();
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ auth: { type: "claude", authMethod: "oauth2" } }));
  });
  it("accepts its default context value under the browser's number step rule", () => {
    const { render } = modal();
    const { min, step, value } = field(render(), "provider-limit").props;
    expect((Number(value) - Number(min)) % Number(step ?? 1)).toBe(0);
  });
  it("rejects fractional limits instead of silently rounding them", async () => {
    const { render, onSubmit } = modal();
    change(render(), "provider-key", "sk-direct");
    change(render(), "provider-limit", "200000.5");
    await submit(render());
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it("accepts an arbitrary integer context size without native validation popups", async () => {
    const { render, onSubmit } = modal();
    change(render(), "provider-key", "sk-direct");
    change(render(), "provider-limit", "200001");
    expect(elements(render()).find(n => n.type === "form")?.props.noValidate).toBe(true);
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ contextLimitOverride: 200001 }));
  });
  it("shows and submits a key for an OpenAI-compatible gateway", async () => {
    const { render, onSubmit } = modal();
    change(render(), "provider-type", "openai-compatible");
    change(render(), "provider-key", " sk-gateway ");
    change(render(), "provider-base-url", "http://localhost:8318/v1");
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ auth: { type: "openai-compatible", authMethod: "api-key", apiKey: "sk-gateway", baseUrl: "http://localhost:8318/v1" } }));
  });
  it("requires an API key for the configured gateway", async () => {
    const { render, onSubmit } = modal();
    change(render(), "provider-type", "openai-compatible");
    change(render(), "provider-base-url", "http://localhost:8080/v1");
    await submit(render());
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it.each(["claude", "openai"])("offers native account OAuth for %s without requiring a client ID or API key", async type => {
    const { render, onSubmit } = modal();
    change(render(), "provider-type", type);
    change(render(), "provider-auth", "oauth2");
    expect(elements(render()).find(n => n.props.id === "provider-key")).toBeUndefined();
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ type, auth: { type, authMethod: "oauth2" } }));
  });
  it("requires and stores the Google OAuth client ID", async () => {
    const { render, onSubmit } = modal();
    change(render(), "provider-type", "gemini");
    change(render(), "provider-auth", "oauth2");
    await submit(render());
    expect(onSubmit).not.toHaveBeenCalled();
    change(render(), "provider-oauth-client-id", " client.apps.googleusercontent.com ");
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      oauthClientId: "client.apps.googleusercontent.com", auth: { type: "gemini", authMethod: "oauth2" },
    }));
  });
  it("stores an optional Google Cloud project for API quota", async () => {
    const { render, onSubmit } = modal();
    change(render(), "provider-type", "gemini");
    change(render(), "provider-auth", "oauth2");
    change(render(), "provider-oauth-client-id", "client.apps.googleusercontent.com");
    change(render(), "provider-oauth-project-id", " my-cloud-project ");
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ oauthProjectId: "my-cloud-project" }));
  });
  it.each(["", "file:///tmp/gateway", "ftp://localhost", "https://user:password@example.com/v1", "https://example.com/v1?key=secret"])("rejects an invalid gateway URL %s inline", async baseUrl => {
    const { render, onSubmit } = modal();
    change(render(), "provider-type", "openai-compatible");
    change(render(), "provider-key", "sk-gateway");
    change(render(), "provider-base-url", baseUrl);
    await submit(render());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(elements(render()).some(n => n.props.role === "alert")).toBe(true);
  });
  it("trims API credentials before saving", async () => {
    const { render, onSubmit } = modal();
    change(render(), "provider-key", " sk-direct ");
    await submit(render());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ auth: { type: "claude", authMethod: "api-key", apiKey: "sk-direct" } }));
  });
  it("keeps the form and cancellation disabled until saving completes", async () => {
    let finish!: () => void;
    const { render } = modal(vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
    change(render(), "provider-key", "sk-direct");
    const saving = submit(render());
    const tree = render();
    expect(elements(tree).find(n => n.type === "fieldset")?.props.disabled).toBe(true);
    expect(elements(tree).find(n => n.type === "button" && n.props.type === "button")?.props.disabled).toBe(true);
    finish();
    await saving;
  });
  it.each(["", "1023", "10000001", "NaN", "Infinity"])("rejects the invalid context limit %s", async value => {
    const { render, onSubmit } = modal();
    change(render(), "provider-key", "sk-direct");
    change(render(), "provider-limit", value);
    await submit(render());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

function componentRenderer(component: () => React.ReactNode) {
  const slots: unknown[] = [];
  return () => {
    hooks.cursor = 0;
    hooks.slots = slots;
    return component();
  };
}
function cardElement(tree: React.ReactNode) {
  return elements(tree).find(n => typeof n.props.onOAuthLogin === "function")!;
}
const config: ProviderConfig = { id: "claude-account", name: "Personal Claude", type: "claude", enabled: true,
  auth: { type: "claude", authMethod: "oauth2" }, contextLimitOverride: 200000 };
const status: ProviderStatus = { providerId: config.id, type: config.type, name: config.name, enabled: true, authenticated: false };
function desktopHarness(initialConfigs: ProviderConfig[] = []) {
  let configs = initialConfigs;
  let currentStatus: ProviderStatus = { ...status };
  const listeners = new Map<string, () => void>();
  const desktop = {
    listProviders: vi.fn(async () => configs),
    getProviderStatus: vi.fn(async () => currentStatus),
    addProvider: vi.fn(async (next: ProviderConfig) => { configs = [...configs, next]; return { ok: true }; }),
    deleteProvider: vi.fn(async (id: string) => { configs = configs.filter(item => item.id !== id); return { ok: true }; }),
    startProviderOAuth: vi.fn(async () => {
      currentStatus = { ...status, oauthPending: true, oauthState: "state-1" };
      return { ok: true, state: "state-1", authorizationUrl: "https://claude.ai/oauth/authorize" };
    }),
    cancelProviderOAuth: vi.fn(async () => { currentStatus = { ...status }; return { ok: true }; }),
    submitProviderOAuthCallback: vi.fn(async () => { currentStatus = { ...status, authenticated: true }; return { ok: true }; }),
    on: vi.fn((channel: string, listener: () => void) => { listeners.set(channel, listener); return () => listeners.delete(channel); }),
  };
  vi.stubGlobal("window", { desktop });
  return { desktop, listeners, setStatus: (next: ProviderStatus) => { currentStatus = next; } };
}

describe("Provider account authorization", () => {
  it("confirms deletion in the card and leaves a newly opened add form editable", async () => {
    const { desktop } = desktopHarness([config]);
    const nativeConfirm = vi.fn(() => true); vi.stubGlobal("confirm", nativeConfirm);
    const render = componentRenderer(ProviderSettings);
    render(); const cleanup = hooks.effects[0]();
    try {
      await vi.waitFor(() => expect(cardElement(render())).toBeDefined());
      const card = cardElement(render());
      const renderCard = componentRenderer(() => (card.type as (props: unknown) => React.ReactNode)(card.props));
      const remove = elements(renderCard()).find(n => n.props["aria-label"] === `删除 ${config.name}`)!;
      await (remove.props.onClick as () => Promise<void>)();
      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(desktop.deleteProvider).not.toHaveBeenCalled();
      const confirmDelete = elements(renderCard()).find(n => n.props["aria-label"] === `确认删除 ${config.name}`)!;
      expect(confirmDelete).toBeDefined();
      await (confirmDelete.props.onClick as () => Promise<void>)();
      await vi.waitFor(() => expect(desktop.deleteProvider).toHaveBeenCalledWith(config.id));
      const add = elements(render()).find(n => n.type === "button" && n.props.children === "+ 添加 Provider")!;
      (add.props.onClick as () => void)();
      const modalElement = elements(render()).find(n => typeof n.props.onSubmit === "function")!;
      const renderModal = componentRenderer(() => (modalElement.type as (props: unknown) => React.ReactNode)(modalElement.props));
      expect(elements(renderModal()).find(n => n.type === "fieldset")?.props.disabled).toBe(false);
      change(renderModal(), "provider-type", "openai");
      change(renderModal(), "provider-key", "new-key");
      expect(field(renderModal(), "provider-type").props.value).toBe("openai");
      expect(field(renderModal(), "provider-key").props.value).toBe("new-key");
    } finally { if (typeof cleanup === "function") cleanup(); }
  });
  it("starts OAuth only after saving, and exposes waiting, cancellation and Claude callback controls", async () => {
    const { desktop } = desktopHarness();
    const render = componentRenderer(ProviderSettings);
    const modalElement = elements(render()).find(n => typeof n.props.onSubmit === "function")!;
    await (modalElement.props.onSubmit as (value: ProviderConfig) => Promise<void>)(config);
    expect(desktop.addProvider).toHaveBeenCalledWith(config);
    expect(desktop.addProvider.mock.invocationCallOrder[0]).toBeLessThan(desktop.startProviderOAuth.mock.invocationCallOrder[0]);
    const card = cardElement(render());
    expect(card.props.status).toMatchObject({ oauthPending: true, oauthState: "state-1" });
    const renderCard = componentRenderer(() => (card.type as (props: unknown) => React.ReactNode)(card.props));
    expect(field(renderCard(), `oauth-callback-${config.id}`)).toBeDefined();
    const cancel = elements(renderCard()).find(n => n.type === "button" && n.props.children === "取消授权")!;
    await (cancel.props.onClick as () => Promise<void>)();
    // UI handlers return void while their async work runs; wait for the provider action to finish.
    await vi.waitFor(() => expect(desktop.cancelProviderOAuth).toHaveBeenCalledWith("state-1"));
  });
  it("keeps a saved account with an inline browser failure and retries without adding a duplicate", async () => {
    const { desktop } = desktopHarness();
    desktop.startProviderOAuth.mockRejectedValueOnce(new Error("Browser launch failed"));
    const render = componentRenderer(ProviderSettings);
    const modalElement = elements(render()).find(n => typeof n.props.onSubmit === "function")!;
    await (modalElement.props.onSubmit as (value: ProviderConfig) => Promise<void>)(config);
    let card = cardElement(render());
    expect(card.props.notice).toEqual({ error: "Browser launch failed" });
    await (card.props.onOAuthLogin as (id: string) => Promise<void>)(config.id);
    card = cardElement(render());
    expect(card.props.notice).toEqual({});
    expect(card.props.status).toMatchObject({ oauthPending: true });
    expect(desktop.addProvider).toHaveBeenCalledTimes(1);
  });
  it("submits a pasted Claude callback to the current authorization session", async () => {
    const { desktop } = desktopHarness([config]);
    const render = componentRenderer(ProviderSettings);
    const modalElement = elements(render()).find(n => typeof n.props.onSubmit === "function")!;
    await (modalElement.props.onSubmit as (value: ProviderConfig) => Promise<void>)(config);
    const card = cardElement(render());
    const callback = "https://console.anthropic.com/oauth/code/callback?code=abc&state=state-1";
    await (card.props.onOAuthCallback as (id: string, state: string, url: string) => Promise<void>)(config.id, "state-1", callback);
    expect(desktop.submitProviderOAuthCallback).toHaveBeenCalledWith("state-1", callback);
    expect(cardElement(render()).props.status).toMatchObject({ authenticated: true });
  });
  it("refreshes provider state when authorization completes and releases the subscription on unmount", async () => {
    const { desktop, listeners, setStatus } = desktopHarness([config]);
    const render = componentRenderer(ProviderSettings);
    render();
    const cleanup = hooks.effects[0]();
    try {
      await vi.waitFor(() => expect(cardElement(render())).toBeDefined());
      expect(desktop.on).toHaveBeenCalledWith(IPC.providerUpdated, expect.any(Function));
      setStatus({ ...status, authenticated: true });
      listeners.get(IPC.providerUpdated)!();
      await vi.waitFor(() => expect(cardElement(render()).props.status).toMatchObject({ authenticated: true }));
    } finally { if (typeof cleanup === "function") cleanup(); }
    expect(listeners.has(IPC.providerUpdated)).toBe(false);
  });
  it("shows provider load errors with a retry action", async () => {
    const { desktop } = desktopHarness();
    desktop.listProviders.mockRejectedValueOnce(new Error("Database unavailable"));
    const render = componentRenderer(ProviderSettings);
    render();
    const cleanup = hooks.effects[0]();
    try {
      await vi.waitFor(() => expect(elements(render()).some(n => n.props.role === "alert")).toBe(true));
      const retry = elements(render()).find(n => n.type === "button" && n.props.children === "重试")!;
      (retry.props.onClick as () => void)();
      await vi.waitFor(() => expect(elements(render()).some(n => n.props.role === "alert")).toBe(false));
    } finally { if (typeof cleanup === "function") cleanup(); }
  });
});

