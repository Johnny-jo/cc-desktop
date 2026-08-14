import React, { useCallback, useEffect, useRef, useState } from "react";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import {
  TitlebarToggles,
  ThemeToggle,
  ChangelogToggle,
  CliModeToggle,
  ResizeHandle,
} from "./components/LayoutChrome";
import { ChangelogModal } from "./components/ChangelogModal";
import { PermissionModal } from "./components/PermissionModal";
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
import {
  bindRoomEvents,
  refreshRooms,
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

function fileName(rel: string): string {
  return rel.split(/[/\\]/).pop() ?? rel;
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const settings = useAppStore((s) => s.settings);
  const needsOnboarding = settings != null && !settings.hasToken;
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const cliMode = useAppStore((s) => s.cliMode);
  const activeRoomId = useRoomStore((s) => s.activeRoomId);

  // ---- File tree + multi-tab editor pane ----
  const [fileTreeOpen, setFileTreeOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorTabs, setEditorTabs] = useState<string[]>([]);
  const [activeEditor, setActiveEditor] = useState<string | null>(null);
  /** Editor pane width as fraction of (chat+editor) area */
  const [editorRatio, setEditorRatio] = useState(EDITOR_DEFAULT_RATIO);
  const [editorFull, setEditorFull] = useState(false);
  /**
   * Secondary-pull gate: after a drag parks at soft-max (65%), the *next*
   * drag that starts already at soft-max may enter full-cover. Same continuous
   * drag never covers — user must release and pull again.
   */
  const softMaxArmedRef = useRef(false);
  const tabsStripRef = useRef<HTMLDivElement | null>(null);
  const dragTabRef = useRef<string | null>(null);

  const editorOpen = editorTabs.length > 0 && activeEditor != null;

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
    toggleSidebar,
    toggleChanges,
    toggleTerminal,
    setSidebarWidth,
    setChangesWidth,
    setTerminalHeight,
  } = usePanelLayout();

  useEffect(() => {
    void bootstrapStore();
    void refreshRooms();
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
        <ThemeToggle
          isLight={effectiveTheme(settings?.theme) === "light"}
          onToggle={() => void setTheme(nextTheme(settings?.theme))}
        />
        <div className="titlebar-right">
          <CliModeToggle
            active={cliMode}
            onClick={() => {
              const next = !cliMode;
              toggleCliMode();
              if (!next && activeSessionId) {
                void selectSession(activeSessionId);
              }
            }}
          />
          <ChangelogToggle onClick={() => setChangelogOpen(true)} />
        </div>
        <div className="titlebar-caption-space" aria-hidden />
      </div>
      <ErrorBanner />
      <UpdateBanner />

      <div
        className={
          layout.terminalOpen && !cliMode
            ? "workspace workspace-terminal-open"
            : "workspace"
        }
        style={workspaceStyle}
      >
        {cliMode ? (
          <CliModePage />
        ) : (
        <div className="main-row">
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
                  onOpenSettings={() => setSettingsOpen(true)}
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

          <main className="panel panel-chat">
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
                          >
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

                    {editorTabs.map((tab) => (
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
                  {activeRoomId ? (
                    <RoomStage />
                  ) : (
                    <ChatPanel onOpenSettings={() => setSettingsOpen(true)} />
                  )}
                </div>
              )}
            </div>
          </main>

          {layout.changesOpen ? (
            <>
              {settingsOpen ? null : (
                <ResizeHandle
                  axis="changes"
                  size={layout.changesWidth}
                  onResize={setChangesWidth}
                />
              )}
              <aside
                className="panel panel-changes"
                style={{
                  width: layout.changesWidth,
                  flex: `0 0 ${layout.changesWidth}px`,
                }}
              >
                <ChangesPanel />
              </aside>
            </>
          ) : null}
        </div>
        )}

        {!cliMode && layout.terminalOpen ? (
          <>
            {settingsOpen ? null : (
              <ResizeHandle
                axis="terminal"
                size={layout.terminalHeight}
                onResize={setTerminalHeight}
              />
            )}
            <TerminalPanel open height={layout.terminalHeight} />
          </>
        ) : !cliMode ? (
          <TerminalPanel open={false} height={0} />
        ) : null}
      </div>

      <PermissionModal />
      <UserPromptModal />
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
