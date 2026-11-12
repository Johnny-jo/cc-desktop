import React, { useEffect, useRef, useState } from "react";
import type { ChatItem } from "@claude-desktop/shared";
import { useI18n } from "../i18n/useI18n";
import { userMessageDate, userMessageText } from "../lib/user-message";
import { requestUserMessageDraft } from "../state/store";

export function UserMessageActions({ item, sessionId, running, children }: {
  item: Extract<ChatItem, { kind: "text" }>;
  sessionId: string | null;
  running: boolean;
  children?: React.ReactNode;
}) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  const timestamp = userMessageDate(item);
  const copy = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(userMessageText(item) || item.attachments?.map(attachment => attachment.name).join("\n") || "");
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <div className="user-message-actions">
      {timestamp && (
        <time className="user-message-time" dateTime={timestamp.toISOString()} title={timestamp.toLocaleString(locale)}>
          {timestamp.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", hour12: false })}
        </time>
      )}
      <button type="button" className={`user-message-action${copied ? " copied" : ""}`}
        title={copied ? t.common.copied : t.common.copy} aria-label={copied ? t.common.copied : t.common.copy}
        onClick={() => void copy()}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          {copied ? <path d="m4 10 4 4 8-9" /> : <>
            <rect x="3" y="6" width="10" height="11" rx="2" />
            <path d="M7 6V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2" />
          </>}
        </svg>
      </button>
      {!running && sessionId && (
        <button type="button" className="user-message-action" title={t.chat.editMessage} aria-label={t.chat.editMessage}
          onClick={() => requestUserMessageDraft(sessionId, item.id)}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m12.5 3.5 4 4M3 17l1-5L13.5 2.5a2.8 2.8 0 0 1 4 4L8 16l-5 1Z" />
          </svg>
        </button>
      )}
      {children}
      {copyFailed && <span className="user-message-copy-error" role="status">{t.common.copyFailed}</span>}
    </div>
  );
}
