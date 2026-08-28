import fs from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import iconv from "iconv-lite";
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
import {
  resolveEffectiveCpaPaths,
  writeCpaConfigWithApiKey,
  type RuntimePathEnv,
} from "./runtime-paths";
import type { TerminalHost } from "./terminal-host";
import { resolveInside } from "./project-path";

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
  /** Optional hot-update controller (packaged builds only) */
  autoUpdater?: {
    getStatus: () => unknown;
    check: () => Promise<unknown>;
    download: () => Promise<unknown>;
    quitAndInstall: () => void;
  };
  rooms?: import("./room-service").RoomService;
  /** Desktop UI changed defaultModel — persist into ~/.claude/settings.json */
  onDesktopModelChanged?: (model: string) => void;
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
      ctx.rooms?.reportLocalProject(path);
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

  /** Normalize / whitelist encodings used by the editor status bar. */
  function normalizeFileEncoding(raw?: string): string {
    const e = (raw ?? "utf-8").trim().toLowerCase().replace(/_/g, "-");
    const aliases: Record<string, string> = {
      utf8: "utf-8",
      "utf-8": "utf-8",
      gbk: "gbk",
      gb2312: "gb2312",
      gb18030: "gb18030",
      big5: "big5",
      "utf-16le": "utf-16le",
      "utf-16be": "utf-16be",
      latin1: "latin1",
      iso88591: "latin1",
      "iso-8859-1": "latin1",
    };
    const id = aliases[e] ?? "utf-8";
    if (!iconv.encodingExists(id)) return "utf-8";
    return id;
  }

  ipcMain.handle(
    IPC.fileReadText,
    async (
      _e,
      {
        cwd,
        rel,
        maxBytes,
        encoding,
      }: { cwd: string; rel: string; maxBytes?: number; encoding?: string },
    ) => {
      if (!allowedProjectRoots().has(cwd)) {
        return { ok: false, error: "not an open project" };
      }
      const target = resolveInside(cwd, rel);
      if (!target) return { ok: false, error: "path escapes project" };
      const enc = normalizeFileEncoding(encoding);
      try {
        const stat = await fs.promises.stat(target);
        if (!stat.isFile()) return { ok: false, error: "not a file" };
        const cap = Math.min(maxBytes ?? 512 * 1024, 2 * 1024 * 1024);
        const buf = await fs.promises.readFile(target);
        // UTF-16 intentionally has NULs; other encodings treat NUL as binary.
        if (enc !== "utf-16le" && enc !== "utf-16be" && buf.includes(0)) {
          return { ok: false, error: "binary file" };
        }
        const truncated = buf.length > cap;
        const slice = buf.subarray(0, truncated ? cap : buf.length);
        let content: string;
        if (enc === "utf-8") {
          content = slice.toString("utf8");
        } else {
          content = iconv.decode(slice, enc);
        }
        return { ok: true, content, truncated, encoding: enc };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IPC.fileWriteText,
    async (
      _e,
      {
        cwd,
        rel,
        content,
        encoding,
      }: { cwd: string; rel: string; content: string; encoding?: string },
    ) => {
      if (!allowedProjectRoots().has(cwd)) {
        return { ok: false, error: "not an open project" };
      }
      if (typeof content !== "string") {
        return { ok: false, error: "content must be string" };
      }
      // Soft cap ~4MB UTF-8 payload to avoid accidental huge writes from the UI
      if (Buffer.byteLength(content, "utf8") > 4 * 1024 * 1024) {
        return { ok: false, error: "content too large (>4MB)" };
      }
      const target = resolveInside(cwd, rel);
      if (!target) return { ok: false, error: "path escapes project" };
      const enc = normalizeFileEncoding(encoding);
      try {
        // Only overwrite existing text files (no create-via-editor yet)
        const stat = await fs.promises.stat(target);
        if (!stat.isFile()) return { ok: false, error: "not a file" };
        const buf =
          enc === "utf-8"
            ? Buffer.from(content, "utf8")
            : iconv.encode(content, enc);
        await fs.promises.writeFile(target, buf);
        return { ok: true };
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
      // Project folder is optional: fall back to the last opened folder, then
      // the user home dir so chat works without picking a project first.
      const project = cwd ?? ctx.settings.get().lastProjectPath ?? os.homedir();
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
    IPC.sessionSetPinned,
    async (_e, { sessionId, pinned }: { sessionId: string; pinned: boolean }) => {
      const session = ctx.sessions.setPinned(sessionId, pinned);
      if (!session) return { ok: false, error: `Unknown session: ${sessionId}` };
      return { ok: true, session };
    },
  );

  ipcMain.handle(
    IPC.sessionRename,
    async (_e, { sessionId, title }: { sessionId: string; title: string }) => {
      const session = ctx.sessions.rename(sessionId, title);
      if (!session) return { ok: false, error: `Unknown session: ${sessionId}` };
      return { ok: true, session };
    },
  );

  ipcMain.handle(
    IPC.sessionDelete,
    async (_e, { sessionId }: { sessionId: string }) => {
      const ok = ctx.sessions.delete(sessionId);
      if (!ok) return { ok: false, error: `Unknown session: ${sessionId}` };
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC.sessionSelect,
    async (
      _e,
      { sessionId, limit }: { sessionId: string; limit?: number },
    ) => {
      const summary = ctx.sessions.getSummary(sessionId);
      if (!summary) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      // Restore cwd as last project when user switches sessions.
      if (summary.cwd) {
        ctx.settings.update({ lastProjectPath: summary.cwd });
        ctx.rooms?.reportLocalProject(summary.cwd);
      }
      const page = ctx.sessions.getTranscriptPage(sessionId, { limit });
      return {
        sessionId,
        cwd: summary.cwd,
        items: page.items,
        total: page.total,
        hasMore: page.hasMore,
        hasNewer: page.hasNewer,
        changes: ctx.sessions.getChangesForSelect(sessionId),
      };
    },
  );

  ipcMain.handle(
    IPC.sessionLoadOlder,
    async (
      _e,
      {
        sessionId,
        beforeId,
        limit,
      }: { sessionId: string; beforeId: string; limit?: number },
    ) => {
      return ctx.sessions.getTranscriptPage(sessionId, { beforeId, limit });
    },
  );

  ipcMain.handle(
    IPC.sessionLoadNewer,
    async (
      _e,
      {
        sessionId,
        afterId,
        limit,
      }: { sessionId: string; afterId: string; limit?: number },
    ) => {
      return ctx.sessions.getTranscriptPage(sessionId, { afterId, limit });
    },
  );

  ipcMain.handle(
    IPC.sessionSaveTranscript,
    async (
      _e,
      {
        sessionId,
        items,
        replace,
      }: { sessionId: string; items: ChatItem[]; replace?: boolean },
    ) => {
      ctx.sessions.saveTranscript(sessionId, items, { replace });
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
    IPC.fileImageData,
    async (_e, { path: filePath }: { path: string }) => {
      try {
        if (!filePath || typeof filePath !== "string") {
          return { ok: false, error: "path is required" };
        }
        const mime = guessMimeType(filePath);
        if (!mime.startsWith("image/")) {
          return { ok: false, error: "not an image" };
        }
        const stat = fs.statSync(filePath);
        if (stat.size > 20 * 1024 * 1024) {
          return { ok: false, error: "image too large" };
        }
        const buf = fs.readFileSync(filePath);
        return {
          ok: true,
          dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
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
      if (typeof patch.defaultModel === "string" && patch.defaultModel.trim()) {
        ctx.onDesktopModelChanged?.(patch.defaultModel.trim());
      }
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
    if (model.trim()) ctx.onDesktopModelChanged?.(model.trim());
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
    IPC.sessionAttachCli,
    async (_e, payload?: { sessionId?: string | null }) => {
      try {
        await ctx.cpa.ensureReady();
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const attach = ctx.sessions.releaseForCli(payload?.sessionId);
      if (!attach.claudePath) {
        return { ok: false, error: "找不到 claude 可执行文件" };
      }
      const args = attach.sdkSessionId
        ? ["--resume", attach.sdkSessionId]
        : [];
      const created = ctx.terminal.create(attach.cwd, {
        file: attach.claudePath,
        args,
        env: attach.env,
        label: "claude",
      });
      return {
        ok: true,
        ...created,
        ...(attach.sdkSessionId ? { sdkSessionId: attach.sdkSessionId } : {}),
      };
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

  ipcMain.handle(IPC.appUpdateGetStatus, async () => {
    return (
      ctx.autoUpdater?.getStatus() ?? {
        state: "disabled",
        message: "更新模块未启用",
      }
    );
  });

  ipcMain.handle(IPC.appUpdateCheck, async () => {
    if (!ctx.autoUpdater) {
      return { state: "disabled", message: "更新模块未启用" };
    }
    return ctx.autoUpdater.check();
  });

  ipcMain.handle(IPC.appUpdateDownload, async () => {
    if (!ctx.autoUpdater) {
      return { state: "disabled", message: "更新模块未启用" };
    }
    return ctx.autoUpdater.download();
  });

  ipcMain.handle(IPC.appUpdateInstall, async () => {
    if (!ctx.autoUpdater) return { ok: false };
    ctx.autoUpdater.quitAndInstall();
    return { ok: true };
  });

  ipcMain.handle(IPC.appGetVersion, async () => {
    return { version: app.getVersion() };
  });

  ipcMain.handle(IPC.roomCreate, async (_e, opts) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.create(opts);
  });
  ipcMain.handle(IPC.roomJoin, async (_e, opts) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.join(opts);
  });
  ipcMain.handle(IPC.roomLeave, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.leave(roomId);
  });
  ipcMain.handle(IPC.roomEnd, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.end(roomId);
  });
  ipcMain.handle(IPC.roomList, async () => {
    return { rooms: ctx.rooms?.list() ?? [] };
  });
  ipcMain.handle(IPC.roomGet, async (_e, { roomId }) => {
    return { room: ctx.rooms?.get(roomId) ?? null };
  });
  ipcMain.handle(IPC.roomAddSeat, async (_e, opts) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.addSeat(opts.roomId, opts.kind, opts.name, opts.agentName, {
      agentPrompt: opts.agentPrompt,
      skillNames: opts.skillNames,
      model: opts.model,
      executorUserId: opts.executorUserId,
      aiUserId: opts.aiUserId,
      workspaceUserId: opts.workspaceUserId,
    });
  });
  ipcMain.handle(IPC.roomUpdateSeat, async (_e, opts) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.updateSeat(opts.roomId, opts.seatId, opts);
  });
  ipcMain.handle(IPC.roomTakeover, async (_e, { roomId, seatId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.takeover(roomId, seatId);
  });
  ipcMain.handle(IPC.roomReturnSeat, async (_e, { roomId, seatId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.returnSeat(roomId, seatId);
  });
  ipcMain.handle(IPC.roomSend, async (_e, { roomId, seatId, text, quote, attachments }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.send(roomId, seatId, text, quote, attachments);
  });
  ipcMain.handle(IPC.roomRejoin, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.rejoin(roomId);
  });
  ipcMain.handle(IPC.roomApproveDevice, async (_e, { roomId, fingerprint }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.approveDevice(roomId, fingerprint);
  });
  ipcMain.handle(IPC.roomDenyDevice, async (_e, { roomId, fingerprint }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.denyDevice(roomId, fingerprint);
  });
  ipcMain.handle(IPC.roomKick, async (_e, { roomId, userId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.kick(roomId, userId);
  });
  ipcMain.handle(IPC.roomSetMemberRole, async (_e, { roomId, userId, role }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.setMemberRole(roomId, userId, role);
  });
  ipcMain.handle(IPC.roomSetFilePolicy, async (_e, { roomId, policy }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.setFilePolicy(roomId, policy);
  });
  ipcMain.handle(IPC.roomSetAiShare, async (_e, { roomId, on }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.setAiShare(roomId, on);
  });
  ipcMain.handle(IPC.roomAskAiShare, async (_e, { roomId, targetUserId, seatId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.askAiShare(roomId, targetUserId, seatId);
  });
  ipcMain.handle(IPC.roomPermRespond, async (_e, { requestId, allow }) => {
    if (!ctx.rooms) return { ok: false };
    return ctx.rooms.respondTurnAsk(requestId, allow);
  });
  ipcMain.handle(IPC.roomRename, async (_e, { roomId, name }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.rename(roomId, name);
  });
  ipcMain.handle(IPC.roomRecall, async (_e, { roomId, itemId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.recall(roomId, itemId);
  });
  ipcMain.handle(IPC.roomPending, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, pending: [] };
    return ctx.rooms.pendingDevices(roomId);
  });
  ipcMain.handle(IPC.roomMetrics, async () => {
    if (!ctx.rooms) return { ok: false };
    return { ok: true, snapshot: ctx.rooms.metrics.snapshot() };
  });
  ipcMain.handle(IPC.roomDice, async (_e, { roomId, seatId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.rollDice(roomId, seatId);
  });
  ipcMain.handle(IPC.roomRps, async (_e, { roomId, seatId, hand }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.playRps(roomId, seatId, hand);
  });
  ipcMain.handle(IPC.roomInvite, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.invite(roomId);
  });
  ipcMain.handle(IPC.roomDelete, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.deleteLocal(roomId);
  });
  ipcMain.handle(IPC.roomPeek, async (_e, opts) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.peek(opts);
  });
  ipcMain.handle(IPC.roomFetchMod, async (_e, opts) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.fetchMod(opts);
  });
  ipcMain.handle(IPC.roomEnableMod, async (_e, { roomId, packDir }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.enableMod(roomId, packDir);
  });
  ipcMain.handle(IPC.roomStartMod, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.startMod(roomId);
  });
  ipcMain.handle(IPC.roomEndMod, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.endMod(roomId);
  });
  ipcMain.handle(IPC.roomResetMod, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.resetMod(roomId);
  });
  ipcMain.handle(IPC.roomRecoverMod, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.recoverMod(roomId);
  });
  ipcMain.handle(IPC.roomModIntent, async (_e, { roomId, seatId, name, payload }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.modIntent(roomId, seatId, name, payload);
  });
  ipcMain.handle(IPC.roomListMods, async () => {
    return { mods: ctx.rooms?.listMods().mods ?? [] };
  });
  ipcMain.handle(IPC.modsDelete, async (_e, { packDir }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.deleteMod(packDir);
  });
  ipcMain.handle(IPC.modsOpenDir, async (_e, { packDir }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    const mod = ctx.rooms.listMods().mods.find((m) => m.packDir === packDir);
    if (!mod) return { ok: false, error: "Mod 不存在或已删除" };
    const err = await shell.openPath(mod.packDir);
    return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle(IPC.modsScaffold, async (_e, payload) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.scaffoldMod(payload);
  });
  ipcMain.handle(IPC.roomEnableKernelMod, async (_e, { roomId, packDir }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.enableKernelMod(roomId, packDir);
  });
  ipcMain.handle(IPC.roomDisableKernelMod, async (_e, { roomId, id }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.disableKernelMod(roomId, id);
  });
  ipcMain.handle(IPC.roomListKernelMemory, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.listKernelMemory(roomId);
  });
  ipcMain.handle(IPC.roomSetKernelMemory, async (_e, { roomId, key, value }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.setKernelMemory(roomId, key, value);
  });
  ipcMain.handle(IPC.roomDeleteKernelMemory, async (_e, { roomId, key }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.deleteKernelMemory(roomId, key);
  });
  ipcMain.handle(IPC.roomSetKernelAutonomy, async (_e, { roomId, level }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.setKernelAutonomy(roomId, level);
  });
  ipcMain.handle(IPC.roomGetKernelImprove, async (_e, { roomId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.getKernelImprove(roomId);
  });
  ipcMain.handle(IPC.roomProposeKernelImprove, async (_e, { roomId, packId, modJs, note }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.proposeKernelImprove(roomId, packId, modJs, note);
  });
  ipcMain.handle(IPC.roomApplyKernelProposal, async (_e, { roomId, proposalId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.applyKernelProposal(roomId, proposalId);
  });
  ipcMain.handle(IPC.roomRejectKernelProposal, async (_e, { roomId, proposalId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.rejectKernelProposal(roomId, proposalId);
  });
  ipcMain.handle(IPC.roomRollbackKernelImprove, async (_e, { roomId, packId }) => {
    if (!ctx.rooms) return { ok: false, error: "群聊服务未启用" };
    return ctx.rooms.rollbackKernelImprove(roomId, packId);
  });
  ipcMain.handle(IPC.roomHasMod, async (_e, { checksum }) => {
    if (!ctx.rooms) return { ok: true, has: false };
    return ctx.rooms.hasMod(checksum);
  });

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
