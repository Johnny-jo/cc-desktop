import React from "react";
import { newChat, selectSession, useAppStore } from "../state/store";

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

export function SessionList() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);

  return (
    <div className="session-list">
      <div className="session-list-header">
        <span>Sessions</span>
        <button type="button" className="btn btn-sm" onClick={() => newChat()}>
          New
        </button>
      </div>
      <ul className="session-list-ul">
        {sessions.length === 0 ? (
          <li className="session-empty">No sessions yet</li>
        ) : (
          sessions.map((s) => (
            <li key={s.id} className="session-list-item">
              <button
                type="button"
                className={
                  s.id === activeSessionId
                    ? "session-item active"
                    : "session-item"
                }
                onClick={() => void selectSession(s.id)}
                title={s.title}
              >
                <span className="session-title">{s.title}</span>
                <span className="session-meta">
                  <span className={`session-status status-${s.status}`}>
                    {s.status}
                  </span>
                  <span className="session-time">{formatTime(s.updatedAt)}</span>
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
