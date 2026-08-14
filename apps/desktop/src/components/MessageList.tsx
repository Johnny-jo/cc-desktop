import React, { memo, useEffect, useRef, useState } from "react";
import type { ChatItem } from "@claude-desktop/shared";
import { ToolCard } from "./ToolCard";
import { MarkdownBody } from "./MarkdownBody";
import { formatTurnUsageLine } from "../lib/format-usage";
import {
  loadOlderMessages,
  rewindToMessage,
  useAppStore,
} from "../state/store";
import { useI18n } from "../i18n/useI18n";

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

/** Rewind affordance on user bubbles that carry an SDK checkpoint id. */
function RewindButton({ sdkMsgId }: { sdkMsgId: string }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const running = useAppStore((s) => s.running);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!activeSessionId) return null;

  const onClick = async () => {
    if (
      !window.confirm(
        "Rewind to this message? Files return to their state at this point and later conversation is removed.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await rewindToMessage(activeSessionId, sdkMsgId);
      if (!res.ok) setError(res.error ?? "Rewind failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="rewind-btn"
        disabled={busy || running}
        title="Rewind files + conversation to this message"
        onClick={() => void onClick()}
      >
        {busy ? "…" : "↩ rewind"}
      </button>
      {error ? (
        <span className="rewind-error" title={error}>
          {error}
        </span>
      ) : null}
    </>
  );
}

const MessageRow = memo(function MessageRow({ item }: { item: ChatItem }) {
  if (item.kind === "tool") {
    return (
      <div className="message-row tool-row">
        <ToolCard tool={item.tool} />
      </div>
    );
  }

  if (item.kind === "usage") {
    return (
      <div className="message-row usage-row">
        <div className="usage-chip" title="This turn">
          {formatTurnUsageLine(item.usage)}
        </div>
      </div>
    );
  }

  const role = item.role;

  // Skill / long injected text → collapsible card (never dump open).
  if (role === "assistant" && !item.streaming && looksLikeSkillDump(item.text)) {
    return (
      <div className="message-row skill-row">
        <CollapsedTextCard text={item.text} />
      </div>
    );
  }

  return (
    <div
      className={`message-row role-${role}${item.streaming ? " streaming" : ""}`}
    >
      {role === "user" ? (
        <div className="bubble bubble-user" title={item.text}>
          {item.text}
          {item.streaming ? <span className="cursor">▍</span> : null}
          {item.sdkMsgId ? <RewindButton sdkMsgId={item.sdkMsgId} /> : null}
        </div>
      ) : role === "system" ? (
        <div className="bubble bubble-system">{item.text}</div>
      ) : (
        <div className="bubble bubble-assistant">
          <MarkdownBody text={item.text} streaming={item.streaming} />
        </div>
      )}
    </div>
  );
});

function lastItemStreaming(items: ChatItem[]): boolean {
  const last = items[items.length - 1];
  return Boolean(last && last.kind === "text" && last.streaming);
}

/** Mounted tail. Extra pages come from store first, then disk. */
const WINDOW_TAIL = 40;
const WINDOW_STEP = 40;

export function MessageList({
  items,
  sessionId,
  hasMore,
}: {
  items: ChatItem[];
  sessionId: string | null;
  hasMore?: boolean;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [extra, setExtra] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    setExtra(0);
  }, [sessionId]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (lastItemStreaming(items)) {
      list.scrollTop = list.scrollHeight;
      return;
    }
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

  const hiddenInStore = Math.max(0, items.length - WINDOW_TAIL - extra);
  const visible = hiddenInStore > 0 ? items.slice(hiddenInStore) : items;
  const canRevealStore = hiddenInStore > 0;
  const canFetchDisk = Boolean(hasMore && sessionId && !canRevealStore);

  const onLoadOlder = async () => {
    const list = listRef.current;
    const prevHeight = list?.scrollHeight ?? 0;
    const prevTop = list?.scrollTop ?? 0;

    if (canRevealStore) {
      setExtra((n) => n + WINDOW_STEP);
    } else if (canFetchDisk && sessionId) {
      setLoadingOlder(true);
      try {
        await loadOlderMessages(sessionId);
        setExtra((n) => n + WINDOW_STEP);
      } finally {
        setLoadingOlder(false);
      }
    }

    requestAnimationFrame(() => {
      const el = listRef.current;
      if (!el) return;
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
    });
  };

  const remainingHint = canRevealStore
    ? hiddenInStore
    : hasMore
      ? t.chat.loadOlder
      : 0;

  return (
    <div className="message-list" ref={listRef}>
      {canRevealStore || canFetchDisk ? (
        <button
          type="button"
          className="message-load-older"
          disabled={loadingOlder}
          onClick={() => void onLoadOlder()}
        >
          {loadingOlder
            ? t.common.loading
            : canRevealStore
              ? `${t.chat.loadOlder}（${Math.min(WINDOW_STEP, hiddenInStore)}）`
              : t.chat.loadOlder}
        </button>
      ) : null}
      {visible.map((item) => (
        <MessageRow key={item.id} item={item} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
