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

  getSessionMcpStatus: (sessionId: string) =>
    ipcRenderer.invoke(IPC.sessionMcpStatus, { sessionId }) as Promise<{
      statuses: import("@claude-desktop/shared").SessionMcpServerStatus[] | null;
    }>,

  reconnectSessionMcpServer: (sessionId: string, name: string) =>
    ipcRenderer.invoke(IPC.sessionMcpReconnect, { sessionId, name }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  toggleSessionMcpServer: (sessionId: string, name: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC.sessionMcpToggle, {
      sessionId,
      name,
      enabled,
    }) as Promise<{ ok: boolean; error?: string }>,

  setSessionMcpServers: (
    sessionId: string,
    servers: import("@claude-desktop/shared").McpServersMap,
  ) =>
    ipcRenderer.invoke(IPC.sessionMcpSetServers, { sessionId, servers }) as Promise<{
      ok: boolean;
      result?: import("@claude-desktop/shared").McpSetServersResultDto;
      error?: string;
    }>,

  /** Probe MCP servers without a running session (throwaway SDK query). */
  probeMcpServers: (servers?: import("@claude-desktop/shared").McpServersMap) =>
    ipcRenderer.invoke(IPC.mcpProbe, servers ? { servers } : {}) as Promise<{
      statuses: import("@claude-desktop/shared").SessionMcpServerStatus[];
    }>,

  /**
   * Restore a file to its content before one write operation (eventId) or,
   * without eventId, to its pre-session content.
   */
  restoreChange: (sessionId: string, path: string, eventId?: string) =>
    ipcRenderer.invoke(IPC.diffRestoreFile, {
      sessionId,
      path,
      ...(eventId ? { eventId } : {}),
    }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  /** Restore all changed files of a session to pre-session content. */
  restoreAllChanges: (sessionId: string) =>
    ipcRenderer.invoke(IPC.diffRestoreAll, { sessionId }) as Promise<{
      restored: string[];
      failed: string[];
    }>,

  /**
   * Rewind files + conversation to a user message (SDK checkpointing).
   * dryRun previews the file changes without touching disk.
   */
  rewindSession: (sessionId: string, userMessageId: string, dryRun?: boolean) =>
    ipcRenderer.invoke(IPC.sessionRewind, {
      sessionId,
      userMessageId,
      ...(dryRun ? { dryRun: true } : {}),
    }) as Promise<{
      ok: boolean;
      canRewind?: boolean;
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
      error?: string;
    }>,

  /** Open a file with the OS default editor. */
  openInEditor: (path: string) =>
    ipcRenderer.invoke(IPC.fileOpenInEditor, { path }) as Promise<{
      ok: boolean;
      error?: string;
    }>,

  /** Reveal a file in the OS file manager. */
  revealFile: (path: string) =>
    ipcRenderer.invoke(IPC.fileReveal, { path }) as Promise<{ ok: boolean }>,

  /** Git status of a project directory (branch + changed paths). */
  gitStatus: (cwd: string) =>
    ipcRenderer.invoke(IPC.projectGitStatus, { cwd }) as Promise<{
      isRepo: boolean;
      branch?: string;
      changed?: string[];
    }>,

  compressSession: (
    sessionId: string,
    items?: ChatItem[],
    opts?: { autoContinue?: boolean },
  ) =>
    ipcRenderer.invoke(IPC.sessionCompress, {
      sessionId,
      ...(items ? { items } : {}),
      ...(opts?.autoContinue ? { autoContinue: true } : {}),
    }) as Promise<{
      ok: boolean;
      message?: string;
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

  /** Enumerate project files for @-mention autocomplete (paths relative to cwd). */
  listProjectFiles: (cwd: string, query?: string, limit?: number) =>
    ipcRenderer.invoke(IPC.projectListFiles, { cwd, query, limit }) as Promise<{
      files: string[];
      truncated?: boolean;
    }>,

  respondUserPrompt: (requestId: string, decision: UserPromptDecision) =>
    ipcRenderer.invoke(IPC.userPromptRespond, {
      requestId,
      decision,
    }) as Promise<{ ok: boolean }>,

  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),

  setSettings: (patch: Partial<AppSettings> & { token?: string }) =>
    ipcRenderer.invoke(IPC.settingsSet, patch),

  /** First-run: save gateway token + rewrite CPA config + start CPA. */
  completeOnboarding: (token: string, startCpa = true) =>
    ipcRenderer.invoke(IPC.appCompleteOnboarding, {
      token,
      startCpa,
    }) as Promise<{
      ok: boolean;
      settings: import("@claude-desktop/shared").PublicSettings;
      cpaStatus: import("@claude-desktop/shared").CpaStatus;
      error?: string;
    }>,

  startCpa: () => ipcRenderer.invoke(IPC.cpaStart),

  getCpaStatus: () => ipcRenderer.invoke(IPC.cpaStatus),

  syncCpaModels: () =>
    ipcRenderer.invoke(IPC.cpaSyncModels) as Promise<{
      models: string[];
      defaultModel: string;
    }>,

  getModelCatalog: () =>
    ipcRenderer.invoke(IPC.cpaModelCatalog) as Promise<
      import("@claude-desktop/shared").ModelInfo[]
    >,

  setModel: (model: string) =>
    ipcRenderer.invoke(IPC.modelSet, { model }) as Promise<{ model: string }>,

  createTerminal: (cwd?: string) =>
    ipcRenderer.invoke(
      IPC.terminalCreate,
      cwd !== undefined ? { cwd } : {},
    ) as Promise<{ id: string; cwd: string; shell: string }>,

  writeTerminal: (id: string, data: string) =>
    ipcRenderer.invoke(IPC.terminalWrite, { id, data }) as Promise<{
      ok: boolean;
    }>,

  killTerminal: (id: string) =>
    ipcRenderer.invoke(IPC.terminalKill, { id }) as Promise<{ ok: boolean }>,

  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.terminalResize, { id, cols, rows }) as Promise<{
      ok: boolean;
    }>,

  /** Tell the main process the effective UI theme (window chrome sync). */
  notifyTheme: (theme: "dark" | "light") =>
    ipcRenderer.invoke(IPC.appThemeChanged, { theme }) as Promise<{
      ok: boolean;
    }>,

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
