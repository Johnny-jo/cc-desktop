import { app, type BrowserWindow } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { IPC } from "@claude-desktop/shared";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string | null }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; transferred: number; total: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string }
  | { state: "disabled"; message: string };

export type AutoUpdaterHost = {
  getWindow: () => BrowserWindow | null;
  /** Optional generic feed base URL (ends with /). Empty = use packaged app-update.yml. */
  getFeedUrl?: () => string | undefined;
};

/**
 * Hot updates via electron-updater.
 * - Never touches AppData / CPA config / settings — only replaces app binaries.
 * - Disabled in dev (unpackaged).
 * - Feed URL: CLAUDE_DESKTOP_UPDATE_URL env, or settings updateFeedUrl, else app-update.yml.
 */
export class AppAutoUpdater {
  private readonly host: AutoUpdaterHost;
  private status: UpdateStatus = { state: "idle" };
  private wired = false;

  constructor(host: AutoUpdaterHost) {
    this.host = host;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  /** Call once after app ready + window exists. */
  start(): void {
    if (this.wired) return;
    this.wired = true;

    if (!app.isPackaged) {
      this.setStatus({
        state: "disabled",
        message: "开发模式不检查更新（仅安装包可用）",
      });
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // Unsigned Windows builds: skip signature verification so self-hosted feeds work.
    autoUpdater.forceDevUpdateConfig = false;
    try {
      // electron-updater exposes this on Windows for unsigned apps
      (autoUpdater as unknown as { disableDifferentialDownload?: boolean })
        .disableDifferentialDownload = true;
    } catch {
      // ignore
    }

    autoUpdater.on("checking-for-update", () => {
      this.setStatus({ state: "checking" });
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.setStatus({
        state: "available",
        version: info.version,
        releaseNotes:
          typeof info.releaseNotes === "string"
            ? info.releaseNotes
            : Array.isArray(info.releaseNotes)
              ? info.releaseNotes.map((n) => n.note ?? "").join("\n")
              : null,
      });
    });
    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      this.setStatus({ state: "not-available", version: info.version });
    });
    autoUpdater.on("download-progress", (p) => {
      this.setStatus({
        state: "downloading",
        percent: p.percent,
        transferred: p.transferred,
        total: p.total,
      });
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.setStatus({ state: "downloaded", version: info.version });
    });
    autoUpdater.on("error", (err) => {
      this.setStatus({
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    });

    this.applyFeedUrl();
    // Quiet startup check after a short delay so UI is ready.
    setTimeout(() => {
      void this.check().catch(() => undefined);
    }, 8_000);
  }

  private applyFeedUrl(): void {
    const fromEnv = process.env.CLAUDE_DESKTOP_UPDATE_URL?.trim();
    const fromSettings = this.host.getFeedUrl?.()?.trim();
    // No hardcoded public feed. Pack-time env or Settings only.
    const url = fromEnv || fromSettings || "";
    if (url) {
      const base = url.endsWith("/") ? url : `${url}/`;
      autoUpdater.setFeedURL({ provider: "generic", url: base });
    }
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.setStatus({
        state: "disabled",
        message: "开发模式不检查更新（仅安装包可用）",
      });
      return this.status;
    }
    this.applyFeedUrl();
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      this.setStatus({
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return this.status;
  }

  async download(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      return this.getStatus();
    }
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.setStatus({
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return this.status;
  }

  /** Quit and install the downloaded update. */
  quitAndInstall(): void {
    if (!app.isPackaged) return;
    // isSilent=false, isForceRunAfter=true
    autoUpdater.quitAndInstall(false, true);
  }

  private setStatus(next: UpdateStatus): void {
    this.status = next;
    const win = this.host.getWindow();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send(IPC.appUpdateStatus, next);
    } catch {
      // Renderer gone (reload/HMR) — ignore.
    }
  }
}
