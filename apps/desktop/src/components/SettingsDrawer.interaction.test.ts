import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { zh } from "../i18n/zh";
import { SettingsDrawer } from "./SettingsDrawer";
import { ControlSettings } from "./settings/ControlSettings";
import type { McpServersMap } from "@claude-desktop/shared";

const state = vi.hoisted(() => ({
  settings: { models: [] as string[], mcpServers: {} as McpServersMap },
  activeSessionId: "active", sessions: [{ id: "active", status: "idle" }],
}));
const actions = vi.hoisted(() => ({
  save: vi.fn(async () => undefined),
  apply: vi.fn(async () => ({ ok: true, result: { errors: { custom: "custom error" } } })),
  probe: vi.fn(async () => ({ statuses: [{ name: "custom", status: "connected" }] })),
}));
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }));
vi.mock("../state/store", () => ({
  useAppStore: (selector: (s: typeof state) => unknown) => selector(state),
  saveSettings: actions.save,
}));
vi.mock("../i18n/useI18n", () => ({ useI18n: () => ({ t: zh }) }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: () => {},
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
  state.settings = {
    models: [],
    mcpServers: {
      workChrome: { type: "playwright", browser: "chrome", connection: "isolated", profile: "Profile 1" },
      custom: { command: "node" },
    },
  };
  vi.stubGlobal("navigator", { platform: "Win32" });
  vi.stubGlobal("window", { desktop: {
    setSessionMcpServers: actions.apply, probeMcpServers: actions.probe,
    getSessionMcpStatus: async () => ({ statuses: [] }),
  } });
});

describe("control settings navigation", () => {
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
