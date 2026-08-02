import fs from "node:fs";
import { access } from "node:fs/promises";
import { ipcMain, type BrowserWindow } from "electron";
import { IPC } from "@claude-desktop/shared";
import type { AppSettings, PermissionDecision } from "@claude-desktop/shared";
import type { SessionManager } from "./session-manager";
import type { PermissionBroker } from "./permission-broker";
import type { SettingsStore } from "./settings-store";
import type { CpaSupervisor } from "./cpa-supervisor";
import type { DiffTracker } from "./diff-tracker";

export type IpcHandlerContext = {
  window: () => BrowserWindow | null;
  sessions: SessionManager;
  permissions: PermissionBroker;
  settings: SettingsStore;
  cpa: CpaSupervisor;
  diffs: DiffTracker;
};

export function registerIpcHandlers(ctx: IpcHandlerContext): void {
  ipcMain.handle(IPC.projectOpen, async (_e, { path }: { path: string }) => {
    await access(path, fs.constants.R_OK);
    ctx.settings.update({ lastProjectPath: path });
    return { path };
  });

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
      // Chat items are owned by the renderer store (task 11); main returns diffs only.
      return {
        sessionId,
        items: [] as unknown[],
        changes: ctx.diffs.list(sessionId),
      };
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

  ipcMain.handle(IPC.modelSet, async (_e, { model }: { model: string }) => {
    ctx.settings.update({ defaultModel: model });
    return { model };
  });
}
