import React, { useEffect, useState } from "react";
import { TopBar } from "./components/TopBar";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { PermissionModal } from "./components/PermissionModal";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ErrorBanner } from "./components/ErrorBanner";
import { bootstrapStore } from "./state/store";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void bootstrapStore();
  }, []);

  return (
    <div className="app">
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />
      <ErrorBanner />
      <div className="main">
        <div className="panel panel-sessions">
          <SessionList />
        </div>
        <div className="panel panel-chat">
          <ChatPanel />
        </div>
        <div className="panel panel-changes">
          <ChangesPanel />
        </div>
      </div>
      <PermissionModal />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
