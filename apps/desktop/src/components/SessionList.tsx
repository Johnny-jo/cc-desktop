import React from "react";
import {
  newChat,
  openProject,
  selectSession,
  startCpa,
  useAppStore,
} from "../state/store";
import { StatusDot } from "./StatusDot";

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export type SessionListProps = {
  onOpenSettings: () => void;
};

export function SessionList({ onOpenSettings }: SessionListProps) {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const projectPath = useAppStore((s) => s.projectPath);
  const cpaStatus = useAppStore((s) => s.cpaStatus);

  const onBrowse = async () => {
    try {
      await openProject();
    } catch {
      // lastError in store
    }
  };

  const projectLabel = projectPath
    ? projectPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
      projectPath
    : "No project";

  return (
    <div className="session-list">
      <div className="sidebar-brand">
        <span className="brand-mark">Claude</span>
        <span className="brand-sub">Desktop</span>
      </div>

      <button
        type="button"
        className="sidebar-new"
        onClick={() => newChat()}
      >
        <span className="sidebar-new-icon">+</span>
        New chat
      </button>

      <div className="sidebar-section-label">Recent</div>

      <ul className="session-list-ul">
        {sessions.length === 0 ? (
          <li className="session-empty">No sessions yet</li>
        ) : (
          sessions.map((s) => {
            const folder =
              s.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
              "";
            return (
            <li key={s.id} className="session-list-item">
              <button
                type="button"
                className={
                  s.id === activeSessionId
                    ? "session-item active"
                    : "session-item"
                }
                onClick={() => void selectSession(s.id)}
                title={`${s.title}${s.cwd ? `\n${s.cwd}` : ""}`}
              >
                <span className="session-title">{s.title}</span>
                <span className="session-meta">
                  {folder ? (
                    <span className="session-folder" title={s.cwd}>
                      {folder}
                    </span>
                  ) : null}
                  <span className={`session-status status-${s.status}`}>
                    {s.status === "running" ? "● running" : formatTime(s.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
            );
          })
        )}
      </ul>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-footer-row"
          onClick={() => void onBrowse()}
          title={projectPath ?? "Open project folder"}
        >
          <span className="sidebar-footer-icon">📁</span>
          <span className="sidebar-footer-text">{projectLabel}</span>
        </button>
        <button
          type="button"
          className="sidebar-footer-row"
          onClick={() => void startCpa()}
          title="Start / ensure CPA"
        >
          <StatusDot status={cpaStatus} compact />
        </button>
        <button
          type="button"
          className="sidebar-footer-row"
          onClick={onOpenSettings}
        >
          <span className="sidebar-footer-icon">⚙</span>
          <span className="sidebar-footer-text">Settings</span>
        </button>
      </div>
    </div>
  );
}
