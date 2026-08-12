import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  Notification,
  safeStorage,
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
  repairCpaManagementConfig,
  resolveEffectiveCpaPaths,
  writeCpaConfigWithApiKey,
  type RuntimePathEnv,
} from "./runtime-paths";
import { userSkillsDir } from "./skill-store";
import { TerminalHost } from "./terminal-host";

/** Match the renderer charcoal theme (`--bg-app`). */
const APP_BG = "#141414";
/** Light theme chrome (`--bg-app` for light). */
const APP_BG_LIGHT = "#f7f7f8";
const TITLE_SYMBOL_DARK = "#e8e8e8";
const TITLE_SYMBOL_LIGHT = "#1c1c1e";

let mainWindow: BrowserWindow | null = null;

/** Sync frameless window chrome (titleBarOverlay) with the UI theme. */
function applyWindowTheme(theme: "dark" | "light"): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
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

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function sendToRenderer(channel: string, payload: unknown): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
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

function createWindow() {
  // Dark chrome to match the in-app charcoal UI (title bar / window frame).
  nativeTheme.themeSource = "dark";

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: APP_BG,
    // No File/Edit/View menu bar — this is a desktop chat app, not an editor.
    autoHideMenuBar: true,
    // Hide OS title (icon + "Claude Desktop"); keep only dark min/max/close.
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

  // Fully remove the default application menu (File / Edit / View / …).
  Menu.setApplicationMenu(null);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
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
  // GET / still works. Repair in place when we control the userData config.
  repairCpaManagementConfig(cpaPaths.cpaConfigPath, {
    apiKey: settings.getToken(),
    port: current.cpaPort,
  });
  // Token exists but the wizard never ran (pre-onboarding install): do one
  // full config rewrite so api-keys + secret-key + panel are guaranteed,
  // then mark setup complete.
  if (settings.getToken() && !settings.get().setupCompleted) {
    writeCpaConfigWithApiKey(pathEnv, {
      port: settings.get().cpaPort || 8317,
      apiKey: settings.getToken()!,
    });
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
      const title = n.title || "Claude Desktop";
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
  });

  createWindow();

  app.on("before-quit", () => {
    // stopIfManaged is a no-op unless this app spawned CPA.
    // Always call it so managed children are not orphaned on quit.
    cpa.stopIfManaged();
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
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
