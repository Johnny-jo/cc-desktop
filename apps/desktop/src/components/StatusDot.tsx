import React from "react";
import type { CpaStatus } from "@claude-desktop/shared";

const COLOR: Record<CpaStatus["state"], string> = {
  unknown: "#6b7280",
  stopped: "#6b7280",
  starting: "#eab308",
  ready: "#22c55e",
  error: "#ef4444",
};

export function StatusDot({ status }: { status: CpaStatus }) {
  const color = COLOR[status.state] ?? COLOR.unknown;
  const title =
    status.state === "ready"
      ? `CPA ready :${status.port}${status.managedByApp ? " (managed)" : ""}`
      : status.state === "error"
        ? `CPA error: ${status.message}`
        : `CPA ${status.state}`;

  return (
    <span className="status-dot-wrap" title={title}>
      <span className="status-dot" style={{ background: color }} />
      <span className="status-dot-label">CPA {status.state}</span>
    </span>
  );
}
