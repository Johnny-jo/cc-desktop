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
        <p className="muted">Send a message to start a session.</p>
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

        return (
          <div
            key={item.id}
            className={`message-row role-${item.role}${item.streaming ? " streaming" : ""}`}
          >
            <div className="message-role">{item.role}</div>
            <div className="message-body">
              {item.text}
              {item.streaming ? <span className="cursor">▍</span> : null}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
