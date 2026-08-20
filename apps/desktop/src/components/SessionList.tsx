import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionSummary } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import {
  deleteSession,
  newChat,
  renameSession,
  selectSession,
  startCpa,
  toggleSessionPinned,
  useAppStore,
} from "../state/store";
import { selectRoom } from "../state/room-store";
import { useI18n } from "../i18n/useI18n";
import { StatusDot } from "./StatusDot";
import { FileTree } from "./FileTree";
import { RoomSidebar } from "./RoomSidebar";

const SESSION_PAGE = 30;

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

/** One session row: hover ⋯ menu with pin / rename / delete. */
function SessionItem({
  s,
  active,
}: {
  s: SessionSummary;
  active: boolean;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(s.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rootRef = useRef<HTMLLIElement | null>(null);
  const renameCommittedRef = useRef(false);

  // ---- Browser-style drag-out: pull the row out of the sidebar to open the
  // chat in its own window. ----
  const DRAG_THRESHOLD = 6;
  const DRAG_SLACK = 6;
  const dragRef = useRef<{
    startX: number;
    startY: number;
    dragging: boolean;
    detach: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragGhost, setDragGhost] = useState<{
    x: number;
    y: number;
    detach: boolean;
  } | null>(null);

  const endDrag = useCallback(() => {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
    document.body.classList.remove("session-detaching");
    dragRef.current = null;
    setDragGhost(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDragMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.dragging) {
        const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        if (dist < DRAG_THRESHOLD) return;
        d.dragging = true;
        document.body.classList.add("session-detaching");
      }
      const sidebar = rootRef.current?.closest(".panel-sessions");
      const r = sidebar?.getBoundingClientRect();
      d.detach = r
        ? e.clientX < r.left - DRAG_SLACK ||
          e.clientX > r.right + DRAG_SLACK ||
          e.clientY < r.top - DRAG_SLACK ||
          e.clientY > r.bottom + DRAG_SLACK
        : false;
      setDragGhost({ x: e.clientX, y: e.clientY, detach: d.detach });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onDragEnd = useCallback(() => {
    const d = dragRef.current;
    if (d?.dragging) {
      suppressClickRef.current = true;
      if (d.detach) {
        void getDesktop()
          .openSessionWindow(s.id)
          .catch(() => undefined);
      }
    }
    endDrag();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id, endDrag]);

  const onItemPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      detach: false,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
  };

  // Unmount mid-drag: drop listeners so they never leak.
  useEffect(() => endDrag, [endDrag]);

  // Close the ⋯ menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        rootRef.current &&
        e.target instanceof Node &&
        !rootRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Delete confirm modal: Escape cancels.
  useEffect(() => {
    if (!confirmingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmingDelete(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmingDelete]);

  const commitRename = async () => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    const title = draft.trim();
    if (title && title !== s.title) {
      await renameSession(s.id, title);
    }
    setRenaming(false);
  };

  const folder =
    s.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";

  return (
    <li
      ref={rootRef}
      className={`session-list-item${s.pinned ? " pinned" : ""}`}
    >
      {renaming ? (
        <input
          className="session-rename-input"
          autoFocus
          value={draft}
          placeholder={t.sidebar.renamePlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") {
              renameCommittedRef.current = true;
              setRenaming(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={active ? "session-item active" : "session-item"}
          onPointerDown={onItemPointerDown}
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            selectRoom(null);
            void selectSession(s.id);
          }}
          title={`${s.title}${s.cwd ? `\n${s.cwd}` : ""}`}
        >
          <span className="session-title">
            {s.pinned ? (
              <svg
                className="session-pin-icon"
                width="11"
                height="11"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden
              >
                <path d="M9.5 1.5l5 5-1.8.4-2 2-.3 2.8-1.4 1.4-2.8-2.8-3.5 3.5-.8-.8 3.5-3.5L2.4 6.7l1.4-1.4 2.8-.3 2-2z" />
              </svg>
            ) : null}
            {s.title}
          </span>
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
      )}

      {!renaming ? (
        <button
          type="button"
          className="session-item-more"
          aria-label={t.sidebar.more}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <circle cx="3" cy="8" r="1.7" />
            <circle cx="8" cy="8" r="1.7" />
            <circle cx="13" cy="8" r="1.7" />
          </svg>
        </button>
      ) : null}

      {menuOpen ? (
        <div className="session-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              void toggleSessionPinned(s.id);
            }}
          >
            {s.pinned ? t.sidebar.unpin : t.sidebar.pin}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              renameCommittedRef.current = false;
              setDraft(s.title);
              setRenaming(true);
            }}
          >
            {t.sidebar.rename}
          </button>
          <button
            type="button"
            role="menuitem"
            className="session-menu-danger"
            onClick={() => {
              setMenuOpen(false);
              setConfirmingDelete(true);
            }}
          >
            {t.sidebar.deleteChat}
          </button>
        </div>
      ) : null}

      {confirmingDelete
        ? createPortal(
            <div
              className="room-modal-overlay"
              role="presentation"
              onClick={() => setConfirmingDelete(false)}
            >
              <div
                className="room-modal room-leave-modal"
                role="dialog"
                aria-label={t.sidebar.deleteChat}
                onClick={(e) => e.stopPropagation()}
              >
                <header className="room-modal-head">
                  <h3>{t.sidebar.deleteChat}</h3>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    ×
                  </button>
                </header>
                <div className="room-modal-body">
                  <p className="room-leave-text" title={s.title}>
                    「{s.title}」
                  </p>
                  <p className="room-leave-warn">{t.sidebar.deleteConfirm}</p>
                </div>
                <footer className="room-modal-foot">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    {t.common.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    autoFocus
                    onClick={() => {
                      setConfirmingDelete(false);
                      void deleteSession(s.id);
                    }}
                  >
                    {t.common.delete}
                  </button>
                </footer>
              </div>
            </div>,
            document.body,
          )
        : null}

      {dragGhost
        ? createPortal(
            <div
              className={`session-drag-ghost${dragGhost.detach ? " detach" : ""}`}
              style={{ left: dragGhost.x + 14, top: dragGhost.y + 12 }}
            >
              <span className="session-drag-ghost-title">{s.title}</span>
              {dragGhost.detach ? (
                <span className="session-drag-ghost-hint">
                  {t.sidebar.releaseToDetach}
                </span>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </li>
  );
}

export type SessionListProps = {
  onOpenSettings: () => void;
  /** File tree (pull-up) panel state and callbacks */
  fileTreeOpen: boolean;
  onToggleFileTree: () => void;
  selectedFile: string | null;
  onSelectFile: (rel: string) => void;
  onOpenFile: (rel: string) => void;
  editorOpen: boolean;
  onToggleEditor: () => void;
};

export function SessionList({
  onOpenSettings,
  fileTreeOpen,
  onToggleFileTree,
  selectedFile,
  onSelectFile,
  onOpenFile,
  editorOpen,
  onToggleEditor,
}: SessionListProps) {
  const { t } = useI18n();
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const cpaStatus = useAppStore((s) => s.cpaStatus);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE);
  const visibleSessions = sessions.slice(0, sessionLimit);
  const hiddenSessions = Math.max(0, sessions.length - sessionLimit);

  return (
    <div className="session-list">
      <div className="sidebar-brand">
        <svg
          className="brand-icon"
          width="20"
          height="20"
          viewBox="0 0 20 20"
          aria-hidden
        >
          <path
            d="M10 2c0.5 3.4 1.1 4.9 2.4 6.2s2.8 1.9 6.2 2.4c-3.4 0.5-4.9 1.1-6.2 2.4s-1.9 2.8-2.4 6.2c-0.5-3.4-1.1-4.9-2.4-6.2S4.8 11.1 1.4 10.6c3.4-0.5 4.9-1.1 6.2-2.4S9.5 5.4 10 2z"
            fill="currentColor"
          />
        </svg>
        <span className="brand-mark">CC</span>
        <span className="brand-sub">Desktop</span>
      </div>

      <button
        type="button"
        className="sidebar-new"
        onClick={() => {
          selectRoom(null);
          newChat();
        }}
      >
        <span className="sidebar-new-icon">+</span>
        {t.sidebar.newChat}
      </button>

      <RoomSidebar />

      <div className="sidebar-section-label">{t.sidebar.recent}</div>

      <ul className="session-list-ul">
        {sessions.length === 0 ? (
          <li className="session-empty">{t.sidebar.noSessions}</li>
        ) : (
          <>
          {visibleSessions.map((s) => (
            <SessionItem key={s.id} s={s} active={s.id === activeSessionId} />
          ))}
          {hiddenSessions > 0 ? (
            <li>
              <button
                type="button"
                className="session-more"
                onClick={() => setSessionLimit((n) => n + SESSION_PAGE)}
              >
                {t.sidebar.showMore}（还有 {hiddenSessions}）
              </button>
            </li>
          ) : null}
          </>
        )}
      </ul>

      {/* 文件栏抽屉：收起时贴在底部（footer 上方）；展开时整栏顶到群聊下方，
          文件树覆盖会话列表区域；再点收起回到原位 */}
      <div className={`sidebar-files${fileTreeOpen ? " open" : ""}`}>
        <div className="sidebar-files-head">
          <button
            type="button"
            className="sidebar-files-toggle"
            onClick={onToggleFileTree}
            aria-expanded={fileTreeOpen}
            title={fileTreeOpen ? "收起文件结构" : "展开文件结构"}
          >
            <span
              className={`sidebar-files-chevron${fileTreeOpen ? " open" : ""}`}
              aria-hidden
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 10l4-4 4 4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="sidebar-files-label">文件</span>
          </button>
          {fileTreeOpen && selectedFile && !editorOpen ? (
            <button
              type="button"
              className="pane-side-btn"
              title="在编辑栏打开"
              onClick={onToggleEditor}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M6 3l5 5-5 5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
        {fileTreeOpen ? (
          <div className="sidebar-files-body">
            <FileTree
              selected={selectedFile}
              onSelectFile={onSelectFile}
              onOpenFile={onOpenFile}
            />
          </div>
        ) : null}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-footer-row"
          onClick={() => void startCpa()}
          title={
            cpaStatus.state === "error"
              ? `CPA error: ${cpaStatus.message}`
              : "Start / ensure CPA"
          }
        >
          <StatusDot status={cpaStatus} compact />
        </button>
        <button
          type="button"
          className="sidebar-footer-row"
          onClick={onOpenSettings}
        >
          <span className="sidebar-footer-icon">⚙</span>
          <span className="sidebar-footer-text">{t.settings.title}</span>
        </button>
      </div>
    </div>
  );
}
