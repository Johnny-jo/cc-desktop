import React, { useEffect, useState } from "react";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { LayoutChrome, ResizeHandle } from "./components/LayoutChrome";
import { PermissionModal } from "./components/PermissionModal";
import { UserPromptModal } from "./components/UserPromptModal";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { OnboardingModal } from "./components/OnboardingModal";
import { ErrorBanner } from "./components/ErrorBanner";
import { usePanelLayout } from "./hooks/usePanelLayout";
import {
  bootstrapStore,
  flushAllTranscripts,
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

  return (
    <div className="app">
      <div className="app-titlebar" aria-hidden />
      <ErrorBanner />

      <LayoutChrome
        sidebarOpen={layout.sidebarOpen}
        changesOpen={layout.changesOpen}
        terminalOpen={layout.terminalOpen}
        onToggleSidebar={toggleSidebar}
        onToggleChanges={toggleChanges}
        onToggleTerminal={toggleTerminal}
      />

      <div className="workspace">
        <div className="main-row">
          {layout.sidebarOpen ? (
            <>
              <aside
                className="panel panel-sessions"
                style={{ width: layout.sidebarWidth, flex: "0 0 auto" }}
              >
                <SessionList onOpenSettings={() => setSettingsOpen(true)} />
              </aside>
              <ResizeHandle
                axis="sidebar"
                onDrag={(dx) => setSidebarWidth(layout.sidebarWidth + dx)}
              />
            </>
          ) : null}

          <main className="panel panel-chat" style={{ flex: "1 1 auto" }}>
            <ChatPanel onOpenSettings={() => setSettingsOpen(true)} />
          </main>

          {layout.changesOpen ? (
            <>
              <ResizeHandle
                axis="changes"
                onDrag={(dx) => setChangesWidth(layout.changesWidth + dx)}
              />
              <aside
                className="panel panel-changes"
                style={{ width: layout.changesWidth, flex: "0 0 auto" }}
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
              onDrag={(dy) => setTerminalHeight(layout.terminalHeight + dy)}
            />
            <TerminalPanel open height={layout.terminalHeight} />
          </>
        ) : (
          // Keep unmounted shell lifecycle simple when closed.
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
