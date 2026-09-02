import fs from "node:fs";
import path from "node:path";
import { app, type BrowserWindow } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { IPC } from "@claude-desktop/shared";
import {
  NO_UPDATE_FEED_MESSAGE,
  resolveUpdateSource,
} from "./auto-updater-source";

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
  /** Optional generic feed base URL (ends with /). Empty = packaged yml or disabled. */
  getFeedUrl?: () => string | undefined;
};

/**
 * Hot updates via electron-updater.
 * - Never touches AppData / CPA config / settings — only replaces app binaries.
 * - Disabled in dev (unpackaged).
 * - Feed URL: CLAUDE_DESKTOP_UPDATE_URL env, or settings updateFeedUrl,
 *   else packaged app-update.yml. If none of those exist, stay disabled
 *   instead of throwing ENOENT on the missing yml.
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
      const message = err instanceof Error ? err.message : String(err);
      // Missing packaged yml is "no feed configured", not a hard failure.
      if (/ENOENT/i.test(message) && /app-update\.yml/i.test(message)) {
        this.setStatus({ state: "disabled", message: NO_UPDATE_FEED_MESSAGE });
        return;
      }
      this.setStatus({ state: "error", message });
    });

    if (this.applyFeedUrl() === "disabled") {
      this.setStatus({ state: "disabled", message: NO_UPDATE_FEED_MESSAGE });
      return;
    }
    // Quiet startup check after a short delay so UI is ready.
    setTimeout(() => {
      void this.check().catch(() => undefined);
    }, 8_000);
  }

  private packagedYmlPath(): string {
    const resources =
      typeof process !== "undefined" ? process.resourcesPath ?? "" : "";
    return path.join(resources, "app-update.yml");
  }

  /**
   * Configure electron-updater, or report that updates are disabled.
   * Must not call checkForUpdates() when this returns "disabled" — that
   * is what produced ENOENT on resources/app-update.yml.
   */
  private applyFeedUrl(): "feed" | "packaged-yml" | "disabled" {
    const source = resolveUpdateSource({
      envUrl: process.env.CLAUDE_DESKTOP_UPDATE_URL,
      settingsUrl: this.host.getFeedUrl?.(),
      packagedYmlExists: fs.existsSync(this.packagedYmlPath()),
    });
    if (source.kind === "feed") {
      autoUpdater.setFeedURL({ provider: "generic", url: source.url });
      return "feed";
    }
    if (source.kind === "packaged-yml") return "packaged-yml";
    return "disabled";
  }

  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.setStatus({
        state: "disabled",
        message: "开发模式不检查更新（仅安装包可用）",
      });
      return this.status;
    }
    if (this.applyFeedUrl() === "disabled") {
      this.setStatus({ state: "disabled", message: NO_UPDATE_FEED_MESSAGE });
      return this.status;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT/i.test(message) && /app-update\.yml/i.test(message)) {
        this.setStatus({ state: "disabled", message: NO_UPDATE_FEED_MESSAGE });
      } else {
        this.setStatus({ state: "error", message });
      }
    }
    return this.status;
  }

  async download(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      return this.getStatus();
    }
    if (this.applyFeedUrl() === "disabled") {
      this.setStatus({ state: "disabled", message: NO_UPDATE_FEED_MESSAGE });
      return this.status;
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
    // Install in the background, then relaunch the updated app. The normal
    // before-quit path stops managed CPA first; bootstrap starts it again.
    autoUpdater.quitAndInstall(true, true);
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
