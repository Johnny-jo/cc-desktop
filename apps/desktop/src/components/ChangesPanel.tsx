import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FileChange, FileChangeEvent } from "@claude-desktop/shared";
import { extractLineRangeSummary } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import { clearRevealChange, useAppStore } from "../state/store";
import { useI18n } from "../i18n/useI18n";
import { DiffView } from "./DiffView";
import { resolvePath, toProjectRel } from "../lib/project-path";

/** basename for git-status matching (git reports repo-relative / paths) */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function fileName(p: string): string {
  const n = p.replace(/\\/g, "/").split("/").pop();
  return n || p;
}

/** One write operation on a file. */
type OpRow = {
  eventId: string;
  path: string;
  status: FileChange["status"];
  event: FileChangeEvent;
};

type FileGroup = {
  path: string;
  status: FileChange["status"];
  ops: OpRow[];
};

function formatTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function opLabel(event: FileChangeEvent): string {
  const range = extractLineRangeSummary(event.hunk);
  return range
    ? `${event.tool} · ${range} · ${formatTime(event.at)}`
    : `${event.tool} · ${formatTime(event.at)}`;
}

const FILE_PAGE = 20;
const OP_PAGE = 12;

export function ChangesPanel({
  onOpenFile,
}: {
  /** Open the file in the in-app editor column (tab). */
  onOpenFile?: (rel: string) => void;
}) {
  const { t } = useI18n();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const changesBySession = useAppStore((s) => s.changesBySession);
  const projectPath = useAppStore((s) => s.projectPath);
  const changes = activeSessionId
    ? (changesBySession[activeSessionId] ?? [])
    : [];

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [flashEventId, setFlashEventId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [git, setGit] = useState<{
    isRepo: boolean;
    branch?: string;
    changed?: string[];
  } | null>(null);
  const [fileLimit, setFileLimit] = useState(FILE_PAGE);
  const [opLimit, setOpLimit] = useState<Record<string, number>>({});
  const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set());
  // 列表 / 详情 上下分栏比例（%）
  const [listPct, setListPct] = useState(36);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const revealRequest = useAppStore((s) => s.revealChangeRequest);
  const flashRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    setFileLimit(FILE_PAGE);
    setOpLimit({});
    setOpenFiles(new Set());
    setSelectedEventId(null);
    setFileViewPath(null);
  }, [activeSessionId]);

  // Git overlay: branch + whether each changed file is also dirty in git.
  useEffect(() => {
    if (!projectPath) {
      setGit(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getDesktop()
        .gitStatus(projectPath)
        .then((res) => {
          if (!cancelled) setGit(res);
        })
        .catch(() => {
          if (!cancelled) setGit(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectPath, activeSessionId]);

  const gitDirty = useMemo(
    () => new Set((git?.changed ?? []).map(normPath)),
    [git],
  );

  const groups = useMemo<FileGroup[]>(() => {
    const byPath = new Map<string, FileGroup>();
    for (const c of changes) {
      const ops: OpRow[] = c.events
        .map((e) => ({
          eventId: e.id,
          path: c.path,
          status: c.status,
          event: e,
        }))
        .sort((a, b) => b.event.at - a.event.at);
      byPath.set(c.path, { path: c.path, status: c.status, ops });
    }
    return [...byPath.values()].sort((a, b) => {
      const atA = a.ops[0]?.event.at ?? 0;
      const atB = b.ops[0]?.event.at ?? 0;
      return atB - atA;
    });
  }, [changes]);

  const visibleGroups = groups.slice(0, fileLimit);
  const hiddenFiles = Math.max(0, groups.length - fileLimit);

  const allOps = useMemo(
    () => groups.flatMap((g) => g.ops),
    [groups],
  );
  // File-level view (aggregate of all ops) when the file row itself was
  // clicked last; single-op view when an op row was clicked.
  const [fileViewPath, setFileViewPath] = useState<string | null>(null);
  const selected =
    allOps.find((r) => r.eventId === selectedEventId) ??
    visibleGroups[0]?.ops[0];
  const fileView: FileChange | null = useMemo(() => {
    if (!fileViewPath) return null;
    const c = changes.find((x) => x.path === fileViewPath);
    return c ?? null;
  }, [changes, fileViewPath]);
  const restorable = allOps.filter((r) => r.event.canRestore);

  // Chat tool card → reveal the matching change record here.
  useEffect(() => {
    if (!revealRequest || revealRequest.sessionId !== activeSessionId) return;
    const byTool = revealRequest.toolUseId
      ? allOps.find((r) => r.event.toolUseId === revealRequest.toolUseId)
      : undefined;
    const normReq = revealRequest.path
      ? normPath(revealRequest.path)
      : null;
    const byPath = normReq
      ? allOps.find((r) => normPath(r.path) === normReq)
      : undefined;
    const hit = byTool ?? byPath;
    if (hit) {
      setOpenFiles((prev) => {
        if (prev.has(hit.path)) return prev;
        const next = new Set(prev);
        next.add(hit.path);
        return next;
      });
      setSelectedEventId(hit.eventId);
      setFileViewPath(null);
      setFlashEventId(hit.eventId);
    }
    clearRevealChange();
    // allOps changes on every diff push; only re-run for new requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest, activeSessionId]);

  // Scroll the flashed row into view + clear the flash after the animation.
  useEffect(() => {
    if (!flashEventId) return;
    flashRef.current?.scrollIntoView({ block: "nearest" });
    const timer = window.setTimeout(() => setFlashEventId(null), 2200);
    return () => window.clearTimeout(timer);
  }, [flashEventId]);

  const toggleFile = (path: string) => {
    setOpenFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    // Clicking a file row shows the file's total changes (all ops merged).
    setFileViewPath(path);
  };

  /** Read current full file text for DiffView's 全文 mode. */
  const loadFullText = async (path: string): Promise<string | null> => {
    if (!projectPath) return null;
    try {
      const rel = toProjectRel(projectPath, path) ?? path;
      const res = await getDesktop().readProjectFile(
        projectPath,
        rel,
        512 * 1024,
        "utf-8",
      );
      return res.ok ? (res.content ?? "") : null;
    } catch {
      return null;
    }
  };

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

  /** 列表 / 详情分栏竖向拖拽（上下拉伸详情区）。 */
  const onVSplitDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const host = mainRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const pointerId = e.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // ignore
    }
    document.body.classList.add("is-resizing-row");
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      const pct = ((ev.clientY - rect.top) / (rect.height || 1)) * 100;
      setListPct(Math.min(85, Math.max(12, pct)));
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
      document.body.classList.remove("is-resizing-row");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div className="changes-panel">
      <div className="panel-title changes-panel-title">
        <span>
          {t.changes.title}
          {git?.isRepo && git.branch ? (
            <span className="changes-git-branch" title="git branch">
              {" "}
              ⎇ {git.branch}
            </span>
          ) : null}
        </span>
        {restorable.length > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            title="Restore every changed file to its content before this session"
            onClick={() => void restoreAll()}
          >
            {busy === "*" ? "Restoring…" : t.changes.restoreAll}
          </button>
        ) : null}
      </div>
      {note ? <p className="muted changes-note">{note}</p> : null}
      {groups.length === 0 ? (
        <p className="muted">No file changes yet.</p>
      ) : (
        <div className="changes-main" ref={mainRef}>
          <ul
            className="changes-list"
            style={fileView || selected ? { maxHeight: `${listPct}%` } : undefined}
          >
            {visibleGroups.map((g) => {
              const open = openFiles.has(g.path);
              const shown = opLimit[g.path] ?? OP_PAGE;
              const ops = g.ops.slice(0, shown);
              const moreOps = Math.max(0, g.ops.length - shown);
              return (
                <li key={g.path} className="change-file">
                  <div className="change-file-row">
                    <button
                      type="button"
                      className={`change-file-toggle${open ? " open" : ""}`}
                      onClick={() => toggleFile(g.path)}
                      aria-expanded={open}
                      title={g.path}
                    >
                      <span className="change-file-chevron" aria-hidden>
                        {open ? "▾" : "▸"}
                      </span>
                      <span className={`change-status status-${g.status}`}>
                        {g.status}
                      </span>
                      <span className="change-file-name">
                        {fileName(g.path)}
                      </span>
                      {g.status === "D" ? (
                        <span className="change-deleted-tag">
                          {t.changes.deleted}
                        </span>
                      ) : null}
                      {gitDirty.has(normPath(g.path)) ? (
                        <span
                          className="change-git-dot"
                          title="Dirty in git working tree"
                        />
                      ) : null}
                      <span className="change-file-count">
                        {g.ops.length} {t.changes.showMore === "Show more" ? "ops" : "次"}
                      </span>
                    </button>
                    {g.status !== "D" ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm change-open"
                        title="在编辑栏打开"
                        onClick={() => {
                          const rel = toProjectRel(projectPath, g.path);
                          if (rel && onOpenFile) {
                            onOpenFile(rel);
                            return;
                          }
                          // 项目外路径兜底：外部编辑器
                          void getDesktop()
                            .openInEditor(resolvePath(projectPath, g.path))
                            .then((res) => {
                              if (!res.ok) setNote(res.error ?? "Open failed");
                            })
                            .catch(() => undefined);
                        }}
                      >
                        ↗
                      </button>
                    ) : null}
                  </div>
                  {open ? (
                    <ul className="change-ops">
                      {ops.map((r) => (
                        <li
                          key={r.eventId}
                          className="change-item-row"
                          ref={flashEventId === r.eventId ? flashRef : undefined}
                        >
                          <button
                            type="button"
                            className={
                              (selected?.eventId === r.eventId
                                ? "change-item active"
                                : "change-item") +
                              (flashEventId === r.eventId ? " flash" : "")
                            }
                            onClick={() => {
                              setFileViewPath(null);
                              setSelectedEventId(r.eventId);
                            }}
                            title={opLabel(r.event)}
                          >
                            <span className="change-op-meta">
                              {opLabel(r.event)}
                            </span>
                          </button>
                          {r.event.canRestore && g.status !== "D" ? (
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
                      {moreOps > 0 ? (
                        <li>
                          <button
                            type="button"
                            className="changes-more"
                            onClick={() =>
                              setOpLimit((prev) => ({
                                ...prev,
                                [g.path]: shown + OP_PAGE,
                              }))
                            }
                          >
                            {t.changes.showMore} {Math.min(OP_PAGE, moreOps)}{" "}
                            {t.changes.showMore === "Show more" ? "earlier" : "次（还有"} {moreOps}
                            {t.changes.showMore === "Show more" ? "" : "）"}
                          </button>
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </li>
              );
            })}
            {hiddenFiles > 0 ? (
              <li>
                <button
                  type="button"
                  className="changes-more"
                  onClick={() => setFileLimit((n) => n + FILE_PAGE)}
                >
                  {t.changes.showMore}{t.changes.showMore === "Show more" ? " files" : "文件"}（还有 {hiddenFiles}）
                </button>
              </li>
            ) : null}
          </ul>
          {fileView || selected ? (
            <div
              className="changes-vsplit"
              role="separator"
              aria-orientation="horizontal"
              onPointerDown={onVSplitDown}
            />
          ) : null}
          {fileView ? (
            <DiffView
              change={fileView}
              loadFullText={
                fileView.status === "D"
                  ? undefined
                  : () => loadFullText(fileView.path)
              }
            />
          ) : selected ? (
            <DiffView
              change={{
                path: selected.path,
                status: selected.status,
                hunks: selected.event.hunk,
                updatedAt: selected.event.at,
                events: [selected.event],
              }}
              loadFullText={
                selected.status === "D"
                  ? undefined
                  : () => loadFullText(selected.path)
              }
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
