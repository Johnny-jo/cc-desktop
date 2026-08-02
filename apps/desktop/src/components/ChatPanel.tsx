import React from "react";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { useAppStore } from "../state/store";

export function ChatPanel() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const itemsBySession = useAppStore((s) => s.itemsBySession);
  const sessions = useAppStore((s) => s.sessions);
  const running = useAppStore((s) => s.running);

  const items = activeSessionId ? (itemsBySession[activeSessionId] ?? []) : [];
  const active = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>{active ? active.title : "New chat"}</span>
        {running ? <span className="badge running">running</span> : null}
      </div>
      <MessageList items={items} />
      <Composer />
    </div>
  );
}
