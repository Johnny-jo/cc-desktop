import React from "react";
import type { CpaStatus } from "@claude-desktop/shared";

const COLOR: Record<CpaStatus["state"], string> = {
  unknown: "#6b7280",
  stopped: "#6b7280",
  starting: "#eab308",
  ready: "#22c55e",
  error: "#ef4444",
};

export function StatusDot({
  status,
  compact = false,
}: {
  status: CpaStatus;
  compact?: boolean;
}) {
  const color = COLOR[status.state] ?? COLOR.unknown;
  const title =
    status.state === "ready"
      ? "Provider 服务已就绪"
      : status.state === "error"
        ? `Provider 服务错误：${status.message}`
        : status.state === "starting" ? "Provider 服务启动中…" : "Provider 服务未启动";

  const label =
    status.state === "error"
      ? "Provider 服务错误"
      : status.state === "ready" ? "Provider 服务已就绪" : status.state === "starting" ? "Provider 服务启动中…" : "Provider 服务未启动";

  return (
    <span className="status-dot-wrap" title={title}>
      <span className="status-dot" style={{ background: color }} />
      <span className="status-dot-label">{label}</span>
    </span>
  );
}
