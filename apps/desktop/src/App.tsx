import React, { useEffect, useState } from "react";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { PermissionModal } from "./components/PermissionModal";
import { UserPromptModal } from "./components/UserPromptModal";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { OnboardingModal } from "./components/OnboardingModal";
import { ErrorBanner } from "./components/ErrorBanner";
import {
  bootstrapStore,
  flushAllTranscripts,
  useAppStore,
} from "./state/store";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);
  const settings = useAppStore((s) => s.settings);
  // Show onboarding until a gateway token is stored (first run / fresh install).
  const needsOnboarding = settings != null && !settings.hasToken;

  useEffect(() => {
    void bootstrapStore();
  }, []);

  // Flush chat transcripts before the window dies (dev reload / quit).
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
      {/* Frameless window drag strip (matches titleBarOverlay height). */}
      <div className="app-titlebar" aria-hidden />
      <ErrorBanner />
      <div className={changesOpen ? "main" : "main main-no-changes"}>
        <aside className="panel panel-sessions">
          <SessionList onOpenSettings={() => setSettingsOpen(true)} />
        </aside>
        <main className="panel panel-chat">
          <ChatPanel
            changesOpen={changesOpen}
            onToggleChanges={() => setChangesOpen((v) => !v)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </main>
        {changesOpen ? (
          <aside className="panel panel-changes">
            <ChangesPanel />
          </aside>
        ) : null}
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
