import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@claude-desktop/shared";
import type { DesktopApi } from "../preload";
import { registerIpcHandlers, type IpcHandlerContext } from "./ipc-handlers";
import "../preload";

const bridge = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  desktop: null as unknown,
  openExternal: vi.fn().mockResolvedValue(undefined),
  prepare: vi.fn(),
  status: vi.fn(),
  authorizationStatus: vi.fn(),
  saveAuthorization: vi.fn(),
  clearAuthorization: vi.fn(),
}));

vi.mock("./browser-extension-setup", () => ({
  prepareBrowserExtension: bridge.prepare,
  getBrowserExtensionStatus: bridge.status,
}));

vi.mock("./browser-authorization", () => ({
  getBrowserAuthorizationStatus: bridge.authorizationStatus,
  saveBrowserAuthorization: bridge.saveAuthorization,
  clearBrowserAuthorization: bridge.clearAuthorization,
}));

vi.mock("electron", () => ({
  app: {}, BrowserWindow: {}, dialog: {}, webUtils: {},
  shell: { openExternal: bridge.openExternal },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => bridge.handlers.set(channel, handler) },
  ipcRenderer: { invoke: async (channel: string, ...args: unknown[]) => {
    const handler = bridge.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for ${channel}`);
    return handler({}, ...args);
  } },
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { bridge.desktop = api; } },
}));

describe("browser extension install IPC", () => {
  beforeEach(() => {
    bridge.handlers.clear();
    bridge.openExternal.mockReset().mockResolvedValue(undefined);
    bridge.prepare.mockReset().mockResolvedValue({ browser: "msedge", profileName: "Profile 2", state: "pending-enable", registered: true, message: "请确认启用" });
    bridge.status.mockReset().mockResolvedValue({ browser: "chrome", profileName: "Default", state: "ready", registered: true, message: "已就绪" });
    bridge.authorizationStatus.mockReset().mockResolvedValue({ browser: "msedge", profileName: "Profile 2", configured: true });
    bridge.saveAuthorization.mockReset().mockResolvedValue({ browser: "msedge", profileName: "Profile 2", configured: true });
    bridge.clearAuthorization.mockReset().mockResolvedValue({ browser: "msedge", profileName: "Profile 2", configured: false });
    registerIpcHandlers({} as IpcHandlerContext);
  });

  it("opens the official store in the OS browser and cannot be redirected by renderer input", async () => {
    const api = bridge.desktop as DesktopApi;
    await api.openBrowserExtension();
    const rawHandler = bridge.handlers.get(IPC.appOpenBrowserExtension)!;
    await rawHandler({}, "file:///private-file", { url: "https://other.example" });
    expect(bridge.openExternal.mock.calls).toEqual([
      ["https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm"],
      ["https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm"],
    ]);
  });

  it("propagates OS opening errors to the settings caller", async () => {
    bridge.openExternal.mockRejectedValueOnce(new Error("No browser is configured"));
    await expect((bridge.desktop as DesktopApi).openBrowserExtension()).rejects.toThrow("No browser is configured");
  });

  it("prepares the chosen browser/profile without accepting alternate extension sources", async () => {
    const api = bridge.desktop as DesktopApi;
    const result = await api.setupBrowserExtension({ browser: "msedge", profile: "Profile 2" });
    expect(result.state).toBe("pending-enable");
    expect(bridge.prepare).toHaveBeenCalledWith("msedge", "Profile 2");
    const handler = bridge.handlers.get(IPC.appSetupBrowserExtension)!;
    await handler({}, { browser: "chrome", profile: "Default", update_url: "https://other.example", extensionId: "other" });
    expect(bridge.prepare).toHaveBeenLastCalledWith("chrome", "Default");
  });

  it("checks status without preparing and rejects invalid browser/profile inputs", async () => {
    const api = bridge.desktop as DesktopApi;
    expect((await api.getBrowserExtensionStatus({ browser: "chrome" })).state).toBe("ready");
    expect(bridge.status).toHaveBeenCalledWith("chrome", undefined);
    expect(bridge.prepare).not.toHaveBeenCalled();
    const handler = bridge.handlers.get(IPC.appSetupBrowserExtension)!;
    await expect(handler({}, { browser: "firefox" })).rejects.toThrow();
    await expect(handler({}, { browser: "msedge", profile: "../../outside" })).rejects.toThrow();
    expect(bridge.prepare).not.toHaveBeenCalled();
  });

  it("saves authorization for the selected profile and returns status without a token", async () => {
    const token = "a".repeat(43);
    const result = await (bridge.desktop as DesktopApi).saveBrowserAuthorization({ browser: "msedge", profile: "Profile 2", token });
    expect(bridge.saveAuthorization).toHaveBeenCalledWith("msedge", "Profile 2", token);
    expect(result).toEqual({ browser: "msedge", profileName: "Profile 2", configured: true });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("reads and clears only the requested browser/profile authorization", async () => {
    const api = bridge.desktop as DesktopApi;
    await api.getBrowserAuthorizationStatus({ browser: "msedge" });
    expect(bridge.authorizationStatus).toHaveBeenCalledWith("msedge", undefined);
    expect((await api.clearBrowserAuthorization({ browser: "chrome", profile: "Default" })).configured).toBe(false);
    expect(bridge.clearAuthorization).toHaveBeenCalledWith("chrome", "Default");
    expect(bridge.saveAuthorization).not.toHaveBeenCalled();
  });

  it("rejects malformed authorization requests before saving", async () => {
    const handler = bridge.handlers.get(IPC.appSaveBrowserAuthorization)!;
    await expect(handler({}, { browser: "msedge", profile: "../other", token: "a".repeat(43) })).rejects.toThrow();
    await expect(handler({}, { browser: "firefox", token: "a".repeat(43) })).rejects.toThrow();
    await expect(handler({}, { browser: "msedge", token: 123 })).rejects.toThrow();
    await expect(handler({}, { browser: "msedge", token: "" })).rejects.toThrow();
    expect(bridge.saveAuthorization).not.toHaveBeenCalled();
  });
});
