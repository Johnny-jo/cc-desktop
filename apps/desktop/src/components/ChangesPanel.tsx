import React, { useState } from "react";
import type { FileChange } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import { useAppStore } from "../state/store";
import { DiffView } from "./DiffView";

export function ChangesPanel() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const changesBySession = useAppStore((s) => s.changesBySession);
  const changes = activeSessionId
    ? (changesBySession[activeSessionId] ?? [])
    : [];

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const selected = changes.find((c) => c.path === selectedPath) ?? changes[0];
  const restorable = changes.filter((c) => c.canRestore);

  async function restoreOne(path: string) {
    if (!activeSessionId) return;
    setBusy(path);
    setNote(null);
    try {
      const res = await getDesktop().restoreChange(activeSessionId, path);
      if (!res.ok) setNote(`Restore failed: ${res.error ?? "unknown"}`);
      else if (selectedPath === path) setSelectedPath(null);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function restoreAll() {
    if (!activeSessionId) return;
    setBusy("*");
    setNote(null);
    try {
      const res = await getDesktop().restoreAllChanges(activeSessionId);
      if (res.failed.length) {
        setNote(`Restored ${res.restored.length}; failed: ${res.failed.join(", ")}`);
      } else {
        setNote(`Restored ${res.restored.length} file(s)`);
        setSelectedPath(null);
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="changes-panel">
      <div className="panel-title changes-panel-title">
        <span>Changes</span>
        {restorable.length > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            title="Restore every changed file to its content before this session"
            onClick={() => void restoreAll()}
          >
            {busy === "*" ? "Restoring…" : "Restore all"}
          </button>
        ) : null}
      </div>
      {note ? <p className="muted changes-note">{note}</p> : null}
      {changes.length === 0 ? (
        <p className="muted">No file changes yet.</p>
      ) : (
        <>
          <ul className="changes-list">
            {changes.map((c) => (
              <li key={c.path} className="change-item-row">
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
                {c.canRestore ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm change-restore"
                    disabled={busy !== null}
                    title="Restore this file to its content before this session"
                    onClick={() => void restoreOne(c.path)}
                  >
                    {busy === c.path ? "…" : "↩"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {selected ? <DiffView change={selected} /> : null}
        </>
      )}
    </div>
  );
}
