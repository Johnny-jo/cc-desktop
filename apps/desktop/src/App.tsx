import React, { useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { bootstrapStore, useAppStore } from "./state/store";

function ChangesPlaceholder() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const changesBySession = useAppStore((s) => s.changesBySession);
  const changes = activeSessionId
    ? (changesBySession[activeSessionId] ?? [])
    : [];

  return (
    <div className="changes-placeholder">
      <div className="panel-title">Changes</div>
      {changes.length === 0 ? (
        <p className="muted">No file changes yet (task 12 adds DiffView).</p>
      ) : (
        <ul className="changes-list">
          {changes.map((c) => (
            <li key={c.path}>
              <span className={`change-status status-${c.status}`}>
                {c.status}
              </span>{" "}
              {c.path}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function App() {
  useEffect(() => {
    void bootstrapStore();
  }, []);

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <div className="panel panel-sessions">
          <SessionList />
        </div>
        <div className="panel panel-chat">
          <ChatPanel />
        </div>
        <div className="panel panel-changes">
          <ChangesPlaceholder />
        </div>
      </div>
    </div>
  );
}
