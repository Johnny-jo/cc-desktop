import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionSearchHit, SessionSummary } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import {
  clearProjectPath,
  deleteSession,
  getState,
  newChat,
  openProject,
  renameSession,
  saveSettings,
  selectSession,
  toggleSessionPinned,
  useAppStore,
} from "../state/store";
import { selectRoom } from "../state/room-store";
import { useI18n } from "../i18n/useI18n";
import { formatSessionAge } from "../lib/session-age";
import { FileTree } from "./FileTree";
import { RoomSidebar } from "./RoomSidebar";

const SESSION_PAGE = 30;

/** 分组键：去尾斜杠；Windows 路径大小写不敏感，统一小写比较。 */
function cwdKey(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").toLowerCase();
}

function floatingMenuStyle(
  anchor: DOMRect,
  estimatedHeight: number,
): React.CSSProperties {
  const right = Math.max(8, window.innerWidth - anchor.right);
  return anchor.bottom + estimatedHeight + 8 <= window.innerHeight
    ? { top: anchor.bottom + 4, right }
    : { bottom: Math.max(8, window.innerHeight - anchor.top + 4), right };
}

/** One session row: hover ⋯ menu with pin / rename / delete. */
function SessionItem({
  s,
  active,
  now,
}: {
  s: SessionSummary;
  active: boolean;
  now: number;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
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

  return (
    <li
      ref={rootRef}
      className={`session-list-item${s.pinned ? " pinned" : ""}${menuOpen ? " menu-open" : ""}`}
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
        </button>
      )}

      {!renaming ? (
        <span className="session-item-tail" aria-hidden>
          {s.status === "running" ? (
            <span className="session-running-spinner" />
          ) : (
            <span className="session-item-age">{formatSessionAge(s.updatedAt, now)}</span>
          )}
        </span>
      ) : null}

      {!renaming ? (
        <button
          type="button"
          className="session-item-more"
          aria-label={t.sidebar.more}
          onClick={(e) => {
            e.stopPropagation();
            setMenuStyle(
              floatingMenuStyle(e.currentTarget.getBoundingClientRect(), 126),
            );
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

      {menuOpen
        ? createPortal(
        <div
          className="session-menu session-menu-floating"
          role="menu"
          style={menuStyle}
          onMouseDown={(e) => e.stopPropagation()}
        >
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
        </div>,
        document.body,
          )
        : null}

      {confirmingDelete
        ? createPortal(
            <div
              className="room-modal-overlay"
              role="presentation"
              onClick={() => setConfirmingDelete(false)}
            >
              <div
                className="room-modal workspace-remove-modal"
                role="dialog"
                aria-modal="true"
                aria-label={t.sidebar.deleteChat}
                onClick={(e) => e.stopPropagation()}
              >
                <header className="room-modal-head">
                  <h3>{t.sidebar.deleteChat}</h3>
                  <button
                    type="button"
                    className="workspace-remove-close"
                    aria-label={t.common.close}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path d="M5 5l14 14M19 5 5 19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                  </button>
                </header>
                <div className="room-modal-body">
                  <p className="workspace-remove-prompt" title={s.title}>
                    {t.sidebar.deleteChatPrompt}「{s.title}」？
                  </p>
                </div>
                <footer className="room-modal-foot">
                  <button
                    type="button"
                    className="workspace-remove-cancel"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    {t.common.cancel}
                  </button>
                  <button
                    type="button"
                    className="workspace-remove-confirm"
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

type ProjectGroup = {
  key: string;
  cwd: string;
  sessions: SessionSummary[];
};

/** 项目组行：文件夹图标（点击折叠/展开本组会话，图标随状态变化）+ 项目名；
 *  hover 出现 ⋯（在文件管理器中显示）和 +（在此工作区新建会话）。 */
function ProjectRow({
  cwd,
  current,
  collapsed,
  onToggleFold,
  onDeleteWorkspace,
}: {
  cwd: string;
  current: boolean;
  collapsed: boolean;
  onToggleFold: () => void;
  onDeleteWorkspace: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const name =
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() ?? cwd;

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

  useEffect(() => {
    if (!confirmingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deleting) setConfirmingDelete(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmingDelete, deleting]);

  return (
    <div
      ref={rootRef}
      className={`session-project-row${current ? " current" : ""}${menuOpen ? " menu-open" : ""}`}
      title={cwd}
    >
      <button
        type="button"
        className="session-project-toggle"
        title={collapsed ? t.sidebar.expandOne : t.sidebar.collapseOne}
        aria-label={collapsed ? t.sidebar.expandOne : t.sidebar.collapseOne}
        aria-expanded={!collapsed}
        onClick={onToggleFold}
      >
        {collapsed ? (
          /* 收起态：闭合文件夹 */
          <svg
            className="session-project-icon"
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
          >
            <path
              d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2L7.7 5H13a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          /* 展开态：打开的文件夹（前盖翻开） */
          <svg
            className="session-project-icon"
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
          >
            <path
              d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3.2L7.7 5H13a1.5 1.5 0 0 1 1.5 1.5v1H4.55a1.5 1.5 0 0 0-1.41 1L1.5 11.5v-7Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
            <path
              d="M3.1 13h9.2a1.5 1.5 0 0 0 1.41-1l1.4-3.5H5a1.5 1.5 0 0 0-1.41 1L3.1 13Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        )}
        <span className="session-project-name">{name}</span>
      </button>
      <span className="session-project-actions">
        <button
          type="button"
          className="session-project-action"
          aria-label={t.sidebar.more}
          onClick={(e) => {
            e.stopPropagation();
            setMenuStyle(
              floatingMenuStyle(e.currentTarget.getBoundingClientRect(), 92),
            );
            setMenuOpen((v) => !v);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <circle cx="3" cy="8" r="1.7" />
            <circle cx="8" cy="8" r="1.7" />
            <circle cx="13" cy="8" r="1.7" />
          </svg>
        </button>
        <button
          type="button"
          className="session-project-action"
          title={t.sidebar.newChatInProject}
          aria-label={t.sidebar.newChatInProject}
          onClick={(e) => {
            e.stopPropagation();
            selectRoom(null);
            void openProject(cwd).then(() => newChat());
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path
              d="M6 2v8M2 6h8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </span>
      {menuOpen
        ? createPortal(
        <div
          className="session-menu session-menu-floating"
          role="menu"
          style={menuStyle}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              void getDesktop()
                .revealFile(cwd)
                .catch(() => undefined);
            }}
          >
            {t.sidebar.revealInFileManager}
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
            {t.sidebar.deleteWorkspace}
          </button>
        </div>,
        document.body,
          )
        : null}
      {confirmingDelete
        ? createPortal(
            <div
              className="room-modal-overlay"
              role="presentation"
              onClick={() => !deleting && setConfirmingDelete(false)}
            >
              <div
                className="room-modal workspace-remove-modal"
                role="dialog"
                aria-modal="true"
                aria-label={t.sidebar.deleteWorkspace}
                onClick={(e) => e.stopPropagation()}
              >
                <header className="room-modal-head">
                  <h3>{t.sidebar.deleteWorkspace}</h3>
                  <button
                    type="button"
                    className="workspace-remove-close"
                    aria-label={t.common.close}
                    disabled={deleting}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path d="M5 5l14 14M19 5 5 19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                  </button>
                </header>
                <div className="room-modal-body">
                  <p className="workspace-remove-prompt" title={cwd}>
                    {t.sidebar.removeWorkspacePrompt}「{name}」？
                  </p>
                </div>
                <footer className="room-modal-foot">
                  <button
                    type="button"
                    className="workspace-remove-cancel"
                    disabled={deleting}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    {t.common.cancel}
                  </button>
                  <button
                    type="button"
                    className="workspace-remove-confirm"
                    autoFocus
                    disabled={deleting}
                    onClick={() => {
                      setDeleting(true);
                      void onDeleteWorkspace()
                        .catch(() => undefined)
                        .finally(() => {
                          setDeleting(false);
                          setConfirmingDelete(false);
                        });
                    }}
                  >
                    {deleting ? t.common.loading : t.common.confirm}
                  </button>
                </footer>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export type SessionListProps = {
  /** 左侧 icon 工具栏模式：chat = 会话列表；rooms = 项目行 + 群聊列表 */
  railMode: "chat" | "rooms";
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
  railMode,
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
  const projectPath = useAppStore((s) => s.projectPath);
  const settings = useAppStore((s) => s.settings);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE);
  /** 折叠的项目组 key 集合；默认全部展开。 */
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [contentHits, setContentHits] = useState<SessionSearchHit[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const hiddenSessions = Math.max(0, sessions.length - sessionLimit);
  const projectName = projectPath
    ? (projectPath.replace(/[\\/]+$/, "").split(/[/\\]/).pop() ?? projectPath)
    : null;

  // 项目分组：sessions 的 cwd ∪ 当前 projectPath ∪ settings.projects（空项目也保留）。
  // 排序：按组内最近会话时间倒序；组内保持 sessions 顺序（置顶优先）。
  // 不按当前项目组置顶——否则点击其他项目的会话时，该组会被顶到最上面。
  const currentKey = projectPath ? cwdKey(projectPath) : null;
  const hiddenProjectKeys = useMemo(
    () => new Set((settings?.hiddenProjects ?? []).map(cwdKey)),
    [settings?.hiddenProjects],
  );
  const groups = useMemo<ProjectGroup[]>(() => {
    const byKey = new Map<string, ProjectGroup>();
    const ensure = (cwd: string): ProjectGroup => {
      const key = cwdKey(cwd);
      let g = byKey.get(key);
      if (!g) {
        g = { key, cwd: cwd.replace(/[\\/]+$/, ""), sessions: [] };
        byKey.set(key, g);
      }
      return g;
    };
    for (const s of sessions.slice(0, sessionLimit)) {
      if (
        s.cwd &&
        (!hiddenProjectKeys.has(cwdKey(s.cwd)) || cwdKey(s.cwd) === currentKey)
      ) {
        ensure(s.cwd).sessions.push(s);
      }
    }
    if (projectPath) ensure(projectPath);
    for (const dir of settings?.projects ?? []) {
      if (!hiddenProjectKeys.has(cwdKey(dir)) || cwdKey(dir) === currentKey) ensure(dir);
    }
    const arr = [...byKey.values()];
    arr.sort((a, b) => {
      const lastA = a.sessions.reduce((m, s) => Math.max(m, s.updatedAt), 0);
      const lastB = b.sessions.reduce((m, s) => Math.max(m, s.updatedAt), 0);
      return lastB - lastA;
    });
    return arr;
  }, [
    sessions,
    sessionLimit,
    projectPath,
    settings?.projects,
    hiddenProjectKeys,
    currentKey,
  ]);

  const allCollapsed =
    groups.length > 0 && groups.every((g) => collapsedKeys.has(g.key));

  const trimmedQuery = searchQuery.trim();
  /** 标题匹配：本地 sessions 已全量加载，即时过滤即可。 */
  const titleMatches = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return [];
    return sessions
      .filter((s) => s.title.toLowerCase().includes(q))
      .slice(0, 20);
  }, [sessions, trimmedQuery]);

  const toggleGroupFold = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  // 内容搜索：输入防抖 300ms 后交给主进程查 SQLite。内容匹配由主进程
  // 限量扫描并截取片段返回，避免把全部会话文本读进渲染进程（防爆内存）。
  useEffect(() => {
    if (!trimmedQuery) {
      setContentHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      getDesktop()
        .searchSessions(trimmedQuery, 20)
        .then((r) => {
          if (alive) setContentHits(r.results);
        })
        .catch(() => {
          if (alive) setContentHits([]);
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [trimmedQuery]);

  /** 节头 +：选一个文件夹加入项目列表（同时切为当前项目）。 */
  const onAddProject = async () => {
    await openProject();
    const st = getState();
    const path = st.projectPath;
    if (!path || !st.settings) return;
    const list = st.settings.projects ?? [];
    if (list.some((x) => cwdKey(x) === cwdKey(path))) return;
    await saveSettings({ projects: [...list, path] });
  };

  const onDeleteWorkspace = async (group: ProjectGroup) => {
    const st = getState();
    const projects = (st.settings?.projects ?? []).filter(
      (path) => cwdKey(path) !== group.key,
    );
    const hiddenProjects = st.settings?.hiddenProjects ?? [];
    const nextHiddenProjects = hiddenProjects.some(
      (path) => cwdKey(path) === group.key,
    )
      ? hiddenProjects
      : [...hiddenProjects, group.cwd];
    const removingCurrent = st.projectPath
      ? cwdKey(st.projectPath) === group.key
      : false;
    await saveSettings({
      projects,
      hiddenProjects: nextHiddenProjects,
      ...(removingCurrent ? { lastProjectPath: null } : {}),
    });
    if (removingCurrent) clearProjectPath();
  };

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

      {railMode === "rooms" ? (
        <>
          {/* 项目行：显示当前选中的项目，点击可换 */}
          <button
            type="button"
            className="sidebar-project"
            title={projectPath ?? "选择项目文件夹"}
            onClick={() => void openProject()}
          >
            <svg
              className="sidebar-project-icon"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
            >
              <path
                d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
            <span className="sidebar-project-label">项目</span>
            <span className="sidebar-project-name">
              {projectName ?? "未选择"}
            </span>
          </button>
          <RoomSidebar />
        </>
      ) : (
        <>
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

          <button
            type="button"
            className="sidebar-new sidebar-search-trigger"
            onClick={() => setSearchOpen(true)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle
                cx="7"
                cy="7"
                r="4.5"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M10.5 10.5 14 14"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            {t.sidebar.searchChats}
          </button>

          <div className="sidebar-section-head">
            <span className="sidebar-section-label">{t.sidebar.projects}</span>
            <span className="sidebar-section-actions">
              <button
                type="button"
                className="session-project-action"
                title={allCollapsed ? t.sidebar.expandAll : t.sidebar.collapseAll}
                aria-label={
                  allCollapsed ? t.sidebar.expandAll : t.sidebar.collapseAll
                }
                onClick={() =>
                  setCollapsedKeys(
                    allCollapsed
                      ? new Set()
                      : new Set(groups.map((g) => g.key)),
                  )
                }
              >
                {allCollapsed ? (
                  /* 全部已折叠：上下箭头向外 = 展开全部 */
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M3 6l5-4 5 4M3 10l5 4 5-4"
                      stroke="currentColor"
                      strokeWidth="1.35"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  /* 有展开的组：上下箭头向内 = 折叠全部 */
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M3 3l5 4 5-4M3 13l5-4 5 4"
                      stroke="currentColor"
                      strokeWidth="1.35"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className="session-project-action"
                title={t.sidebar.addProject}
                aria-label={t.sidebar.addProject}
                onClick={() => void onAddProject()}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                  <path
                    d="M6 2v8M2 6h8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </span>
          </div>

          <ul className="session-list-ul">
            {groups.length === 0 ? (
              <li className="session-empty">{t.sidebar.noSessions}</li>
            ) : (
              <>
              {groups.map((g) => (
                <li key={g.key} className="session-project-group">
                  <ProjectRow
                    cwd={g.cwd}
                    current={g.key === currentKey}
                    collapsed={collapsedKeys.has(g.key)}
                    onToggleFold={() => toggleGroupFold(g.key)}
                    onDeleteWorkspace={() => onDeleteWorkspace(g)}
                  />
                  {g.sessions.length > 0 ? (
                    <div
                      className={`session-project-sessions-clip${collapsedKeys.has(g.key) ? " collapsed" : ""}`}
                      aria-hidden={collapsedKeys.has(g.key)}
                    >
                    <ul className="session-project-sessions">
                      {g.sessions.map((s) => (
                        <SessionItem key={s.id} s={s} active={s.id === activeSessionId} now={now} />
                      ))}
                    </ul>
                    </div>
                  ) : null}
                </li>
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

          {searchOpen
            ? createPortal(
                <div
                  className="session-search-overlay"
                  role="presentation"
                  onClick={() => setSearchOpen(false)}
                >
                  <div
                    className="session-search-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label={t.sidebar.searchChats}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="session-search-field">
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <input
                        ref={searchInputRef}
                        type="text"
                        value={searchQuery}
                        placeholder={t.sidebar.searchPlaceholder}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                      {searchQuery ? (
                        <button
                          type="button"
                          className="sidebar-search-clear"
                          aria-label={t.sidebar.searchClear}
                          onClick={() => setSearchQuery("")}
                        >×</button>
                      ) : null}
                    </div>
                    <div className="session-search-section-label">{t.sidebar.chats}</div>
                    <ul className="session-search-results">
                      {!trimmedQuery ? (
                        sessions.slice(0, 9).map((s) => (
                          <li key={s.id}>
                            <button type="button" className={`session-search-hit${s.id === activeSessionId ? " active" : ""}`} onClick={() => {
                              setSearchOpen(false);
                              void selectSession(s.id);
                            }}>
                              <span className="session-search-hit-title">{s.title}</span>
                              <span className="session-search-hit-project">{s.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}</span>
                            </button>
                          </li>
                        ))
                      ) : titleMatches.length === 0 && contentHits.filter(
                        (h) => !titleMatches.some((s) => s.id === h.sessionId),
                      ).length === 0 ? (
                        <li className="session-empty">{t.sidebar.searchNoResults}</li>
                      ) : (
                        <>
                          {titleMatches.map((s) => (
                            <li key={s.id}>
                              <button type="button" className={`session-search-hit${s.id === activeSessionId ? " active" : ""}`} onClick={() => {
                                setSearchOpen(false);
                                void selectSession(s.id);
                              }}>
                                <span className="session-search-hit-title">{s.title}</span>
                                <span className="session-search-hit-project">{s.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}</span>
                              </button>
                            </li>
                          ))}
                          {contentHits.filter(
                            (h) => !titleMatches.some((s) => s.id === h.sessionId),
                          ).map((h) => (
                            <li key={h.sessionId}>
                              <button type="button" className={`session-search-hit with-snippet${h.sessionId === activeSessionId ? " active" : ""}`} onClick={() => {
                                setSearchOpen(false);
                                void selectSession(h.sessionId);
                              }}>
                                <span className="session-search-hit-title">{h.title}</span>
                                <span className="session-search-hit-project">{h.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}</span>
                                <span className="session-search-hit-snippet">{h.snippet}</span>
                              </button>
                            </li>
                          ))}
                        </>
                      )}
                    </ul>
                  </div>
                </div>,
                document.body,
              )
            : null}

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
        </>
      )}
    </div>
  );
}
