import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  nativeImage,
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
import { PhotoFlowService } from "./photo-flow-service";
import { fetchPhotoFlow } from "./photo-flow-fetch";
import { DiffTracker } from "./diff-tracker";
import { SnapshotStore } from "./snapshot-store";
import { PermissionBroker } from "./permission-broker";
import { UserPromptBroker } from "./user-prompt-broker";
import { ProviderRuntime } from "./provider-runtime";
import { ProviderUsageStore } from "./provider-usage-store";
import { applyProviderModelCatalog } from "./provider-model-sync";
import { SessionArchive } from "./session-archive";
import { SessionManager, type QueryFn } from "./session-manager";
import { PdfCompatibilityProxy } from "./pdf-compatibility-proxy";
import { createContextCompressor } from "./context-compressor";
import { registerIpcHandlers } from "./ipc-handlers";
import { ProviderManager } from "./provider-manager";
import { QuotaManager } from "./provider-quota-manager";
import { OAuthHandler } from "./oauth-handler";
import { CredentialManager } from "./credential-manager";
import { registerProviderHandlers } from "./provider-ipc-handlers";
import {
  getClaudeExecutablePath,
  type RuntimePathEnv,
} from "./runtime-paths";
import { retireBuiltinPathGuardSkill, userSkillsDir } from "./skill-store";
import { TerminalHost } from "./terminal-host";
import { AppAutoUpdater } from "./auto-updater";
import { RoomService } from "./room-service";
import { RoomArchive } from "./room-archive";
import { AppDatabase } from "./app-database";
import {
  watchClaudeCodeModel,
  writeClaudeCodeModel,
} from "./claude-settings-sync";
import {
  acceptsRoom,
  acceptsSession,
  type RendererScope,
} from "./renderer-routing";

/** Match the renderer charcoal theme (`--bg-app`). */
const APP_BG = "#141414";
/** Light theme chrome (`--bg-app` for light). */
const APP_BG_LIGHT = "#f7f7f8";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** True after tray Quit / app.quit — main window close should destroy, not hide. */
let isQuitting = false;
/**
 * Ready webContents ids (main + detached session windows). A window is
 * removed while its page reloads / closes — blocks webContents.send storms.
 */
const readyRenderers = new Set<number>();
const rendererScopes = new Map<number, RendererScope>();
let terminalHost: TerminalHost | null = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

/** Sync only the backing surface; caption controls belong to the renderer. */
function applyWindowTheme(theme: "dark" | "light", senderId: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.id !== senderId) continue;
    try {
      win.setBackgroundColor(theme === "light" ? APP_BG_LIGHT : APP_BG);
    } catch {
      // The window may have closed during the notification.
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
function sendToMatchingRenderers(
  channel: string,
  payload: unknown,
  accepts: (scope: RendererScope, webContentsId: number) => boolean,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed() || !readyRenderers.has(wc.id)) continue;
    const scope = rendererScopes.get(wc.id);
    if (!scope || !accepts(scope, wc.id)) continue;
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

function sendToRenderer(channel: string, payload: unknown): void {
  sendToMatchingRenderers(channel, payload, () => true);
}

function sendToSessionRenderers(
  sessionId: string,
  channel: string,
  payload: unknown,
  relatedRoomId?: string,
): void {
  sendToMatchingRenderers(channel, payload, (scope) =>
    acceptsSession(scope, sessionId, relatedRoomId),
  );
}

function sendToRoomRenderers(
  roomId: string,
  channel: string,
  payload: unknown,
): void {
  sendToMatchingRenderers(channel, payload, (scope) =>
    acceptsRoom(scope, roomId),
  );
}

function sendToRendererOwner(
  ownerWebContentsId: number | undefined,
  channel: string,
  payload: unknown,
): void {
  if (ownerWebContentsId == null) {
    sendToRenderer(channel, payload);
    return;
  }
  sendToMatchingRenderers(
    channel,
    payload,
    (_scope, webContentsId) => webContentsId === ownerWebContentsId,
  );
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
  win.webContents.on("destroyed", () => {
    readyRenderers.delete(id);
    rendererScopes.delete(id);
    terminalHost?.killOwnedBy(id);
  });
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

/**
 * Loose PNG used by BrowserWindow and the Windows notification-area tray.
 * `build/` is not inside app.asar, so packaged builds read the copy emitted
 * to `resources/icon.ico` by electron-builder.
 */
const WINDOW_ICON = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(__dirname, "../../build/icon.png");

function buildWindow(
  width: number,
  height: number,
  scope: RendererScope,
): BrowserWindow {
  const win = new BrowserWindow({
    width,
    height,
    // Floor for window shrink: below this the chat column collapses and
    // header/composer styles start overlapping.
    minWidth: 960,
    minHeight: 600,
    backgroundColor: APP_BG,
    ...(fs.existsSync(WINDOW_ICON) ? { icon: WINDOW_ICON } : {}),
    // No File/Edit/View menu bar — this is a desktop chat app, not an editor.
    autoHideMenuBar: true,
    // Caption controls are rendered with the page so theme reveals include them.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  rendererScopes.set(win.webContents.id, scope);
  wireRendererGate(win);
  return win;
}

function createWindow() {
  // Dark chrome to match the in-app charcoal UI (title bar / window frame).
  nativeTheme.themeSource = "dark";

  mainWindow = buildWindow(1280, 800, { kind: "main" });

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
  if (
    process.env.ELECTRON_RENDERER_URL &&
    process.env.CC_DESKTOP_OPEN_DEVTOOLS === "1"
  ) {
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
  const win = buildWindow(960, 720, { kind: "session", sessionId });
  loadRenderer(win, { detached: "1", session: sessionId });
}

/** Double-click / drag-out: a room-only window bound to one room. */
function createRoomWindow(roomId: string) {
  const win = buildWindow(960, 720, { kind: "room", roomId });
  loadRenderer(win, { detached: "1", room: roomId });
}

function bootstrap() {
  const { encrypt, decrypt } = createTokenCrypto();
  const userDataDir = app.getPath("userData");
  const database = AppDatabase.open(userDataDir);
  const settings = new SettingsStore({
    userDataDir,
    encrypt,
    decrypt,
  });

  // Resolve the bundled Claude CLI; model credentials and transport are app-owned.
  const pathEnv: RuntimePathEnv = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataDir,
  };
  const claudeExe = getClaudeExecutablePath(pathEnv);

  // Fresh machines have no ~/.claude at all. Create the skills root so
  // Settings → Skills「打开目录」always works and the dir is discoverable
  // by the CLI's skill loader (it reads but may not create it).
  try {
    fs.mkdirSync(userSkillsDir(), { recursive: true });
  } catch {
    // ignore — non-fatal
  }
  // Retire the old auto-triggering skill; room prompts carry the rules inline.
  retireBuiltinPathGuardSkill();

  const archive = new SessionArchive(userDataDir, database);

  const diffs = new DiffTracker({
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
  });

  // Per-operation content snapshots for change rollback (persisted on disk).
  const snapshots = new SnapshotStore(userDataDir);
  const snapshotCleanup = snapshots.cleanup(
    new Set(archive.loadIndex().map((session) => session.id)),
  );
  if (snapshotCleanup.removedSessions || snapshotCleanup.removedEvents) {
    console.info("Snapshot cleanup", snapshotCleanup);
  }
  diffs.onBeforeWrite = (sessionId, filePath, eventId) => {
    snapshots.capture(sessionId, eventId, filePath);
  };

  const showDesktopNotification = (args: {
    title: string;
    body: string;
    showWhenFocused?: boolean;
  }) => {
    const win = getMainWindow();
    if (
      !args.showWhenFocused &&
      win &&
      !win.isDestroyed() &&
      win.isFocused()
    ) {
      return;
    }
    if (!Notification.isSupported()) return;
    const body =
      args.body.length > 200 ? `${args.body.slice(0, 200)}…` : args.body;
    const notification = new Notification({ title: args.title, body });
    notification.on("click", () => {
      const target = getMainWindow();
      if (target && !target.isDestroyed()) {
        target.show();
        target.focus();
      }
    });
    notification.show();
  };

  const prefersChinese = () => {
    const locale = settings.get().locale;
    return locale === "zh" ||
      (locale === "system" && app.getLocale().toLowerCase().startsWith("zh"));
  };

  const permissions = new PermissionBroker({
    onResolved: (requestId, sessionId) => {
      sendToSessionRenderers(sessionId, IPC.permissionResolved, { requestId }, rooms?.roomIdForSession(sessionId));
    },
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
      sendToSessionRenderers(
        req.sessionId,
        IPC.permissionRequest,
        req,
        rooms?.roomIdForSession(req.sessionId),
      );
      const question = req.toolName === "AskUserQuestion";
      showDesktopNotification({
        title: prefersChinese()
          ? question
            ? "AI 正在等待你的回答"
            : "AI 正在等待你的确认"
          : question
            ? "AI is waiting for your answer"
            : "AI is waiting for confirmation",
        body: req.summary || req.toolName,
        showWhenFocused: true,
      });
    },
  });

  const userPrompts = new UserPromptBroker({
    requestFromUi: (req: UserPromptRequest) => {
      sendToSessionRenderers(
        req.sessionId,
        IPC.userPromptRequest,
        req,
        rooms?.roomIdForSession(req.sessionId),
      );
      showDesktopNotification({
        title: prefersChinese()
          ? "AI 正在等待你的回答"
          : "AI is waiting for your answer",
        body: req.message || req.title,
        showWhenFocused: true,
      });
    },
  });

  const providerManager = new ProviderManager({ userDataDir });
  const quotaManager = new QuotaManager();
  const providerCredentials = new CredentialManager(
    safeStorage.isEncryptionAvailable() ? { encrypt, decrypt } : null,
  );
  const oauthHandler = new OAuthHandler(providerManager, providerCredentials);
  const providerUsage = ProviderUsageStore.open(userDataDir);
  const modelRuntime = new ProviderRuntime({
    providerManager, quotaManager, credentials: providerCredentials, oauthHandler,
    getDefaultModel: () => settings.get().defaultModel,
    usageStore: providerUsage,
    onUsageUpdated: () => sendToRenderer(IPC.providerUsageUpdated, { at: Date.now() }),
    onStatusChange: (status: CpaStatus) => sendToRenderer(IPC.cpaStatusEvent, status),
    onCatalogChanged: (validatedProviderId) => {
      if (applyProviderModelCatalog(modelRuntime.getModelCatalog(), settings, providerManager.listConfigs().filter(c => c.enabled).map(c => c.id), validatedProviderId)) {
        sendToRenderer(IPC.settingsUpdated, settings.getPublic());
      }
      sendToRenderer(IPC.modelCatalogUpdated, { at: Date.now() });
    },
  });

  const sessions = new SessionManager({
    pdfCompatibility: new PdfCompatibilityProxy(),
    queryFn: realQueryFn,
    permissionBroker: permissions,
    userPromptBroker: userPrompts,
    diffTracker: diffs,
    cpa: modelRuntime,
    settings,
    archive,
    snapshots,
    isPackaged: app.isPackaged,
    claudeExecutablePath: claudeExe,
    browserAuthStorePath: path.join(userDataDir, "browser-auth.json"),
    compressor: createContextCompressor(
      () => settings.get(),
      () => modelRuntime.getProxyTarget(),
    ),
    emit: (event: SdkNormalizedEvent) => {
      sendToSessionRenderers(event.sessionId, IPC.sessionEvent, event);
      // 远程执行节点：命中本机在跑的席位会话时节流转发进度给房主
      rooms?.onSessionEvent(event);
    },
    emitSession: (summary: SessionSummary) => {
      sendToSessionRenderers(summary.id, IPC.sessionUpdated, summary);
    },
    emitDiff: (sessionId: string, changes: FileChange[]) => {
      sendToSessionRenderers(
        sessionId,
        IPC.diffUpdated,
        { sessionId, changes },
        rooms?.roomIdForSession(sessionId),
      );
    },
    emitSlashCommands: (sessionId: string, commands: SlashCommandItem[]) => {
      sendToSessionRenderers(sessionId, IPC.sessionSlashCommandsEvent, {
        sessionId,
        commands,
      });
    },
    onNotification: (n) => {
      showDesktopNotification({
        title: n.title || "CC Desktop",
        body: n.message,
      });
    },
  });

  const terminal = new TerminalHost(
    (event) => {
      const { ownerWebContentsId, ...payload } = event;
      sendToRendererOwner(ownerWebContentsId, IPC.terminalData, payload);
    },
    (event) => {
      const { ownerWebContentsId, ...payload } = event;
      sendToRendererOwner(ownerWebContentsId, IPC.terminalExit, payload);
    },
  );
  terminalHost = terminal;

  const autoUpdater = new AppAutoUpdater({
    getWindow: getMainWindow,
    getFeedUrl: () =>
      process.env.CLAUDE_DESKTOP_UPDATE_URL?.trim() ||
      settings.get().updateFeedUrl ||
      undefined,
  });

  const roomArchive = new RoomArchive(userDataDir, database);
  const rooms = new RoomService({
    getWindow: getMainWindow,
    sendToAllWindows: (channel, payload) => {
      const roomId =
        payload && typeof payload === "object"
          ? (payload as { roomId?: unknown }).roomId
          : undefined;
      if (
        (channel === IPC.roomEvent || channel === IPC.roomPermAsk) &&
        typeof roomId === "string" &&
        roomId
      ) {
        sendToRoomRenderers(roomId, channel, payload);
        return;
      }
      sendToRenderer(channel, payload);
    },
    sessions,
    settings,
    archive: roomArchive,
    userDataDir,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    cpa: modelRuntime,
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

  const photoFlow = new PhotoFlowService({
    userDataDir,
    fetch: fetchPhotoFlow,
    validateImage: bytes => {
      const image = nativeImage.createFromBuffer(bytes);
      const size = image.getSize();
      return !image.isEmpty() && size.width <= 600 && size.height <= 600;
    },
    onChanged: () => sendToRenderer(IPC.photoFlowUpdated, null),
  });
  photoFlow.setEnabled(settings.get().photoFlowEnabled !== false);

  registerIpcHandlers({
    photoFlow,
    window: getMainWindow,
    sessions,
    permissions,
    userPrompts,
    settings,
    cpa: modelRuntime,
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
    onSettingsSynced: () => {
      sendToRenderer(IPC.settingsUpdated, settings.getPublic());
    },
  });

  // 注册 Provider IPC 处理器
  registerProviderHandlers({
    providerManager,
    credentials: providerCredentials,
    quotaManager,
    oauthHandler,
    runtime: modelRuntime,
    sendToRenderer,
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
  // Hot updates replace app binaries only; account data stays in AppData.
  autoUpdater.start();
  void modelRuntime.ensureReady().then(() => modelRuntime.listModelCatalog()).catch(() => undefined);

  // 启动后台配额同步（1 小时一次）
  // 只同步「已配置凭证」的 provider，并在拿到模型目录后把状态推给渲染进程。
  // 不再做 usedQuota/limitTokens 的 80% 告警：这些上游没有通用的用量接口，
  // 模型目录和窗口不是计费额度，拿不到真实用量时不编造数值。
  const quotaSyncInterval = setInterval(async () => {
    for (const config of providerManager.listConfigs()) {
      if (!config.enabled) continue;

      try {
        const result = await modelRuntime.syncProvider(config.id);
        if (result.error) {
          console.warn(`[Provider] Quota sync failed for ${config.id}: ${result.error}`);
          continue;
        }
        sendToRenderer(IPC.providerUpdated, {
          providerId: config.id,
          status: await modelRuntime.providerStatus(config.id),
        });
      } catch (err) {
        console.warn(`[Provider] Quota sync failed for ${config.id}:`, err);
      }
    }
  }, 3600000); // 1 小时

  app.on("before-quit", () => {
    isQuitting = true;
    photoFlow.dispose();
    oauthHandler.cancelAll();
    clearInterval(quotaSyncInterval);
    stopClaudeSettingsWatch();
    modelRuntime.stopIfManaged();
    providerUsage?.close();
    rooms.disposeAll();
    terminal.killAll();
    // Flush delayed archives and close visible + hidden SDK sessions.
    sessions.disposeAll();
    roomArchive.close();
  });
}

if (!hasSingleInstanceLock) {
  // Closing the window normally hides to tray, so launching the app again can
  // otherwise create a second Chromium profile owner. Competing instances
  // race on Cache/GPUCache and Windows reports access denied (0x5).
  isQuitting = true;
  app.quit();
} else {
  app.on("second-instance", () => {
    // If bootstrap is still running the primary window will be shown normally.
    if (mainWindow && !mainWindow.isDestroyed()) showMainWindow();
  });

  app.whenReady().then(bootstrap);

  app.on("window-all-closed", () => {
    // Tray keeps the process alive so the main window can be restored.
    if (tray && !tray.isDestroyed()) return;
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    showMainWindow();
  });
}
