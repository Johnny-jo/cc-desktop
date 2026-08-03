import React, { useEffect, useRef, useState } from "react";
import type { ChatItem } from "@claude-desktop/shared";
import { ToolCard } from "./ToolCard";

/** Long skill / system dumps that slipped through as plain text. */
function looksLikeSkillDump(text: string): boolean {
  if (text.length < 200) return false;
  return (
    /Base directory for this skill/i.test(text) ||
    /<SUBAGENT-STOP>/i.test(text) ||
    /<EXTREMELY-IMPORTANT>/i.test(text) ||
    (/Launching skill:/i.test(text) && text.length > 300)
  );
}

function skillLabel(text: string): string {
  const dir = text.match(/Base directory for this skill:\s*(.+)/i);
  if (dir?.[1]) {
    const parts = dir[1].trim().split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? "Skill content";
  }
  return "Skill content";
}

function CollapsedTextCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const label = skillLabel(text);
  return (
    <div className="skill-dump-card">
      <button
        type="button"
        className="skill-dump-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
        <span className="skill-dump-title">Skill</span>
        <span className="skill-dump-summary" title={label}>
          {label}
        </span>
        <span className="tool-status status-done">done</span>
      </button>
      {open ? <pre className="skill-dump-body">{text}</pre> : null}
    </div>
  );
}

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

        // Skill / long injected text → collapsible card (never dump open).
        if (
          role === "assistant" &&
          !item.streaming &&
          looksLikeSkillDump(item.text)
        ) {
          return (
            <div key={item.id} className="message-row skill-row">
              <CollapsedTextCard text={item.text} />
            </div>
          );
        }

        return (
          <div
            key={item.id}
            className={`message-row role-${role}${item.streaming ? " streaming" : ""}`}
          >
            {role === "user" ? (
              <div className="bubble bubble-user" title={item.text}>
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
