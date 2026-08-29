import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import {
  TitlebarToggles,
  ThemeToggle,
  ChangelogToggle,
  ResizeHandle,
} from "./components/LayoutChrome";
import { SideRail, type RailMode } from "./components/SideRail";
import { ChangelogModal } from "./components/ChangelogModal";
import { PermissionModal } from "./components/PermissionModal";
import { RoomPermAskModal } from "./components/RoomPermAskModal";
import { UserPromptModal } from "./components/UserPromptModal";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { OnboardingModal } from "./components/OnboardingModal";
import { ErrorBanner } from "./components/ErrorBanner";
import { UpdateBanner } from "./components/UpdateBanner";
import { FileEditor } from "./components/FileEditor";
import { FileSearchModal } from "./components/FileSearchModal";
import { RoomStage } from "./components/RoomStage";
import { CliModePage } from "./components/CliModePage";
import { getDesktop } from "./lib/desktop-api";
import { dropEditorBuffer } from "./lib/editor-buffer-cache";
import {
  bindRoomEvents,
  refreshRooms,
  selectRoom,
  useRoomStore,
} from "./state/room-store";
import { usePanelLayout } from "./hooks/usePanelLayout";
import {
  applyTheme,
  effectiveTheme,
  nextTheme,
  onSystemThemeChange,
} from "./lib/theme";
import {
  bootstrapStore,
  detachedWindowRoomId,
  detachedWindowSessionId,
  flushAllTranscripts,
  selectSession,
  setTheme,
  toggleCliMode,
  useAppStore,
} from "./state/store";

/** Soft max editor share while chat stays visible (chat min 35%). */
const EDITOR_SOFT_MAX = 0.65;
/** Soft min editor share before auto-close. */
const EDITOR_SOFT_MIN = 0.22;
/** Default / restored split after leaving full cover. */
const EDITOR_DEFAULT_RATIO = 0.5;
/** Collapse-to-min when switching session while full-covered. */
const EDITOR_MIN_RATIO = 0.35;
/** Keep the active editor plus two warm neighbors; snapshots preserve the rest. */
const MAX_MOUNTED_EDITOR_VIEWS = 3;

function fileName(rel: string): string {
  return rel.split(/[/\\]/).pop() ?? rel;
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  // 左侧 icon 工具栏：chat = 会话侧栏；rooms = 群聊侧栏（项目行 + 群聊列表）
  const [railMode, setRailMode] = useState<RailMode>("chat");
  const settings = useAppStore((s) => s.settings);
  const needsOnboarding = settings != null && !settings.hasToken;
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const cliMode = useAppStore((s) => s.cliMode);
  const activeRoomId = useRoomStore((s) => s.activeRoomId);
  const projectPath = useAppStore((s) => s.projectPath);
  // AI 对话 / 群聊互斥：选中群聊（含通知点击跳转）时主区切群聊，
  // rail 点「群聊」即使未选群也关 AI 对话页、显示群聊空态。
  const effectiveMode: RailMode = railMode === "rooms" || activeRoomId ? "rooms" : railMode;

  // ---- File tree + multi-tab editor pane ----
  const [fileTreeOpen, setFileTreeOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorTabs, setEditorTabs] = useState<string[]>([]);
  const [activeEditor, setActiveEditor] = useState<string | null>(null);
  const [editorViewLru, setEditorViewLru] = useState<string[]>([]);
  /** Editor pane width as fraction of (chat+editor) area */
  const [editorRatio, setEditorRatio] = useState(EDITOR_DEFAULT_RATIO);
  const [editorFull, setEditorFull] = useState(false);
  /**
   * Secondary-pull gate: after a drag parks at soft-max (65%), the *next*
   * drag that starts already at soft-max may enter full-cover. Same continuous
   * drag never covers — user must release and pull again.
   */
  const softMaxArmedRef = useRef(false);
  /** Changes panel full-cover (chat hidden) + second-pull arming. */
  const [changesFull, setChangesFull] = useState(false);
  const changesArmedRef = useRef(false);
  /** Pinned editor tabs (excluded from bulk close actions). */
  const [pinnedTabs, setPinnedTabs] = useState<Set<string>>(() => new Set());
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: string } | null>(null);
  const tabsStripRef = useRef<HTMLDivElement | null>(null);
  const dragTabRef = useRef<string | null>(null);

  const editorOpen = editorTabs.length > 0 && activeEditor != null;
  const mountedEditorOrder = activeEditor
    ? [
        activeEditor,
        ...editorViewLru.filter(
          (tab) => tab !== activeEditor && editorTabs.includes(tab),
        ),
      ].slice(0, MAX_MOUNTED_EDITOR_VIEWS)
    : [];
  const mountedEditorSet = new Set(mountedEditorOrder);

  useEffect(() => {
    setEditorViewLru((previous) => {
      const next = activeEditor
        ? [
            activeEditor,
            ...previous.filter(
              (tab) => tab !== activeEditor && editorTabs.includes(tab),
            ),
          ].slice(0, MAX_MOUNTED_EDITOR_VIEWS)
        : [];
      return next.length === previous.length &&
        next.every((tab, index) => tab === previous[index])
        ? previous
        : next;
    });
  }, [activeEditor, editorTabs]);

  // A tab evicted only by the view LRU keeps its snapshot. A tab explicitly
  // closed by the user must not resurrect an old unsaved buffer when reopened.
  const previousEditorsRef = useRef<{
    projectPath: string | null;
    tabs: string[];
  }>({ projectPath, tabs: [] });
  useEffect(() => {
    const previous = previousEditorsRef.current;
    const closed =
      previous.projectPath !== projectPath
        ? previous.tabs
        : previous.tabs.filter((tab) => !editorTabs.includes(tab));
    if (previous.projectPath) {
      for (const tab of closed) {
        dropEditorBuffer(previous.projectPath, tab);
      }
    }
    previousEditorsRef.current = { projectPath, tabs: editorTabs };
  }, [editorTabs, projectPath]);

  // Horizontal wheel → scroll tabs (trackpad / mouse wheel)
  useEffect(() => {
    const el = tabsStripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [editorOpen, editorTabs.length]);

  const onSelectFile = (rel: string) => setSelectedFile(rel);

  const onOpenFile = useCallback((rel: string) => {
    setSelectedFile(rel);
    setEditorTabs((tabs) => (tabs.includes(rel) ? tabs : [...tabs, rel]));
    setActiveEditor(rel);
    setEditorFull(false);
    setEditorRatio((r) =>
      r >= EDITOR_SOFT_MIN && r <= EDITOR_SOFT_MAX ? r : EDITOR_DEFAULT_RATIO,
    );
  }, []);

  const closeEditorTab = useCallback((rel: string) => {
    setEditorTabs((tabs) => {
      const idx = tabs.indexOf(rel);
      if (idx < 0) return tabs;
      const next = tabs.filter((t) => t !== rel);
      setActiveEditor((cur) => {
        if (cur !== rel) return cur;
        if (next.length === 0) return null;
        return next[Math.min(idx, next.length - 1)] ?? next[0] ?? null;
      });
      return next;
    });
  }, []);

  const closeAllEditors = useCallback(() => {
    setEditorTabs([]);
    setActiveEditor(null);
    setEditorFull(false);
  }, []);

  // ---- Tab context menu actions (bulk closes keep pinned tabs) ----
  const togglePinTab = useCallback((tab: string) => {
    setPinnedTabs((prev) => {
      const next = new Set(prev);
      if (next.has(tab)) next.delete(tab);
      else next.add(tab);
      return next;
    });
  }, []);

  const closeRightTabs = useCallback(
    (tab: string) => {
      setEditorTabs((tabs) => {
        const idx = tabs.indexOf(tab);
        if (idx < 0) return tabs;
        const next = tabs.filter((t, i) => i <= idx || pinnedTabs.has(t));
        setActiveEditor((cur) =>
          cur && next.includes(cur) ? cur : (next[next.length - 1] ?? null),
        );
        if (next.length === 0) setEditorFull(false);
        return next;
      });
    },
    [pinnedTabs],
  );

  const closeOtherTabs = useCallback(
    (keep: string) => {
      setEditorTabs((tabs) => {
        const next = tabs.filter((t) => t === keep || pinnedTabs.has(t));
        setActiveEditor((cur) =>
          cur && next.includes(cur) ? cur : (next[0] ?? null),
        );
        if (next.length === 0) setEditorFull(false);
        return next;
      });
    },
    [pinnedTabs],
  );

  const closeAllUnpinnedTabs = useCallback(() => {
    setEditorTabs((tabs) => {
      const next = tabs.filter((t) => pinnedTabs.has(t));
      setActiveEditor((cur) =>
        cur && next.includes(cur) ? cur : (next[0] ?? null),
      );
      if (next.length === 0) setEditorFull(false);
      return next;
    });
  }, [pinnedTabs]);

  // Tab menu: click-outside / Esc closes
  useEffect(() => {
    if (!tabMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTabMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabMenu]);

  // When full-covered and user switches session → shrink editor to min (keep tabs).
  const prevSessionRef = useRef(activeSessionId);
  useEffect(() => {
    if (prevSessionRef.current === activeSessionId) return;
    prevSessionRef.current = activeSessionId;
    if (editorFull) {
      setEditorFull(false);
      setEditorRatio(EDITOR_MIN_RATIO);
    }
  }, [activeSessionId, editorFull]);

  const {
    layout,
    patch,
    toggleSidebar,
    toggleChanges,
    toggleTerminal,
    setSidebarWidth,
    setChangesWidth,
    setTerminalHeight,
  } = usePanelLayout();

  // Tool card "jump to change" → make sure the changes panel is visible.
  const revealChangeRequest = useAppStore((s) => s.revealChangeRequest);
  useEffect(() => {
    if (revealChangeRequest && !layout.changesOpen) {
      patch({ changesOpen: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealChangeRequest]);

  useEffect(() => {
    void bootstrapStore();
    void refreshRooms();
    // 独立群聊窗口（?detached=1&room=<id>）：进来就选中该群
    const detachedRoom = detachedWindowRoomId();
    if (detachedRoom) selectRoom(detachedRoom);
    return bindRoomEvents();
  }, []);

  useEffect(() => {
    applyTheme(settings?.theme);
    try {
      getDesktop()
        .notifyTheme(effectiveTheme(settings?.theme))
        .catch(() => undefined);
    } catch {
      // not in electron
    }
    if (settings?.theme && settings.theme !== "system") return;
    return onSystemThemeChange(() => applyTheme(settings?.theme));
  }, [settings?.theme]);

  // Global UI font size → CSS variable on <html>
  useEffect(() => {
    const size = settings?.uiFontSize ?? 13;
    document.documentElement.style.setProperty(
      "--ui-font-size",
      `${size}px`,
    );
  }, [settings?.uiFontSize]);

  // UI language → data-locale on <html> (CSS / tests / future locale-aware bits)
  useEffect(() => {
    const locale =
      settings?.locale === "zh" || settings?.locale === "en"
        ? settings.locale
        : navigator.language?.toLowerCase().startsWith("zh")
          ? "zh"
          : "en";
    document.documentElement.dataset.locale = locale;
  }, [settings?.locale]);

  // Ctrl+Shift+F — project file search palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || !e.shiftKey) return;
      // F key (also accept lowercase when layout differs)
      if (e.key === "F" || e.key === "f") {
        // Don't steal when typing into native dialogs with preventDefault already handled
        e.preventDefault();
        setFileSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+Shift+L — toggle CLI light-freeze mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "l")) return;
      e.preventDefault();
      const next = !cliMode;
      toggleCliMode();
      if (!next && activeSessionId) {
        void selectSession(activeSessionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cliMode, activeSessionId]);

  useEffect(() => {
    const onChanges = () => toggleChanges();
    const onSidebar = () => toggleSidebar();
    const onTerminal = () => toggleTerminal();
    window.addEventListener("cd:toggle-changes", onChanges);
    window.addEventListener("cd:toggle-sidebar", onSidebar);
    window.addEventListener("cd:toggle-terminal", onTerminal);
    return () => {
      window.removeEventListener("cd:toggle-changes", onChanges);
      window.removeEventListener("cd:toggle-sidebar", onSidebar);
      window.removeEventListener("cd:toggle-terminal", onTerminal);
    };
  }, [toggleChanges, toggleSidebar, toggleTerminal]);

  useEffect(() => {
    const flush = () => {
      try {
        flushAllTranscripts();
      } catch {
        // ignore
      }
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  const workspaceStyle = {
    ["--sidebar-w" as string]: `${layout.sidebarWidth}px`,
    ["--changes-w" as string]: `${layout.changesWidth}px`,
    ["--terminal-h" as string]: layout.terminalOpen
      ? `${layout.terminalHeight}px`
      : "0px",
  } as React.CSSProperties;

  // Detached window (browser-style drag-out): chat-only shell, no sidebar /
  // changes / terminal. SessionManager lives in the shared main process, so
  // both windows see the same live session.
  if (detachedWindowSessionId()) {
    return (
      <div className="app app-detached">
        <div className="app-titlebar">
          <div className="titlebar-drag" aria-hidden />
          <ThemeToggle
            isLight={effectiveTheme(settings?.theme) === "light"}
            onToggle={() => void setTheme(nextTheme(settings?.theme))}
          />
          <div className="titlebar-caption-space" aria-hidden />
        </div>
        <ErrorBanner />

        <div className="workspace" style={workspaceStyle}>
          <div className="main-row">
            <main className="panel panel-chat">
              <ChatPanel onOpenSettings={() => setSettingsOpen(true)} />
            </main>
          </div>
        </div>

        <PermissionModal />
        <RoomPermAskModal />
        <UserPromptModal />
        <OnboardingModal open={needsOnboarding} />
        <SettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    );
  }

  // Detached room window (double-click / drag-out): room-only shell.
  if (detachedWindowRoomId()) {
    return (
      <div className="app app-detached">
        <div className="app-titlebar">
          <div className="titlebar-drag" aria-hidden />
          <ThemeToggle
            isLight={effectiveTheme(settings?.theme) === "light"}
            onToggle={() => void setTheme(nextTheme(settings?.theme))}
          />
          <div className="titlebar-caption-space" aria-hidden />
        </div>
        <ErrorBanner />

        <div className="workspace" style={workspaceStyle}>
          <div className="main-row">
            <main className="panel panel-chat">
              <RoomStage />
            </main>
          </div>
        </div>

        <PermissionModal />
        <RoomPermAskModal />
        <UserPromptModal />
        <OnboardingModal open={needsOnboarding} />
        <SettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app-titlebar">
        <div className="titlebar-drag" aria-hidden />
        <TitlebarToggles
          sidebarOpen={layout.sidebarOpen}
          changesOpen={layout.changesOpen}
          terminalOpen={layout.terminalOpen}
          onToggleSidebar={toggleSidebar}
          onToggleChanges={toggleChanges}
          onToggleTerminal={toggleTerminal}
        />
        <div className="titlebar-right">
          <ChangelogToggle onClick={() => setChangelogOpen(true)} />
        </div>
        <div className="titlebar-caption-space" aria-hidden />
      </div>
      <ErrorBanner />
      <UpdateBanner />

      <div
        className={
          layout.terminalOpen
            ? "workspace workspace-terminal-open"
            : "workspace workspace-terminal-open workspace-terminal-collapsed"
        }
        style={workspaceStyle}
      >
        <div className="main-row">
          <SideRail
            mode={effectiveMode}
            onModeChange={setRailMode}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          {layout.sidebarOpen ? (
            <>
              <aside
                className="panel panel-sessions"
                style={{
                  width: layout.sidebarWidth,
                  flex: `0 0 ${layout.sidebarWidth}px`,
                }}
              >
                <SessionList
                  railMode={effectiveMode === "rooms" ? "rooms" : "chat"}
                  fileTreeOpen={fileTreeOpen}
                  onToggleFileTree={() => setFileTreeOpen((v) => !v)}
                  selectedFile={selectedFile}
                  onSelectFile={onSelectFile}
                  onOpenFile={onOpenFile}
                  editorOpen={editorOpen}
                  onToggleEditor={() => {
                    if (editorOpen) {
                      closeAllEditors();
                    } else if (selectedFile) {
                      onOpenFile(selectedFile);
                    }
                  }}
                />
              </aside>
              {settingsOpen ? null : (
                <ResizeHandle
                  axis="sidebar"
                  size={layout.sidebarWidth}
                  onResize={setSidebarWidth}
                />
              )}
            </>
          ) : null}

          {changesFull ? null : (
          <main className="panel panel-chat">
            {cliMode ? (
              <CliModePage />
            ) : (
            <div className="chat-editor-row">
              {editorOpen && activeEditor ? (
                <>
                  <div
                    className="editor-col"
                    style={
                      editorFull
                        ? { flex: "1 1 0" }
                        : { flex: `0 0 ${editorRatio * 100}%` }
                    }
                  >
                    {/* Multi-file tabs — drag reorder + horizontal wheel scroll */}
                    <div
                      className="editor-tabs"
                      role="tablist"
                      ref={tabsStripRef}
                    >
                      {editorTabs.map((tab) => {
                        const active = tab === activeEditor;
                        return (
                          <div
                            key={tab}
                            className={
                              active
                                ? "editor-tab active"
                                : "editor-tab"
                            }
                            role="tab"
                            aria-selected={active}
                            title={tab}
                            draggable
                            onDragStart={(e) => {
                              dragTabRef.current = tab;
                              e.dataTransfer.effectAllowed = "move";
                              e.dataTransfer.setData("text/plain", tab);
                              (e.currentTarget as HTMLElement).classList.add(
                                "dragging",
                              );
                            }}
                            onDragEnd={(e) => {
                              dragTabRef.current = null;
                              (e.currentTarget as HTMLElement).classList.remove(
                                "dragging",
                              );
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              const from =
                                dragTabRef.current ??
                                e.dataTransfer.getData("text/plain");
                              if (!from || from === tab) return;
                              setEditorTabs((tabs) => {
                                const next = [...tabs];
                                const fromIdx = next.indexOf(from);
                                const toIdx = next.indexOf(tab);
                                if (fromIdx < 0 || toIdx < 0) return tabs;
                                next.splice(fromIdx, 1);
                                next.splice(toIdx, 0, from);
                                return next;
                              });
                              dragTabRef.current = null;
                            }}
                            onClick={() => {
                              setActiveEditor(tab);
                              setSelectedFile(tab);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setTabMenu({ x: e.clientX, y: e.clientY, tab });
                            }}
                          >
                            {pinnedTabs.has(tab) ? (
                              <span className="editor-tab-pin" title="已固定" aria-hidden>
                                📌
                              </span>
                            ) : null}
                            <span className="editor-tab-name">
                              {fileName(tab)}
                            </span>
                            <button
                              type="button"
                              className="editor-tab-close"
                              title="关闭"
                              draggable={false}
                              onClick={(e) => {
                                e.stopPropagation();
                                closeEditorTab(tab);
                              }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                      {editorFull ? (
                        <button
                          type="button"
                          className="pane-side-btn editor-collapse-btn"
                          title="收缩编辑栏"
                          onClick={() => {
                            setEditorFull(false);
                            setEditorRatio(EDITOR_DEFAULT_RATIO);
                            softMaxArmedRef.current = true;
                          }}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            aria-hidden
                          >
                            <path
                              d="M10 3L5 8l5 5"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      ) : null}
                    </div>

                    {editorTabs
                      .filter((tab) => mountedEditorSet.has(tab))
                      .map((tab) => (
                        <FileEditor
                          key={tab}
                          rel={tab}
                          hidden={tab !== activeEditor}
                          onClose={() => closeEditorTab(tab)}
                        />
                      ))}
                  </div>

                  {!editorFull && settingsOpen === false ? (
                    <div
                      className="editor-divider"
                      role="separator"
                      aria-orientation="vertical"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        const el = e.currentTarget;
                        const row = el.parentElement as HTMLElement;
                        const editorCol = row.querySelector(
                          ".editor-col",
                        ) as HTMLElement | null;
                        const chatCol = row.querySelector(
                          ".chat-col",
                        ) as HTMLElement | null;
                        const startX = e.clientX;
                        const rowW = row.getBoundingClientRect().width || 1;
                        const startRatio = editorRatio;
                        // Second pull only: armed when a prior drag already parked at soft max
                        const allowFullCover =
                          softMaxArmedRef.current &&
                          startRatio >= EDITOR_SOFT_MAX - 0.001;
                        // Consume the arm for this gesture (re-arm on release if still at max)
                        softMaxArmedRef.current = false;
                        let reachedSoftMax = startRatio >= EDITOR_SOFT_MAX - 0.001;
                        let liveRatio = startRatio;
                        el.setPointerCapture(e.pointerId);

                        const paint = (ratio: number) => {
                          liveRatio = ratio;
                          if (editorCol) {
                            editorCol.style.flex = `0 0 ${ratio * 100}%`;
                          }
                          if (chatCol) {
                            chatCol.style.flex = `0 0 ${(1 - ratio) * 100}%`;
                            chatCol.style.minWidth = "0";
                          }
                        };

                        const onMove = (ev: PointerEvent) => {
                          const dx = ev.clientX - startX;
                          const raw = startRatio + dx / rowW;

                          // Collapse editor if dragged too narrow
                          if (raw < EDITOR_SOFT_MIN * 0.75) {
                            closeAllEditors();
                            cleanup();
                            return;
                          }

                          // Soft max = chat min 35% (editor ≤ 65%)
                          if (raw <= EDITOR_SOFT_MAX) {
                            if (raw >= EDITOR_SOFT_MAX - 0.001) {
                              reachedSoftMax = true;
                            } else {
                              // Pulled back under soft max → cancel second-pull arm
                              reachedSoftMax = false;
                            }
                            paint(
                              Math.max(
                                EDITOR_SOFT_MIN,
                                Math.min(EDITOR_SOFT_MAX, raw),
                              ),
                            );
                            return;
                          }

                          // Past soft max on THIS gesture
                          reachedSoftMax = true;
                          if (allowFullCover) {
                            // Second intentional pull → full cover
                            setEditorFull(true);
                            setEditorRatio(EDITOR_SOFT_MAX);
                            softMaxArmedRef.current = false;
                            cleanup();
                            return;
                          }
                          // First pull: park at soft max (must release then pull again)
                          paint(EDITOR_SOFT_MAX);
                        };

                        const cleanup = () => {
                          window.removeEventListener("pointermove", onMove);
                          window.removeEventListener("pointerup", onUp);
                          window.removeEventListener("pointercancel", onUp);
                        };
                        const onUp = () => {
                          setEditorRatio(liveRatio);
                          // Arm second pull only if we finished parked at soft max
                          if (reachedSoftMax && !editorFull) {
                            softMaxArmedRef.current = true;
                            setEditorRatio(EDITOR_SOFT_MAX);
                          }
                          cleanup();
                        };
                        window.addEventListener("pointermove", onMove);
                        window.addEventListener("pointerup", onUp);
                        window.addEventListener("pointercancel", onUp);
                      }}
                    />
                  ) : null}
                </>
              ) : null}

              {editorOpen && editorFull ? null : (
                <div
                  className="chat-col"
                  style={
                    editorOpen
                      ? {
                          flex: `0 0 ${(1 - editorRatio) * 100}%`,
                          minWidth: 0,
                        }
                      : { flex: "1 1 0" }
                  }
                >
                  {effectiveMode === "rooms" ? (
                    <RoomStage />
                  ) : (
                    <ChatPanel
                      onOpenSettings={() => setSettingsOpen(true)}
                      onOpenFile={onOpenFile}
                    />
                  )}
                </div>
              )}
            </div>
            )}
          </main>
          )}

          {layout.changesOpen ? (
            <>
              {settingsOpen ? null : (
                <div
                  className="resize-handle resize-handle-changes"
                  role="separator"
                  aria-orientation="vertical"
                  tabIndex={-1}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const el = e.currentTarget;
                    const row = el.parentElement as HTMLElement;
                    const rowW = row.getBoundingClientRect().width || 1;
                    const sidebarW = layout.sidebarOpen
                      ? layout.sidebarWidth
                      : 0;
                    const avail = Math.max(320, rowW - sidebarW);
                    // 会话栏最低 35%：变更栏软上限 = 65%
                    const softMax = Math.max(220, Math.round(avail * 0.65));
                    const wasFull = changesFull;
                    const startX = e.clientX;
                    const startSize = wasFull ? avail : layout.changesWidth;
                    // 二次拉伸：上一次拖动停在软上限后，再次拖才允许全覆盖
                    const allowFullCover =
                      !wasFull &&
                      changesArmedRef.current &&
                      startSize >= softMax - 1;
                    changesArmedRef.current = false;
                    let reachedSoftMax = !wasFull && startSize >= softMax - 1;
                    const pointerId = e.pointerId;
                    try {
                      el.setPointerCapture(pointerId);
                    } catch {
                      // ignore
                    }
                    document.body.classList.add("is-resizing-col");
                    const onMove = (ev: PointerEvent) => {
                      if (ev.pointerId !== pointerId) return;
                      ev.preventDefault();
                      // grip 在面板左侧：向左拖 → 变宽
                      const raw = startSize + (startX - ev.clientX);
                      if (wasFull) {
                        // 全覆盖态：向右拖退出覆盖
                        if (raw >= avail - 8) return;
                        setChangesFull(false);
                        setChangesWidth(Math.min(raw, avail - 48));
                        return;
                      }
                      if (raw <= softMax) {
                        reachedSoftMax = raw >= softMax - 1;
                        setChangesWidth(raw);
                        return;
                      }
                      reachedSoftMax = true;
                      if (allowFullCover) {
                        setChangesFull(true);
                        changesArmedRef.current = false;
                        cleanup();
                        return;
                      }
                      // 第一次：停在软上限（松手后再拖才全覆盖）
                      setChangesWidth(softMax);
                    };
                    const cleanup = () => {
                      document.body.classList.remove("is-resizing-col");
                      window.removeEventListener("pointermove", onMove);
                      window.removeEventListener("pointerup", onUp);
                      window.removeEventListener("pointercancel", onUp);
                    };
                    const onUp = (ev: PointerEvent) => {
                      if (ev.pointerId !== pointerId) return;
                      try {
                        el.releasePointerCapture(pointerId);
                      } catch {
                        // ignore
                      }
                      if (!wasFull && reachedSoftMax) {
                        changesArmedRef.current = true;
                        setChangesWidth(softMax);
                      }
                      cleanup();
                    };
                    window.addEventListener("pointermove", onMove, {
                      passive: false,
                    });
                    window.addEventListener("pointerup", onUp);
                    window.addEventListener("pointercancel", onUp);
                  }}
                  onDragStart={(e) => e.preventDefault()}
                />
              )}
              <aside
                className="panel panel-changes"
                style={
                  changesFull
                    ? { flex: "1 1 0", width: "auto" }
                    : {
                        width: layout.changesWidth,
                        flex: `0 0 ${layout.changesWidth}px`,
                      }
                }
              >
                <ChangesPanel onOpenFile={onOpenFile} />
              </aside>
            </>
          ) : null}
        </div>

        <div
          className={
            layout.terminalOpen
              ? "terminal-resize-slot"
              : "terminal-resize-slot is-collapsed"
          }
        >
          {settingsOpen || !layout.terminalOpen ? null : (
            <ResizeHandle
              axis="terminal"
              size={layout.terminalHeight}
              onResize={setTerminalHeight}
            />
          )}
        </div>
        <TerminalPanel
          open={layout.terminalOpen}
          height={layout.terminalOpen ? layout.terminalHeight : 0}
        />
      </div>

      <PermissionModal />
      <RoomPermAskModal />
      <UserPromptModal />
      {tabMenu
        ? createPortal(
            <div
              className="tab-menu-overlay"
              onClick={() => setTabMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu(null);
              }}
            >
              <div
                className="tab-menu"
                role="menu"
                style={{ left: tabMenu.x, top: tabMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    togglePinTab(tabMenu.tab);
                    setTabMenu(null);
                  }}
                >
                  {pinnedTabs.has(tabMenu.tab) ? "取消固定" : "固定"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeRightTabs(tabMenu.tab);
                    setTabMenu(null);
                  }}
                >
                  关闭右侧标签
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeOtherTabs(tabMenu.tab);
                    setTabMenu(null);
                  }}
                >
                  关闭其他
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeAllUnpinnedTabs();
                    setTabMenu(null);
                  }}
                >
                  全部关闭
                </button>
                <div className="tab-menu-sep" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (projectPath) {
                      void getDesktop().revealFile(
                        `${projectPath.replace(/[\\/]+$/, "")}/${tabMenu.tab}`,
                      );
                    }
                    setTabMenu(null);
                  }}
                >
                  在文件管理器中显示
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
      <OnboardingModal open={needsOnboarding} />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <FileSearchModal
        open={fileSearchOpen}
        onClose={() => setFileSearchOpen(false)}
        onOpenFile={onOpenFile}
      />
      <ChangelogModal
        open={changelogOpen}
        onClose={() => setChangelogOpen(false)}
      />
    </div>
  );
}
