import React, { useMemo, useState } from "react";
import type { FileChangeEvent } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import { useAppStore } from "../state/store";
import { DiffView } from "./DiffView";

/** One row in the panel: a single write operation on a file. */
type OpRow = {
  eventId: string;
  path: string;
  status: "A" | "M";
  event: FileChangeEvent;
};

function formatTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function ChangesPanel() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const changesBySession = useAppStore((s) => s.changesBySession);
  const changes = activeSessionId
    ? (changesBySession[activeSessionId] ?? [])
    : [];

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Flatten per-file changes into per-operation rows, newest first.
  const rows = useMemo<OpRow[]>(() => {
    const out: OpRow[] = [];
    for (const c of changes) {
      for (const e of c.events) {
        out.push({ eventId: e.id, path: c.path, status: c.status, event: e });
      }
    }
    return out.sort((a, b) => b.event.at - a.event.at);
  }, [changes]);

  const selected = rows.find((r) => r.eventId === selectedEventId) ?? rows[0];
  const restorable = rows.filter((r) => r.event.canRestore);

  async function restoreOp(row: OpRow) {
    if (!activeSessionId) return;
    setBusy(row.eventId);
    setNote(null);
    try {
      const res = await getDesktop().restoreChange(
        activeSessionId,
        row.path,
        row.eventId,
      );
      if (!res.ok) {
        setNote(`Restore failed: ${res.error ?? "unknown"}`);
      } else {
        setNote(`Restored ${row.path} to before this edit`);
        if (selectedEventId === row.eventId) setSelectedEventId(null);
      }
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
        setSelectedEventId(null);
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
      {rows.length === 0 ? (
        <p className="muted">No file changes yet.</p>
      ) : (
        <>
          <ul className="changes-list">
            {rows.map((r) => (
              <li key={r.eventId} className="change-item-row">
                <button
                  type="button"
                  className={
                    selected?.eventId === r.eventId
                      ? "change-item active"
                      : "change-item"
                  }
                  onClick={() => setSelectedEventId(r.eventId)}
                >
                  <span className={`change-status status-${r.status}`}>
                    {r.status}
                  </span>
                  <span className="change-path" title={r.path}>
                    {r.path}
                  </span>
                  <span className="change-op-meta">
                    {r.event.tool} · {formatTime(r.event.at)}
                  </span>
                </button>
                {r.event.canRestore ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm change-restore"
                    disabled={busy !== null}
                    title="Roll back to before this edit (also undoes later edits of this file)"
                    onClick={() => void restoreOp(r)}
                  >
                    {busy === r.eventId ? "…" : "↩"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {selected ? (
            <DiffView
              change={{
                path: selected.path,
                status: selected.status,
                hunks: selected.event.hunk,
                updatedAt: selected.event.at,
                events: [selected.event],
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
