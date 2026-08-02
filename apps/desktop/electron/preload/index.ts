import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@claude-desktop/shared";
import type {
  AppSettings,
  PermissionDecision,
} from "@claude-desktop/shared";

const desktop = {
  openProject: (path: string) =>
    ipcRenderer.invoke(IPC.projectOpen, { path }) as Promise<{ path: string }>,

  startSession: (prompt: string, cwd?: string) =>
    ipcRenderer.invoke(IPC.sessionStart, { prompt, cwd }) as Promise<{
      sessionId: string;
    }>,

  continueSession: (sessionId: string, prompt: string) =>
    ipcRenderer.invoke(IPC.sessionContinue, { sessionId, prompt }) as Promise<{
      sessionId: string;
    }>,

  abortSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionAbort, { sessionId }) as Promise<{
      ok: boolean;
    }>,

  listSessions: () => ipcRenderer.invoke(IPC.sessionList),

  selectSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionSelect, { sessionId }),

  respondPermission: (requestId: string, decision: PermissionDecision) =>
    ipcRenderer.invoke(IPC.permissionRespond, {
      requestId,
      decision,
    }) as Promise<{ ok: boolean }>,

  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),

  setSettings: (patch: Partial<AppSettings> & { token?: string }) =>
    ipcRenderer.invoke(IPC.settingsSet, patch),

  startCpa: () => ipcRenderer.invoke(IPC.cpaStart),

  getCpaStatus: () => ipcRenderer.invoke(IPC.cpaStatus),

  setModel: (model: string) =>
    ipcRenderer.invoke(IPC.modelSet, { model }) as Promise<{ model: string }>,

  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const allowed = new Set<string>(Object.values(IPC));
    if (!allowed.has(channel)) return () => {};
    const handler = (_: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);

export type DesktopApi = typeof desktop;
