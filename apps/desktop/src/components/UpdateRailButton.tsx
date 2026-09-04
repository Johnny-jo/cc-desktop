import React, { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateStatusDto } from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";

const DOWNLOAD_PENDING_KEY = "cc-desktop:update-download-pending";

function IconDownload() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M10 3.2v8.4m0 0 3.1-3.1M10 11.6 6.9 8.5M4 14.2v1.1c0 .8.7 1.5 1.5 1.5h9c.8 0 1.5-.7 1.5-1.5v-1.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function rememberPendingDownload(pending: boolean): void {
  try {
    if (pending) {
      window.localStorage.setItem(DOWNLOAD_PENDING_KEY, "1");
    } else {
      window.localStorage.removeItem(DOWNLOAD_PENDING_KEY);
    }
  } catch {
    // The updater still works if localStorage is unavailable; only auto-resume is lost.
  }
}

function hasPendingDownload(): boolean {
  try {
    return window.localStorage.getItem(DOWNLOAD_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

/** Compact updater entry shown immediately above the theme button. */
export function UpdateRailButton() {
  const [status, setStatus] = useState<UpdateStatusDto | null>(null);
  const [retryDownload, setRetryDownload] = useState(false);
  const actionInFlight = useRef(false);
  const downloadWasActive = useRef(hasPendingDownload());

  const applyStatus = useCallback((next: UpdateStatusDto) => {
    setStatus(next);
    if (next.state === "downloading") {
      downloadWasActive.current = true;
      rememberPendingDownload(true);
    } else if (next.state === "downloaded" || next.state === "not-available") {
      downloadWasActive.current = false;
      setRetryDownload(false);
      rememberPendingDownload(false);
    } else if (next.state === "error" && downloadWasActive.current) {
      setRetryDownload(true);
      rememberPendingDownload(false);
    }
  }, []);

  const download = useCallback(async () => {
    if (actionInFlight.current || !hasDesktopApi("downloadUpdate")) return;
    actionInFlight.current = true;
    downloadWasActive.current = true;
    setRetryDownload(false);
    rememberPendingDownload(true);
    try {
      applyStatus(await getDesktop().downloadUpdate());
    } catch (error) {
      applyStatus({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      actionInFlight.current = false;
    }
  }, [applyStatus]);

  const retry = useCallback(async () => {
    if (actionInFlight.current || !hasDesktopApi("checkForUpdate")) return;
    actionInFlight.current = true;
    setRetryDownload(false);
    try {
      const checked = await getDesktop().checkForUpdate();
      applyStatus(checked);
      if (checked.state === "available") {
        actionInFlight.current = false;
        await download();
        return;
      }
    } catch (error) {
      applyStatus({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      actionInFlight.current = false;
    }
  }, [applyStatus, download]);

  useEffect(() => {
    if (!hasDesktopApi("getUpdateStatus")) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    const onStatus = (next: UpdateStatusDto) => {
      if (disposed) return;
      applyStatus(next);
      // If the user quit during a download, resume from electron-updater's
      // validated cache (or safely restart the differential download).
      if (next.state === "available" && hasPendingDownload()) {
        void download();
      }
    };

    void getDesktop()
      .getUpdateStatus()
      .then(onStatus)
      .catch(() => undefined);
    try {
      unsubscribe = getDesktop().on("app:update-status", (...args: unknown[]) => {
        onStatus(args[0] as UpdateStatusDto);
      });
    } catch {
      // A stale preload simply leaves the update entry hidden.
    }

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [applyStatus, download]);

  if (!status) return null;

  if (status.state === "available") {
    return (
      <button
        type="button"
        className="side-rail-btn side-rail-update"
        title={`下载更新 v${status.version}`}
        aria-label={`下载更新 v${status.version}`}
        onClick={() => void download()}
      >
        <IconDownload />
      </button>
    );
  }

  if (status.state === "downloading") {
    const percent = Math.max(0, Math.min(100, Math.round(status.percent)));
    return (
      <button
        type="button"
        className="side-rail-btn side-rail-update is-downloading"
        title={`正在下载更新 ${percent}%`}
        aria-label={`正在下载更新 ${percent}%`}
        aria-busy="true"
        disabled
      >
        <span className="side-rail-update-progress">{percent}%</span>
      </button>
    );
  }

  if (status.state === "downloaded") {
    return (
      <button
        type="button"
        className="side-rail-btn side-rail-update is-ready"
        title={`重启并更新至 v${status.version}`}
        aria-label={`重启并更新至 v${status.version}`}
        onClick={() => void getDesktop().installUpdate()}
      >
        <span className="side-rail-update-label">更新</span>
      </button>
    );
  }

  if (status.state === "error" && retryDownload) {
    return (
      <button
        type="button"
        className="side-rail-btn side-rail-update is-error"
        title={`更新下载失败，点击重试：${status.message}`}
        aria-label="更新下载失败，点击重试"
        onClick={() => void retry()}
      >
        <IconDownload />
      </button>
    );
  }

  return null;
}
