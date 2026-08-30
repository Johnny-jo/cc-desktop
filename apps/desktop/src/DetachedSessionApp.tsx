import React from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DetachedWindowShell } from "./DetachedWindowShell";

export default function DetachedSessionApp() {
  return (
    <DetachedWindowShell>
      {(openSettings) => (
        <ChatPanel onOpenSettings={openSettings} />
      )}
    </DetachedWindowShell>
  );
}
