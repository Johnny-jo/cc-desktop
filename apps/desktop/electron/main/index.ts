import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  safeStorage,
  Tray,
} from "electron";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { IPC } from "@claude-desktop/shared";
import type {
  CpaStatus,
  FileChange,
  PermissionRequest,
  SdkNormalizedEvent,
  SessionSummary,
  SlashCommandItem,
  UserPromptRequest,
} from "@claude-desktop/shared";
import { SettingsStore } from "./settings-store";
import { DiffTracker } from "./diff-tracker";
import { SnapshotStore } from "./snapshot-store";
import { PermissionBroker } from "./permission-broker";
import { UserPromptBroker } from "./user-prompt-broker";
import { CpaSupervisor } from "./cpa-supervisor";
import { SessionArchive } from "./session-archive";
import { SessionManager, type QueryFn } from "./session-manager";
import { createContextCompressor } from "./context-compressor";
import { registerIpcHandlers } from "./ipc-handlers";
import {
  getClaudeExecutablePath,
  isPlaceholderCpaConfig,
  repairCpaManagementConfig,
  resolveEffectiveCpaPaths,
  writeCpaConfigWithApiKey,
  type RuntimePathEnv,
} from "./runtime-paths";
import { userSkillsDir } from "./skill-store";
import { TerminalHost } from "./terminal-host";
import { AppAutoUpdater } from "./auto-updater";
import { RoomService } from "./room-service";
import { RoomArchive } from "./room-archive";
import {
  watchClaudeCodeModel,
  writeClaudeCodeModel,
} from "./claude-settings-sync";

/** Match the renderer charcoal theme (`--bg-app`). */
const APP_BG = "#141414";
/** Light theme chrome (`--bg-app` for light). */
const APP_BG_LIGHT = "#f7f7f8";
const TITLE_SYMBOL_DARK = "#e8e8e8";
const TITLE_SYMBOL_LIGHT = "#1c1c1e";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** True after tray Quit / app.quit — main window close should destroy, not hide. */
let isQuitting = false;
/**
 * Ready webContents ids (main + detached session windows). A window is
 * removed while its page reloads / closes — blocks webContents.send storms.
 */
const readyRenderers = new Set<number>();

/** Sync frameless window chrome (titleBarOverlay) with the UI theme. */
function applyWindowTheme(theme: "dark" | "light"): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.setTitleBarOverlay({
        color: theme === "light" ? APP_BG_LIGHT : APP_BG,
        symbolColor: theme === "light" ? TITLE_SYMBOL_LIGHT : TITLE_SYMBOL_DARK,
        height: 36,
      });
      win.setBackgroundColor(theme === "light" ? APP_BG_LIGHT : APP_BG);
    } catch {
      // older Electron without setTitleBarOverlay — ignore
    }
  }
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  createWindow();
}

function createTray(): void {
  if (tray && !tray.isDestroyed()) return;
  if (!fs.existsSync(WINDOW_ICON)) return;
  tray = new Tray(WINDOW_ICON);
  tray.setToolTip("CC Desktop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开主窗口", click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => showMainWindow());
}

/**
 * Safe IPC push to every live renderer (main window + detached session
 * windows). During Vite HMR / reload / close the BrowserWindow may still
 * exist while the render frame is already gone. Unconditional
 * webContents.send then throws (sometimes async): "Render frame was disposed
 * before WebFrameMain could be accessed" and floods the console while
 * SessionManager is still streaming.
 */
function sendToRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed() || !readyRenderers.has(wc.id)) continue;
    try {
      if (typeof wc.getOSProcessId === "function" && wc.getOSProcessId() <= 0) {
        continue;
      }
    } catch {
      continue;
    }
    try {
      wc.send(channel, payload);
    } catch {
      readyRenderers.delete(wc.id);
    }
  }
}

/**
 * Production queryFn: real Agent SDK.
 * SessionManager keeps queryFn injectable so unit tests can mock the stream.
 * Options are built by SessionManager (cwd/env/canUseTool/resume/…).
 */
const realQueryFn: QueryFn = ({ prompt, options }) =>
  query({
    // Streaming MessageStream is structurally compatible with SDKUserMessage.
    prompt: prompt as Parameters<typeof query>[0]["prompt"],
    options: options as Parameters<typeof query>[0]["options"],
  });


function createTokenCrypto(): {
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
} {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encrypt: (plain: string) =>
        safeStorage.encryptString(plain).toString("base64"),
      decrypt: (cipher: string) =>
        safeStorage.decryptString(Buffer.from(cipher, "base64")),
    };
  }
  // Fallback keeps SettingsStore DI usable when OS encryption is unavailable.
  return {
    encrypt: (plain: string) => Buffer.from(plain, "utf8").toString("base64"),
    decrypt: (cipher: string) => Buffer.from(cipher, "base64").toString("utf8"),
  };
}

/** Per-window renderer readiness gate (HMR reload / crash / close). */
function wireRendererGate(win: BrowserWindow): void {
  const id = win.webContents.id;
  readyRenderers.delete(id);
  win.webContents.on("did-start-loading", () => readyRenderers.delete(id));
  win.webContents.on("did-finish-load", () => readyRenderers.add(id));
  win.webContents.on("dom-ready", () => readyRenderers.add(id));
  win.webContents.on("render-process-gone", () => readyRenderers.delete(id));
  win.webContents.on("destroyed", () => readyRenderers.delete(id));
}

function loadRenderer(
  win: BrowserWindow,
  query?: Record<string, string>,
): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(
      path.join(__dirname, "../renderer/index.html"),
      query ? { query } : undefined,
    );
  }
}

/** Loose PNG for the window / taskbar icon in dev; packaged builds bake it into the exe. */
const WINDOW_ICON = path.join(__dirname, "../../build/icon.png");

function buildWindow(width: number, height: number): BrowserWindow {
  const win = new BrowserWindow({
    width,
    height,
    backgroundColor: APP_BG,
    ...(fs.existsSync(WINDOW_ICON) ? { icon: WINDOW_ICON } : {}),
    // No File/Edit/View menu bar — this is a desktop chat app, not an editor.
    autoHideMenuBar: true,
    // Hide OS title (icon + app name); keep only dark min/max/close.
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: APP_BG,
      symbolColor: "#e8e8e8",
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  wireRendererGate(win);
  return win;
}

function createWindow() {
  // Dark chrome to match the in-app charcoal UI (title bar / window frame).
  nativeTheme.themeSource = "dark";

  mainWindow = buildWindow(1280, 800);

  // Fully remove the default application menu (File / Edit / View / …).
  Menu.setApplicationMenu(null);

  loadRenderer(mainWindow);

  // DevTools access (menu bar is removed, so bind it explicitly):
  // - F12 / Ctrl+Shift+I toggles DevTools
  // - Dev mode (ELECTRON_RENDERER_URL) opens them detached automatically
  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (input.type !== "keyDown") return;
    if (
      input.key === "F12" ||
      ((input.control || input.meta) &&
        input.shift &&
        input.key.toLowerCase() === "i")
    ) {
      if (mainWindow?.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow?.webContents.openDevTools({ mode: "detach" });
      }
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("close", (e) => {
    if (isQuitting || !tray || tray.isDestroyed()) return;
    e.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Browser-style drag-out: a chat-only window bound to one session. */
function createSessionWindow(sessionId: string) {
  const win = buildWindow(960, 720);
  loadRenderer(win, { detached: "1", session: sessionId });
}

/** Double-click / drag-out: a room-only window bound to one room. */
function createRoomWindow(roomId: string) {
  const win = buildWindow(960, 720);
  loadRenderer(win, { detached: "1", room: roomId });
}

function bootstrap() {
  const { encrypt, decrypt } = createTokenCrypto();
  const userDataDir = app.getPath("userData");
  const settings = new SettingsStore({
    userDataDir,
    encrypt,
    decrypt,
  });

  // Resolve bundled Claude + CPA paths (packaged resources/ or vendor/ dev).
  const pathEnv: RuntimePathEnv = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataDir,
  };
  const claudeExe = getClaudeExecutablePath(pathEnv);
  const current = settings.get();
  const cpaPaths = resolveEffectiveCpaPaths(pathEnv, current, {
    apiKey: settings.getToken(),
  });
  // Seed settings when empty or still on legacy hard-coded paths.
  if (
    current.cpaExePath !== cpaPaths.cpaExePath ||
    current.cpaConfigPath !== cpaPaths.cpaConfigPath
  ) {
    settings.update({
      cpaExePath: cpaPaths.cpaExePath,
      cpaConfigPath: cpaPaths.cpaConfigPath,
    });
  }
  // Older installs used disable-control-panel: true and empty secret-key,
  // which makes /management.html fail with a network/404 error even though
  // GET / still works. Repair is panel-only: never rewrites non-empty keys.
  repairCpaManagementConfig(cpaPaths.cpaConfigPath, {
    apiKey: settings.getToken(),
    port: current.cpaPort,
  });
  // Legacy: token exists but wizard flag missing. Mark complete WITHOUT
  // rewriting CPA config if the user already customized it (providers,
  // hashed secret-key, non-placeholder api-keys). Full rewrite only when
  // config still looks like the virgin template.
  if (settings.getToken() && !settings.get().setupCompleted) {
    try {
      const cfgPath = cpaPaths.cpaConfigPath;
      const body =
        cfgPath && fs.existsSync(cfgPath)
          ? fs.readFileSync(cfgPath, "utf8")
          : "";
      if (!body || isPlaceholderCpaConfig(body)) {
        writeCpaConfigWithApiKey(pathEnv, {
          port: settings.get().cpaPort || 8317,
          apiKey: settings.getToken()!,
        });
      }
    } catch {
      // non-fatal — flag still gets set so we never loop rewrite attempts
    }
    settings.update({ setupCompleted: true });
  }

  // Fresh machines have no ~/.claude at all. Create the skills root so
  // Settings → Skills「打开目录」always works and the dir is discoverable
  // by the CLI's skill loader (it reads but may not create it).
  try {
    fs.mkdirSync(userSkillsDir(), { recursive: true });
  } catch {
    // ignore — non-fatal
  }

  const archive = new SessionArchive(userDataDir);

  const diffs = new DiffTracker({
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
  });

  // Per-operation content snapshots for change rollback (persisted on disk).
  const snapshots = new SnapshotStore(userDataDir);
  diffs.onBeforeWrite = (sessionId, filePath, eventId) => {
    snapshots.capture(sessionId, eventId, filePath);
  };

  const permissions = new PermissionBroker({
    getMode: () => settings.get().permissionMode,
    getAllowRules: () => settings.get().permissionAllow ?? [],
    getDenyRules: () => settings.get().permissionDeny ?? [],
    onAddAllowRule: (rule: string) => {
      const cur = settings.get().permissionAllow ?? [];
      if (!cur.includes(rule)) {
        settings.update({ permissionAllow: [...cur, rule] });
      }
    },
    requestFromUi: (req: PermissionRequest) => {
      sendToRenderer(IPC.permissionRequest, req);
    },
  });

  const userPrompts = new UserPromptBroker({
    requestFromUi: (req: UserPromptRequest) => {
      sendToRenderer(IPC.userPromptRequest, req);
    },
  });

  const cpa = new CpaSupervisor({
    getSettings: () => settings.get(),
    getToken: () => settings.getToken(),
    onStatusChange: (status: CpaStatus) => {
      sendToRenderer(IPC.cpaStatusEvent, status);
    },
  });

  const sessions = new SessionManager({
    queryFn: realQueryFn,
    permissionBroker: permissions,
    userPromptBroker: userPrompts,
    diffTracker: diffs,
    cpa,
    settings,
    archive,
    snapshots,
    isPackaged: app.isPackaged,
    claudeExecutablePath: claudeExe,
    compressor: createContextCompressor(
      () => settings.get(),
      () => settings.getToken(),
    ),
    emit: (event: SdkNormalizedEvent) => {
      sendToRenderer(IPC.sessionEvent, event);
      // 远程执行节点：命中本机在跑的席位会话时节流转发进度给房主
      rooms?.onSessionEvent(event);
    },
    emitSession: (summary: SessionSummary) => {
      sendToRenderer(IPC.sessionUpdated, summary);
    },
    emitDiff: (sessionId: string, changes: FileChange[]) => {
      sendToRenderer(IPC.diffUpdated, { sessionId, changes });
    },
    emitSlashCommands: (sessionId: string, commands: SlashCommandItem[]) => {
      sendToRenderer(IPC.sessionSlashCommandsEvent, { sessionId, commands });
    },
    onNotification: (n) => {
      // Desktop notification only when the window isn't focused — when the
      // user is looking at the app, the in-app UI already shows everything.
      const win = getMainWindow();
      if (win && !win.isDestroyed() && win.isFocused()) return;
      if (!Notification.isSupported()) return;
      const title = n.title || "CC Desktop";
      const body = n.message.length > 200 ? `${n.message.slice(0, 200)}…` : n.message;
      const notification = new Notification({ title, body });
      notification.on("click", () => {
        const w = getMainWindow();
        if (w && !w.isDestroyed()) {
          w.show();
          w.focus();
        }
      });
      notification.show();
    },
  });

  const terminal = new TerminalHost(
    (e) => sendToRenderer(IPC.terminalData, e),
    (e) => sendToRenderer(IPC.terminalExit, e),
  );

  const autoUpdater = new AppAutoUpdater({
    getWindow: getMainWindow,
    getFeedUrl: () =>
      process.env.CLAUDE_DESKTOP_UPDATE_URL?.trim() ||
      settings.get().updateFeedUrl ||
      undefined,
  });

  const roomArchive = new RoomArchive(userDataDir);
  const rooms = new RoomService({
    getWindow: getMainWindow,
    sessions,
    settings,
    archive: roomArchive,
    userDataDir,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    cpa,
  });

  const applyCliModelToDesktop = (model: string) => {
    const cur = settings.get();
    const models = cur.models.includes(model)
      ? cur.models
      : [...cur.models, model];
    if (cur.defaultModel === model && models.length === cur.models.length) {
      return;
    }
    settings.update({ defaultModel: model, models });
    sendToRenderer(IPC.settingsUpdated, settings.getPublic());
  };

  registerIpcHandlers({
    window: getMainWindow,
    sessions,
    permissions,
    userPrompts,
    settings,
    cpa,
    diffs,
    snapshots,
    terminal,
    onThemeChanged: applyWindowTheme,
    autoUpdater,
    rooms,
    onDesktopModelChanged: (model) => {
      try {
        writeClaudeCodeModel(model);
      } catch {
        // ignore — desktop setting already persisted
      }
    },
  });

  const stopClaudeSettingsWatch = watchClaudeCodeModel(applyCliModelToDesktop);

  // Browser-style drag-out: open a session in its own chat-only window.
  ipcMain.handle(
    IPC.windowOpenSession,
    async (_e, { sessionId }: { sessionId: string }) => {
      if (!sessions.getSummary(sessionId)) {
        return { ok: false, error: `Unknown session: ${sessionId}` };
      }
      createSessionWindow(sessionId);
      return { ok: true };
    },
  );

  // Double-click / drag-out: open a room in its own room-only window.
  ipcMain.handle(
    IPC.windowOpenRoom,
    async (_e, { roomId }: { roomId: string }) => {
      if (!rooms.get(roomId)) {
        return { ok: false, error: `Unknown room: ${roomId}` };
      }
      createRoomWindow(roomId);
      return { ok: true };
    },
  );

  createWindow();
  createTray();
  // Hot updates replace app binaries only — never AppData / CPA config.
  autoUpdater.start();

  app.on("before-quit", () => {
    isQuitting = true;
    stopClaudeSettingsWatch();
    // stopIfManaged is a no-op unless this app spawned CPA.
    // Always call it so managed children are not orphaned on quit.
    cpa.stopIfManaged();
    rooms.disposeAll();
    terminal.killAll();
    // Close streaming sessions so consumers finish cleanly.
    for (const s of sessions.list()) {
      try {
        sessions.closeSession(s.id);
      } catch {
        // ignore
      }
    }
  });
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  // Tray keeps the process alive so the main window can be restored.
  if (tray && !tray.isDestroyed()) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  showMainWindow();
});
