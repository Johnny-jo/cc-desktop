import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "@claude-desktop/shared";
import type {
  AppSettings,
  Attachment,
  ChatItem,
  PermissionDecision,
  UserPrompt,
  UserPromptDecision,
} from "@claude-desktop/shared";

const desktop = {
  /** Omit path to open the native directory picker. */
  openProject: (path?: string) =>
    ipcRenderer.invoke(
      IPC.projectOpen,
      path !== undefined ? { path } : {},
    ) as Promise<{ path: string }>,

  startSession: (prompt: UserPrompt, cwd?: string) =>
    ipcRenderer.invoke(IPC.sessionStart, { prompt, cwd }) as Promise<{
      sessionId: string;
    }>,

  continueSession: (sessionId: string, prompt: UserPrompt) =>
    ipcRenderer.invoke(IPC.sessionContinue, { sessionId, prompt }) as Promise<{
      sessionId: string;
    }>,

  abortSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionAbort, { sessionId }) as Promise<{
      ok: boolean;
    }>,

  listSessions: () => ipcRenderer.invoke(IPC.sessionList),

  selectSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionSelect, { sessionId }) as Promise<{
      sessionId: string;
      cwd: string;
      items: ChatItem[];
      changes: import("@claude-desktop/shared").FileChange[];
    }>,

  saveSessionTranscript: (sessionId: string, items: ChatItem[]) =>
    ipcRenderer.invoke(IPC.sessionSaveTranscript, {
      sessionId,
      items,
    }) as Promise<{ ok: boolean }>,

  getSessionSlashCommands: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionSlashCommands, { sessionId }) as Promise<{
      commands: import("@claude-desktop/shared").SlashCommandItem[];
    }>,

  respondPermission: (requestId: string, decision: PermissionDecision) =>
    ipcRenderer.invoke(IPC.permissionRespond, {
      requestId,
      decision,
    }) as Promise<{ ok: boolean }>,

  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  readAttachment: (path: string) =>
    ipcRenderer.invoke(IPC.fileReadAttachment, { path }) as Promise<Attachment>,

  selectFiles: () =>
    ipcRenderer.invoke(IPC.fileSelect) as Promise<{ paths: string[] }>,

  respondUserPrompt: (requestId: string, decision: UserPromptDecision) =>
    ipcRenderer.invoke(IPC.userPromptRespond, {
      requestId,
      decision,
    }) as Promise<{ ok: boolean }>,

  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),

  setSettings: (patch: Partial<AppSettings> & { token?: string }) =>
    ipcRenderer.invoke(IPC.settingsSet, patch),

  startCpa: () => ipcRenderer.invoke(IPC.cpaStart),

  getCpaStatus: () => ipcRenderer.invoke(IPC.cpaStatus),

  syncCpaModels: () =>
    ipcRenderer.invoke(IPC.cpaSyncModels) as Promise<{
      models: string[];
      defaultModel: string;
    }>,

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
