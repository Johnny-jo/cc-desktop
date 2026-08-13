import fs from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
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
import {
  deleteSkill,
  ensureSkillsDir,
  listSkills,
} from "./skill-store";
import path from "node:path";
import {
  resolveEffectiveCpaPaths,
  writeCpaConfigWithApiKey,
  type RuntimePathEnv,
} from "./runtime-paths";
import type { TerminalHost } from "./terminal-host";

export type IpcHandlerContext = {
  window: () => BrowserWindow | null;
  sessions: SessionManager;
  permissions: PermissionBroker;
  userPrompts: UserPromptBroker;
  settings: SettingsStore;
  cpa: CpaSupervisor;
  diffs: DiffTracker;
  snapshots: SnapshotStore;
  terminal: TerminalHost;
  /** Sync native window chrome when the UI theme flips */
  onThemeChanged?: (theme: "dark" | "light") => void;
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

  /** Allowed cwd roots for project file browsing (open project / session cwds). */
  function allowedProjectRoots(): Set<string> {
    const allowed = new Set<string>();
    const last = ctx.settings.get().lastProjectPath;
    if (last) allowed.add(last);
    for (const s of ctx.sessions.list()) {
      if (s.cwd) allowed.add(s.cwd);
    }
    return allowed;
  }

  /** Resolve rel inside cwd; null when it escapes. */
  function resolveInside(cwd: string, rel: string): string | null {
    const base = path.resolve(cwd);
    const target = path.resolve(base, rel || ".");
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    return target;
  }

  const TREE_IGNORED = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".cache",
    "coverage",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".turbo",
  ]);

  ipcMain.handle(
    IPC.projectListDir,
    async (_e, { cwd, rel }: { cwd: string; rel?: string }) => {
      if (!allowedProjectRoots().has(cwd)) {
        throw new Error("project:list-dir cwd is not an open project");
      }
      const dir = resolveInside(cwd, rel ?? "");
      if (!dir) throw new Error("path escapes project");
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const out: Array<{ name: string; rel: string; kind: "dir" | "file" }> = [];
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".claude") continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (TREE_IGNORED.has(e.name)) continue;
          out.push({ name: e.name, rel: childRel, kind: "dir" });
        } else if (e.isFile()) {
          out.push({ name: e.name, rel: childRel, kind: "file" });
        }
      }
      out.sort((a, b) =>
        a.kind !== b.kind
          ? a.kind === "dir"
            ? -1
            : 1
          : a.name.localeCompare(b.name),
      );
      return { entries: out };
    },
  );

  ipcMain.handle(
    IPC.fileReadText,
    async (
      _e,
      { cwd, rel, maxBytes }: { cwd: string; rel: string; maxBytes?: number },
    ) => {
      if (!allowedProjectRoots().has(cwd)) {
        return { ok: false, error: "not an open project" };
      }
      const target = resolveInside(cwd, rel);
      if (!target) return { ok: false, error: "path escapes project" };
      try {
        const stat = await fs.promises.stat(target);
        if (!stat.isFile()) return { ok: false, error: "not a file" };
        const cap = Math.min(maxBytes ?? 512 * 1024, 2 * 1024 * 1024);
        const buf = await fs.promises.readFile(target);
        if (buf.includes(0)) {
          return { ok: false, error: "binary file" };
        }
        const truncated = buf.length > cap;
        const content = buf
          .subarray(0, truncated ? cap : buf.length)
          .toString("utf8");
        return { ok: true, content, truncated };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
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
    async (
      _e,
      {
        sessionId,
        path,
        eventId,
      }: { sessionId: string; path: string; eventId?: string },
    ) => {
      if (!ctx.sessions.getSummary(sessionId)) {
        return { ok: false, error: `Unknown session: ${sessionId}` };
      }
      if (eventId) {
        return ctx.sessions.restoreChangeEvent(sessionId, eventId);
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
    IPC.sessionRewind,
    async (
      _e,
      {
        sessionId,
        userMessageId,
        dryRun,
      }: { sessionId: string; userMessageId: string; dryRun?: boolean },
    ) => {
      return await ctx.sessions.rewindToUserMessage(sessionId, userMessageId, {
        dryRun: Boolean(dryRun),
      });
    },
  );

  ipcMain.handle(
    IPC.fileOpenInEditor,
    async (_e, { path: filePath }: { path: string }) => {
      if (!filePath || typeof filePath !== "string") {
        return { ok: false, error: "path is required" };
      }
      const err = await shell.openPath(filePath);
      return err ? { ok: false, error: err } : { ok: true };
    },
  );

  ipcMain.handle(
    IPC.fileReveal,
    async (_e, { path: filePath }: { path: string }) => {
      if (filePath && typeof filePath === "string") {
        shell.showItemInFolder(filePath);
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC.projectGitStatus,
    (_e, { cwd }: { cwd: string }) =>
      new Promise((resolve) => {
        if (!cwd) {
          resolve({ isRepo: false });
          return;
        }
        execFile(
          "git",
          ["-C", cwd, "status", "--porcelain=v1", "--branch"],
          { timeout: 5000, maxBuffer: 1024 * 1024 },
          (err, stdout) => {
            if (err) {
              resolve({ isRepo: false });
              return;
            }
            const lines = String(stdout).split("\n").filter(Boolean);
            let branch: string | undefined;
            const changed: string[] = [];
            for (const line of lines) {
              if (line.startsWith("## ")) {
                branch = line.slice(3).split("...")[0]?.trim() || undefined;
                continue;
              }
              // porcelain: "XY path" (renames show "orig -> new"; keep new)
              const p = line.slice(3).split(" -> ").pop()?.trim();
              if (p) changed.push(p);
            }
            resolve({ isRepo: true, branch, changed });
          },
        );
      }),
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

  /**
   * First-run onboarding: save gateway token, rewrite CPA config api-keys to
   * match, re-resolve bundled paths, optionally start CPA.
   */
  ipcMain.handle(
    IPC.appCompleteOnboarding,
    async (
      _e,
      { token, startCpa }: { token: string; startCpa?: boolean },
    ) => {
      const trimmed = (token ?? "").trim();
      if (!trimmed) {
        return {
          ok: false,
          settings: ctx.settings.getPublic(),
          cpaStatus: ctx.cpa.getStatus(),
          error: "Token is required",
        };
      }
      try {
        const pathEnv: RuntimePathEnv = {
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          userDataDir: app.getPath("userData"),
        };
        const current = ctx.settings.get();
        const configPath = writeCpaConfigWithApiKey(pathEnv, {
          port: current.cpaPort || 8317,
          apiKey: trimmed,
        });
        const paths = resolveEffectiveCpaPaths(
          pathEnv,
          { ...current, cpaConfigPath: configPath },
          { apiKey: trimmed },
        );
        ctx.settings.update({
          token: trimmed,
          cpaExePath: paths.cpaExePath,
          cpaConfigPath: paths.cpaConfigPath,
          setupCompleted: true,
        });
        let cpaStatus = ctx.cpa.getStatus();
        if (startCpa !== false) {
          cpaStatus = await ctx.cpa.ensureReady();
        }
        return {
          ok: true,
          settings: ctx.settings.getPublic(),
          cpaStatus,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          settings: ctx.settings.getPublic(),
          cpaStatus: ctx.cpa.getStatus(),
          error: message,
        };
      }
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

  ipcMain.handle(
    IPC.terminalCreate,
    async (_e, payload?: { cwd?: string }) => {
      const cwd =
        payload?.cwd?.trim() ||
        ctx.settings.get().lastProjectPath ||
        undefined;
      return ctx.terminal.create(cwd);
    },
  );

  ipcMain.handle(
    IPC.terminalWrite,
    async (_e, { id, data }: { id: string; data: string }) => {
      return { ok: ctx.terminal.write(id, data) };
    },
  );

  ipcMain.handle(
    IPC.terminalKill,
    async (_e, { id }: { id: string }) => {
      return { ok: ctx.terminal.kill(id) };
    },
  );

  ipcMain.handle(
    IPC.terminalResize,
    async (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
      ctx.terminal.resize(id, cols, rows);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC.appThemeChanged,
    (_e, { theme }: { theme: "dark" | "light" }) => {
      ctx.onThemeChanged?.(theme);
      return { ok: true };
    },
  );

  ipcMain.handle(IPC.skillsList, async () => {
    const cwd = ctx.settings.get().lastProjectPath ?? null;
    return listSkills(cwd);
  });

  ipcMain.handle(
    IPC.skillsOpenDir,
    async (_e, { scope }: { scope: "user" | "project" }) => {
      try {
        const cwd = ctx.settings.get().lastProjectPath ?? null;
        const dir = ensureSkillsDir(scope, cwd);
        const err = await shell.openPath(dir);
        return err ? { ok: false, error: err } : { ok: true, path: dir };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IPC.skillsDelete,
    async (
      _e,
      { name, scope }: { name: string; scope: "user" | "project" },
    ) => {
      const cwd = ctx.settings.get().lastProjectPath ?? null;
      return deleteSkill(name, scope, cwd);
    },
  );

  ipcMain.handle(
    IPC.skillsReload,
    async (_e, { sessionId }: { sessionId: string }) => {
      return await ctx.sessions.reloadSkills(sessionId);
    },
  );
}
