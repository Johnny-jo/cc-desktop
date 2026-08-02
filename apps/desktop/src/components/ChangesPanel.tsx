import React, { useState } from "react";
import type { FileChange } from "@claude-desktop/shared";
import { useAppStore } from "../state/store";
import { DiffView } from "./DiffView";

export function ChangesPanel() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const changesBySession = useAppStore((s) => s.changesBySession);
  const changes = activeSessionId
    ? (changesBySession[activeSessionId] ?? [])
    : [];

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = changes.find((c) => c.path === selectedPath) ?? changes[0];

  return (
    <div className="changes-panel">
      <div className="panel-title">Changes</div>
      {changes.length === 0 ? (
        <p className="muted">No file changes yet.</p>
      ) : (
        <>
          <ul className="changes-list">
            {changes.map((c) => (
              <li key={c.path}>
                <button
                  type="button"
                  className={
                    selected?.path === c.path
                      ? "change-item active"
                      : "change-item"
                  }
                  onClick={() => setSelectedPath(c.path)}
                >
                  <span className={`change-status status-${c.status}`}>
                    {c.status}
                  </span>
                  <span className="change-path" title={c.path}>
                    {c.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected ? <DiffView change={selected} /> : null}
        </>
      )}
    </div>
  );
}
