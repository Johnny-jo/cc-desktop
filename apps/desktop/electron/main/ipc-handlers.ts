import fs from "node:fs";
import { access } from "node:fs/promises";
import { dialog, ipcMain, type BrowserWindow } from "electron";
import { IPC, validateMcpServers } from "@claude-desktop/shared";
import type {
  AppSettings,
  Attachment,
  ChatItem,
  McpServersMap,
  PermissionDecision,
  UserPromptDecision,
  UserPrompt,
} from "@claude-desktop/shared";
import { attachmentFromFile, guessMimeType } from "@claude-desktop/shared";
import type { SessionManager } from "./session-manager";
import type { PermissionBroker } from "./permission-broker";
import type { UserPromptBroker } from "./user-prompt-broker";
import type { SettingsStore } from "./settings-store";
import type { CpaSupervisor } from "./cpa-supervisor";
import type { DiffTracker } from "./diff-tracker";
import type { SnapshotStore } from "./snapshot-store";
import { listProjectFiles } from "./file-index";

export type IpcHandlerContext = {
  window: () => BrowserWindow | null;
  sessions: SessionManager;
  permissions: PermissionBroker;
  userPrompts: UserPromptBroker;
  settings: SettingsStore;
  cpa: CpaSupervisor;
  diffs: DiffTracker;
  snapshots: SnapshotStore;
};

export function registerIpcHandlers(ctx: IpcHandlerContext): void {
  ipcMain.handle(
    IPC.projectOpen,
    async (_e, payload?: { path?: string }) => {
      let path = payload?.path?.trim() ?? "";

      if (!path) {
        const win = ctx.window();
        const res = win
          ? await dialog.showOpenDialog(win, {
              properties: ["openDirectory"],
              title: "Open project folder",
            })
          : await dialog.showOpenDialog({
              properties: ["openDirectory"],
              title: "Open project folder",
            });
        if (res.canceled || !res.filePaths[0]) {
          throw new Error("canceled");
        }
        path = res.filePaths[0];
      }

      await access(path, fs.constants.R_OK);
      ctx.settings.update({ lastProjectPath: path });
      return { path };
    },
  );

  ipcMain.handle(
    IPC.fileReadAttachment,
    async (_e, { path }: { path: string }): Promise<Attachment> => {
      const stats = await fs.promises.stat(path);
      if (!stats.isFile()) {
        throw new Error(`Not a file: ${path}`);
      }
      return attachmentFromFile({
        name: path.split(/[/\\]/).pop() || path,
        path,
        size: stats.size,
        type: guessMimeType(path),
      });
    },
  );

  ipcMain.handle(IPC.fileSelect, async () => {
    const win = ctx.window();
    const res = win
      ? await dialog.showOpenDialog(win, {
          properties: ["openFile", "multiSelections"],
          title: "Attach files",
        })
      : await dialog.showOpenDialog({
          properties: ["openFile", "multiSelections"],
          title: "Attach files",
        });
    if (res.canceled || !res.filePaths.length) {
      return { paths: [] };
    }
    return { paths: res.filePaths };
  });

  ipcMain.handle(
    IPC.projectListFiles,
    async (
      _e,
      { cwd, query, limit }: { cwd: string; query?: string; limit?: number },
    ) => {
      // Security: only enumerate the open project or an active session's cwd,
      // so the renderer can't probe arbitrary filesystem paths. Names only —
      // contents are never read here.
      const allowed = new Set<string>();
      const last = ctx.settings.get().lastProjectPath;
      if (last) allowed.add(last);
      for (const s of ctx.sessions.list()) {
        if (s.cwd) allowed.add(s.cwd);
      }
      if (!allowed.has(cwd)) {
        throw new Error("project:list-files cwd is not an open project");
      }
      return listProjectFiles(cwd, query ?? "", limit ?? 50);
    },
  );

  ipcMain.handle(
    IPC.sessionStart,
    async (_e, { prompt, cwd }: { prompt: UserPrompt; cwd?: string }) => {
      const project = cwd ?? ctx.settings.get().lastProjectPath;
      if (!project) throw new Error("No project open");
      // Note: SessionManager.start awaits the full turn before resolving.
      const sessionId = await ctx.sessions.start(prompt, project);
      return { sessionId };
    },
  );

  ipcMain.handle(
    IPC.sessionContinue,
    async (_e, { sessionId, prompt }: { sessionId: string; prompt: UserPrompt }) => {
      // Note: SessionManager.continue awaits the full turn before resolving.
      await ctx.sessions.continue(sessionId, prompt);
      return { sessionId };
    },
  );

  ipcMain.handle(
    IPC.sessionAbort,
    async (_e, { sessionId }: { sessionId: string }) => {
      ctx.sessions.abort(sessionId);
      return { ok: true };
    },
  );

  ipcMain.handle(IPC.sessionList, async () => ctx.sessions.list());

  ipcMain.handle(
    IPC.sessionSelect,
    async (_e, { sessionId }: { sessionId: string }) => {
      const summary = ctx.sessions.getSummary(sessionId);
      if (!summary) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      // Restore cwd as last project when user switches sessions.
      if (summary.cwd) {
        ctx.settings.update({ lastProjectPath: summary.cwd });
      }
      const items = ctx.sessions.getTranscript(sessionId);
      return {
        sessionId,
        cwd: summary.cwd,
        items,
        changes: ctx.sessions.getChangesForSelect(sessionId),
      };
    },
  );

  ipcMain.handle(
    IPC.sessionSaveTranscript,
    async (
      _e,
      { sessionId, items }: { sessionId: string; items: ChatItem[] },
    ) => {
      ctx.sessions.saveTranscript(sessionId, items);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC.sessionSlashCommands,
    async (_e, { sessionId }: { sessionId: string }) => {
      return { commands: ctx.sessions.getSlashCommands(sessionId) };
    },
  );

  ipcMain.handle(
    IPC.sessionMcpStatus,
    async (_e, { sessionId }: { sessionId: string }) => {
      const statuses = await ctx.sessions.getMcpStatus(sessionId);
      return { statuses };
    },
  );

  ipcMain.handle(
    IPC.sessionMcpReconnect,
    async (_e, { sessionId, name }: { sessionId: string; name: string }) => {
      return await ctx.sessions.reconnectMcpServer(sessionId, name);
    },
  );

  ipcMain.handle(
    IPC.sessionMcpToggle,
    async (
      _e,
      {
        sessionId,
        name,
        enabled,
      }: { sessionId: string; name: string; enabled: boolean },
    ) => {
      return await ctx.sessions.toggleMcpServer(sessionId, name, enabled);
    },
  );

  ipcMain.handle(
    IPC.sessionMcpSetServers,
    async (
      _e,
      { sessionId, servers }: { sessionId: string; servers: McpServersMap },
    ) => {
      const validated = validateMcpServers(servers);
      if (!validated.ok) return { ok: false, error: validated.error };
      return await ctx.sessions.setMcpServers(
        sessionId,
        validated.mcpServers,
      );
    },
  );

  ipcMain.handle(
    IPC.mcpProbe,
    async (_e, { servers }: { servers?: McpServersMap } = {}) => {
      if (servers) {
        const validated = validateMcpServers(servers);
        if (!validated.ok) {
          throw new Error(validated.error);
        }
        return {
          statuses: await ctx.sessions.probeMcpServers(validated.mcpServers),
        };
      }
      return { statuses: await ctx.sessions.probeMcpServers() };
    },
  );

  ipcMain.handle(
    IPC.diffRestoreFile,
    async (_e, { sessionId, path }: { sessionId: string; path: string }) => {
      if (!ctx.sessions.getSummary(sessionId)) {
        return { ok: false, error: `Unknown session: ${sessionId}` };
      }
      return ctx.sessions.restoreChange(sessionId, path);
    },
  );

  ipcMain.handle(
    IPC.diffRestoreAll,
    async (_e, { sessionId }: { sessionId: string }) => {
      if (!ctx.sessions.getSummary(sessionId)) {
        return { restored: [], failed: [] };
      }
      return ctx.sessions.restoreAllChanges(sessionId);
    },
  );

  ipcMain.handle(
    IPC.sessionCompress,
    async (
      _e,
      {
        sessionId,
        items,
        autoContinue,
      }: { sessionId: string; items?: ChatItem[]; autoContinue?: boolean },
    ) => {
      return await ctx.sessions.compressSession(sessionId, items, {
        autoContinue: Boolean(autoContinue),
      });
    },
  );

  ipcMain.handle(
    IPC.permissionRespond,
    async (
      _e,
      {
        requestId,
        decision,
      }: { requestId: string; decision: PermissionDecision },
    ) => {
      const ok = ctx.permissions.respond(requestId, decision);
      return { ok };
    },
  );

  ipcMain.handle(
    IPC.userPromptRespond,
    async (
      _e,
      {
        requestId,
        decision,
      }: { requestId: string; decision: UserPromptDecision },
    ) => {
      const ok = ctx.userPrompts.respond(requestId, decision);
      return { ok };
    },
  );

  ipcMain.handle(IPC.settingsGet, async () => ctx.settings.getPublic());

  ipcMain.handle(
    IPC.settingsSet,
    async (_e, patch: Partial<AppSettings> & { token?: string }) => {
      ctx.settings.update(patch);
      return ctx.settings.getPublic();
    },
  );

  ipcMain.handle(IPC.cpaStart, async () => ctx.cpa.ensureReady());

  ipcMain.handle(IPC.cpaStatus, async () => ctx.cpa.getStatus());

  ipcMain.handle(IPC.cpaSyncModels, async () => {
    await ctx.cpa.ensureReady();
    const catalog = await ctx.cpa.listModelCatalog();
    const models = catalog.map((m) => m.id);
    if (models.length === 0) {
      throw new Error("CPA returned an empty model list");
    }
    const current = ctx.settings.get();
    const defaultModel = models.includes(current.defaultModel)
      ? current.defaultModel
      : models[0];
    ctx.settings.update({ models, defaultModel });
    return { models, defaultModel };
  });

  ipcMain.handle(IPC.cpaModelCatalog, async () => {
    return ctx.cpa.getModelCatalog();
  });

  ipcMain.handle(IPC.modelSet, async (_e, { model }: { model: string }) => {
    ctx.settings.update({ defaultModel: model });
    return { model };
  });
}
