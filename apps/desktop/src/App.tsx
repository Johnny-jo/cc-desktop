import React, { useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { PermissionModal } from "./components/PermissionModal";
import { bootstrapStore } from "./state/store";

export function App() {
  useEffect(() => {
    void bootstrapStore();
  }, []);

  return (
    <div className="app">
      <TopBar />
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
    </div>
  );
}
