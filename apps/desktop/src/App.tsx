import React, { useEffect, useState } from "react";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import {
  TitlebarToggles,
  ThemeToggle,
  ResizeHandle,
} from "./components/LayoutChrome";
import { PermissionModal } from "./components/PermissionModal";
import { UserPromptModal } from "./components/UserPromptModal";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { OnboardingModal } from "./components/OnboardingModal";
import { ErrorBanner } from "./components/ErrorBanner";
import { getDesktop } from "./lib/desktop-api";
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
  setTheme,
  useAppStore,
} from "./state/store";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settings = useAppStore((s) => s.settings);
  const needsOnboarding = settings != null && !settings.hasToken;

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
  }, []);

  // Apply theme on load + whenever settings change; follow OS in system mode.
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

  // Slash /diff and other UI can request panel toggles without prop drilling.
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
        {/* Space for Windows caption buttons (titleBarOverlay). */}
        <div className="titlebar-caption-space" aria-hidden />
      </div>
      <ErrorBanner />

      <div
        className={
          layout.terminalOpen ? "workspace workspace-terminal-open" : "workspace"
        }
        style={workspaceStyle}
      >
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
                <SessionList onOpenSettings={() => setSettingsOpen(true)} />
              </aside>
              <ResizeHandle
                axis="sidebar"
                size={layout.sidebarWidth}
                onResize={setSidebarWidth}
              />
            </>
          ) : null}

          <main className="panel panel-chat">
            <ChatPanel onOpenSettings={() => setSettingsOpen(true)} />
          </main>

          {layout.changesOpen ? (
            <>
              <ResizeHandle
                axis="changes"
                size={layout.changesWidth}
                onResize={setChangesWidth}
              />
              <aside
                className="panel panel-changes"
                style={{ width: layout.changesWidth, flex: `0 0 ${layout.changesWidth}px` }}
              >
                <ChangesPanel />
              </aside>
            </>
          ) : null}
        </div>

        {layout.terminalOpen ? (
          <>
            <ResizeHandle
              axis="terminal"
              size={layout.terminalHeight}
              onResize={setTerminalHeight}
            />
            <TerminalPanel open height={layout.terminalHeight} />
          </>
        ) : (
          <TerminalPanel open={false} height={0} />
        )}
      </div>

      <PermissionModal />
      <UserPromptModal />
      <OnboardingModal open={needsOnboarding} />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
