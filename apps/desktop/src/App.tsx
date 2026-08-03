import React, { useEffect, useState } from "react";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { PermissionModal } from "./components/PermissionModal";
import { UserPromptModal } from "./components/UserPromptModal";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ErrorBanner } from "./components/ErrorBanner";
import { bootstrapStore } from "./state/store";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);

  useEffect(() => {
    void bootstrapStore();
  }, []);

  return (
    <div className="app">
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
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
