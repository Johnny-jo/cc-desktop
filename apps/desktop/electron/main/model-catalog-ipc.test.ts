import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@claude-desktop/shared";
import { registerIpcHandlers, type IpcHandlerContext } from "./ipc-handlers";

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, dialog: {}, shell: {}, ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) } }));

beforeEach(() => handlers.clear());
describe("model catalog reads", () => {
  it("returns six already-synced models without waiting for another offline provider or a live SDK", async () => {
    const catalog = Array.from({ length: 6 }, (_, i) => ({ id: `gateway/model-${i}` }));
    const cpa = { getModelCatalog: vi.fn(() => catalog), listModelCatalog: vi.fn(() => new Promise(() => {})) };
    const sessions = { refreshModelCatalog: vi.fn(() => new Promise(() => {})) };
    registerIpcHandlers({ cpa, sessions } as unknown as IpcHandlerContext);
    const result = handlers.get(IPC.cpaModelCatalog)!({});
    await Promise.resolve();
    expect(cpa.getModelCatalog).toHaveBeenCalledTimes(1);
    expect(cpa.listModelCatalog).not.toHaveBeenCalled();
    expect(sessions.refreshModelCatalog).not.toHaveBeenCalled();
    expect(await result).toEqual(catalog);
  });
  it("continues to perform discovery on an explicit sync", async () => {
    const catalog = [{ id: "gateway/new" }];
    const state = { models: [] as string[], defaultModel: "" };
    const cpa = { ensureReady: vi.fn(async () => {}), listModelCatalog: vi.fn(async () => catalog) };
    const settings = { get: () => state, update: (patch: typeof state) => Object.assign(state, patch) };
    registerIpcHandlers({ cpa, settings } as unknown as IpcHandlerContext);
    expect(await handlers.get(IPC.cpaSyncModels)!({})).toEqual({ models: ["gateway/new"], defaultModel: "gateway/new" });
    expect(cpa.listModelCatalog).toHaveBeenCalledTimes(1);
  });
});
