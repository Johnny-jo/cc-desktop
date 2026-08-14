import React, { useEffect, useState } from "react";
import type { UpdateStatusDto } from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";

/**
 * Non-blocking hot-update bar. Appears when a new version is available /
 * downloaded. Never touches CPA/settings — only app binaries via electron-updater.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatusDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hasDesktopApi("getUpdateStatus")) return;
    let unsub: (() => void) | undefined;
    void getDesktop()
      .getUpdateStatus()
      .then((s) => setStatus(s))
      .catch(() => undefined);
    try {
      unsub = getDesktop().on("app:update-status", (...args: unknown[]) => {
        setStatus(args[0] as UpdateStatusDto);
      });
    } catch {
      // ignore
    }
    return () => unsub?.();
  }, []);

  if (!status) return null;
  if (
    status.state === "idle" ||
    status.state === "checking" ||
    status.state === "not-available" ||
    status.state === "disabled"
  ) {
    return null;
  }

  const onDownload = async () => {
    setBusy(true);
    try {
      const s = await getDesktop().downloadUpdate();
      setStatus(s);
    } finally {
      setBusy(false);
    }
  };

  const onInstall = async () => {
    setBusy(true);
    try {
      await getDesktop().installUpdate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="update-banner" role="status">
      {status.state === "available" ? (
        <>
          <span>
            发现新版本 <strong>v{status.version}</strong>
            （热更新，不会覆盖 CPA / 设置）
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void onDownload()}
          >
            {busy ? "下载中…" : "下载更新"}
          </button>
        </>
      ) : null}
      {status.state === "downloading" ? (
        <span>
          正在下载更新… {Math.round(status.percent)}%
        </span>
      ) : null}
      {status.state === "downloaded" ? (
        <>
          <span>
            新版本 <strong>v{status.version}</strong> 已就绪
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void onInstall()}
          >
            重启并安装
          </button>
        </>
      ) : null}
      {status.state === "error" ? (
        <span className="update-banner-err">更新失败：{status.message}</span>
      ) : null}
    </div>
  );
}
