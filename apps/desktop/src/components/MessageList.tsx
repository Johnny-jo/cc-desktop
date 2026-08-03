import React, { useEffect, useRef } from "react";
import type { ChatItem } from "@claude-desktop/shared";
import { ToolCard } from "./ToolCard";

export function MessageList({ items }: { items: ChatItem[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="message-list empty">
        <div className="empty-hero">
          <div className="empty-hero-title">How can I help you today?</div>
          <p className="empty-hero-sub">
            Open a project, then send a message to start a session.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list">
      {items.map((item) => {
        if (item.kind === "tool") {
          return (
            <div key={item.id} className="message-row tool-row">
              <ToolCard tool={item.tool} />
            </div>
          );
        }

        const role = item.role;
        return (
          <div
            key={item.id}
            className={`message-row role-${role}${item.streaming ? " streaming" : ""}`}
          >
            {role === "user" ? (
              <div className="bubble bubble-user">
                {item.text}
                {item.streaming ? <span className="cursor">▍</span> : null}
              </div>
            ) : role === "system" ? (
              <div className="bubble bubble-system">{item.text}</div>
            ) : (
              <div className="bubble bubble-assistant">
                {item.text}
                {item.streaming ? <span className="cursor">▍</span> : null}
              </div>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
