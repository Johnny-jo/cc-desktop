import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zh } from "../i18n/zh";
import { SettingsDrawer } from "./SettingsDrawer";
import { ControlSettings } from "./settings/ControlSettings";
import { IPC, type McpServersMap } from "@claude-desktop/shared";

const state = vi.hoisted(() => ({
  settings: { models: [] as string[], mcpServers: {} as McpServersMap },
  activeSessionId: "active", sessions: [{ id: "active", status: "idle" }],
}));
const actions = vi.hoisted(() => ({
  save: vi.fn(async (_patch: unknown) => undefined),
  apply: vi.fn(async () => ({ ok: true, result: { errors: { custom: "custom error" } } })),
  probe: vi.fn(async () => ({ statuses: [{ name: "custom", status: "connected" }] })),
  catalog: vi.fn(async () => [{ id: "old/model" }]),
}));
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as Array<() => void | (() => void)> }));
const providerListeners = new Map<string, Set<() => void>>();
vi.mock("../state/store", () => ({
  useAppStore: (selector: (s: typeof state) => unknown) => selector(state),
  saveSettings: actions.save,
  getState: () => state,
}));
vi.mock("../i18n/useI18n", () => ({ useI18n: () => ({ t: zh }) }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    return hooks.slots[i] ??= { current: initial };
  },
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[i], (next: unknown) => {
      hooks.slots[i] = typeof next === "function" ? next(hooks.slots[i]) : next;
    }];
  },
}));

function elements(tree: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  return React.Children.toArray(tree).flatMap(child => React.isValidElement<Record<string, unknown>>(child)
    ? [child, ...elements(child.props.children as React.ReactNode)] : []);
}

function render() {
  hooks.cursor = 0;
  return SettingsDrawer({ open: true, onClose: vi.fn() });
}

function clickButton(tree: React.ReactNode, pattern: RegExp) {
  const button = elements(tree).find(node => node.type === "button" &&
    pattern.test(renderToStaticMarkup(node.props.children as React.ReactNode)));
  if (!button) throw new Error(`Missing button ${pattern}`);
  (button.props.onClick as () => void)();
}

function controlPage() {
  const node = elements(render()).find(node => node.type === ControlSettings);
  if (!node) throw new Error("Missing control settings page");
  return node as React.ReactElement<React.ComponentProps<typeof ControlSettings>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.effects = [];
  providerListeners.clear();
  actions.catalog.mockReset().mockResolvedValue([{ id: "old/model" }]);
  state.settings = {
    models: [],
    mcpServers: {
      workChrome: { type: "playwright", browser: "chrome", connection: "isolated", profile: "Profile 1" },
      custom: { command: "node" },
    },
  };
  vi.stubGlobal("navigator", { platform: "Win32" });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn(), documentElement: { style: { setProperty: vi.fn() } } });
  vi.stubGlobal("window", { desktop: {
    setSessionMcpServers: actions.apply, probeMcpServers: actions.probe,
    getSessionMcpStatus: async () => ({ statuses: [] }),
    getModelCatalog: actions.catalog, listProviders: async () => [],
    listSkills: async () => ({ userDir: "test", projectDir: null, skills: [] }),
    on: (channel: string, listener: () => void) => {
      let listeners = providerListeners.get(channel);
      if (!listeners) providerListeners.set(channel, listeners = new Set());
      listeners.add(listener); return () => listeners.delete(listener);
    },
  }, setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("live settings model refresh", () => {
  function flushEffects() { for (const effect of hooks.effects.splice(0)) effect(); }
  it("updates the open configured-model list without discarding an unsaved context limit", async () => {
    Object.assign(state.settings, { models: ["old/model"], defaultModel: "old/model" });
    render(); flushEffects();
    clickButton(render(), /^<span[^>]*>模型与上下文</);
    const context = elements(render()).find(n => n.type === "input" && n.props.value === "200000")!;
    (context.props.onChange as (e: unknown) => void)({ target: { value: "123456" } });
    state.settings = { ...state.settings, models: ["old/model", ...Array.from({ length: 6 }, (_, i) => `custom/model-${i}`)] };
    hooks.effects = []; render(); flushEffects();
    clickButton(render(), /^<span[^>]*>通用</);
    expect(elements(render()).filter(n => n.props.className === "settings-model-list-row")).toHaveLength(7);
    clickButton(render(), /^保存更改$/);
    await vi.waitFor(() => expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ models: state.settings.models, defaultContextLimit: 123456 })));
  });
  it("refreshes catalog suggestions when provider capabilities change without changing model IDs", async () => {
    render(); flushEffects();
    await vi.waitFor(() => expect(actions.catalog).toHaveBeenCalledTimes(1));
    actions.catalog.mockClear().mockResolvedValue([{ id: "custom/new" }]);
    for (const listener of providerListeners.get(IPC.modelCatalogUpdated) ?? []) listener();
    await vi.waitFor(() => expect(actions.catalog).toHaveBeenCalledTimes(1));
  });
});

describe("control settings navigation", () => {
  it("edits a CDP endpoint without loading local extension authorization or profile data", async () => {
    state.settings.mcpServers = { remote: { type: "playwright", browser: "chrome", connection: "cdp", cdpEndpoint: "http://127.0.0.1:9222" } };
    const extensionStatus = vi.fn();
    const authorizationStatus = vi.fn();
    Object.assign((window as unknown as { desktop: Record<string, unknown> }).desktop, {
      getBrowserExtensionStatus: extensionStatus, getBrowserAuthorizationStatus: authorizationStatus,
    });
    clickButton(render(), /^<span[^>]*>操控</);
    controlPage().props.onExpand("chrome");
    const page = controlPage();
    const html = renderToStaticMarkup(page);
    expect(html).toContain("CDP 连接地址");
    expect(html).not.toContain("日常浏览器配置目录");
    expect(html).not.toContain("保存连接授权");
    for (const effect of hooks.effects.splice(0)) effect();
    await Promise.resolve();
    expect(extensionStatus).not.toHaveBeenCalled();
    expect(authorizationStatus).not.toHaveBeenCalled();
    const current = controlPage();
    const profile = current.props.renderProfile(current.props.rows[0], 0);
    const input = elements(profile).find(node => node.props["aria-label"] === "CDP 连接地址")!;
    (input.props.onChange as (e: unknown) => void)({ target: { value: "ws://localhost:9333/devtools/browser/id" } });
    clickButton(render(), /^保存更改$/);
    await vi.waitFor(() => expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: {
      remote: { type: "playwright", browser: "chrome", connection: "cdp", cdpEndpoint: "ws://localhost:9333/devtools/browser/id" },
    } })));
  });

  it("saves preferences without a gateway credential or configured models and preserves legacy connection fields", async () => {
    Object.assign(state.settings, { cpaPort: 0, cpaExePath: "legacy.exe", cpaConfigPath: "legacy.yaml", hasToken: false });
    clickButton(render(), /^保存更改$/);
    await vi.waitFor(() => expect(actions.save).toHaveBeenCalled());
    const patch = actions.save.mock.calls[0][0] as Record<string, unknown>;
    for (const key of ["cpaPort", "cpaExePath", "cpaConfigPath", "token", "shutdownCpaOnQuit"]) expect(patch).not.toHaveProperty(key);
    const html = renderToStaticMarkup(render());
    expect(html).not.toContain("网关 Token");
    expect(html).not.toContain("CPA");
  });

  it("offers context controls without exposing legacy gateway process settings", () => {
    clickButton(render(), /^<span[^>]*>模型与上下文</);
    const html = renderToStaticMarkup(render());
    expect(html).toContain("默认上下文窗口");
    expect(html).not.toContain("CPA");
    expect(html).not.toContain("config.yaml");
    const input = elements(render()).find(n => n.type === "input" && n.props.value === "200000")!;
    expect(input.props.step).toBe(1);
  });

  it("scopes custom probes and exposes each browser's own profiles and setup actions", async () => {
    clickButton(render(), /^<span[^>]*>MCP 服务器</);
    const custom = render();
    expect(renderToStaticMarkup(custom)).toContain("添加本地服务器");
    expect(renderToStaticMarkup(custom)).not.toContain("workChrome");
    clickButton(custom, /^测试连接$/);
    expect(actions.probe).toHaveBeenCalledWith({ custom: { command: "node" } });
    await Promise.resolve();

    clickButton(render(), /^<span[^>]*>操控</);
    const page = controlPage();
    const html = renderToStaticMarkup(page);
    expect(html.match(/role="switch"/g)).toHaveLength(3);
    expect(html).toContain("按 Esc 退出控制");
    expect(html).not.toContain("测试通过 1 / 1");
    page.props.onExpand("chrome");
    const isolated = renderToStaticMarkup(controlPage());
    expect(isolated).toContain("workChrome");
    expect(isolated).not.toContain("保存连接授权");
    page.props.onToggle("msedge", true);
    page.props.onExpand("msedge");
    const daily = renderToStaticMarkup(controlPage());
    expect(daily).toContain("自动安装并检测");
    expect(daily).toContain("保存连接授权");
  });

  it("saves control choices before models are set up, applies enabled entries, and routes errors to their page", async () => {
    clickButton(render(), /^<span[^>]*>操控</);
    controlPage().props.onToggle("chrome", false);
    clickButton(render(), /^保存更改$/);
    await vi.waitFor(() => expect(actions.apply).toHaveBeenCalledWith("active", { custom: { command: "node" } }));
    expect(actions.save).toHaveBeenCalledWith(expect.objectContaining({
      disabledControlServers: { workChrome: state.settings.mcpServers.workChrome },
    }));
    expect(renderToStaticMarkup(controlPage())).not.toContain("custom error");
    clickButton(render(), /^<span[^>]*>MCP 服务器</);
    expect(renderToStaticMarkup(render())).toContain("custom error");
  });
});
