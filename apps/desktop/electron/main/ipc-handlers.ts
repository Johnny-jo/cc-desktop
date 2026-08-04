import fs from "node:fs";
import { access } from "node:fs/promises";
import { dialog, ipcMain, type BrowserWindow } from "electron";
import { IPC } from "@claude-desktop/shared";
import type {
  AppSettings,
  ChatItem,
  PermissionDecision,
  UserPromptDecision,
} from "@claude-desktop/shared";
import type { SessionManager } from "./session-manager";
import type { PermissionBroker } from "./permission-broker";
import type { UserPromptBroker } from "./user-prompt-broker";
import type { SettingsStore } from "./settings-store";
import type { CpaSupervisor } from "./cpa-supervisor";
import type { DiffTracker } from "./diff-tracker";

export type IpcHandlerContext = {
  window: () => BrowserWindow | null;
  sessions: SessionManager;
  permissions: PermissionBroker;
  userPrompts: UserPromptBroker;
  settings: SettingsStore;
  cpa: CpaSupervisor;
  diffs: DiffTracker;
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
    IPC.sessionStart,
    async (_e, { prompt, cwd }: { prompt: string; cwd?: string }) => {
      const project = cwd ?? ctx.settings.get().lastProjectPath;
      if (!project) throw new Error("No project open");
      // Note: SessionManager.start awaits the full turn before resolving.
      const sessionId = await ctx.sessions.start(prompt, project);
      return { sessionId };
    },
  );

  ipcMain.handle(
    IPC.sessionContinue,
    async (_e, { sessionId, prompt }: { sessionId: string; prompt: string }) => {
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
        changes: ctx.diffs.list(sessionId),
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

  ipcMain.handle(IPC.modelSet, async (_e, { model }: { model: string }) => {
    ctx.settings.update({ defaultModel: model });
    return { model };
  });
}
