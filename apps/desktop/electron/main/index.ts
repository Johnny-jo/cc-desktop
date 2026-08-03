import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, safeStorage } from "electron";
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
import { PermissionBroker } from "./permission-broker";
import { UserPromptBroker } from "./user-prompt-broker";
import { CpaSupervisor } from "./cpa-supervisor";
import { SessionArchive } from "./session-archive";
import { SessionManager, type QueryFn } from "./session-manager";
import { registerIpcHandlers } from "./ipc-handlers";

let mainWindow: BrowserWindow | null = null;

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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
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

  const archive = new SessionArchive(userDataDir);

  const diffs = new DiffTracker({
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
  });

  const permissions = new PermissionBroker({
    getMode: () => settings.get().permissionMode,
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
  });

  registerIpcHandlers({
    window: getMainWindow,
    sessions,
    permissions,
    userPrompts,
    settings,
    cpa,
    diffs,
  });

  createWindow();

  app.on("before-quit", () => {
    // stopIfManaged is a no-op unless this app spawned CPA.
    // Always call it so managed children are not orphaned on quit.
    cpa.stopIfManaged();
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
