import React, { useEffect, useRef, useState } from "react";
import type { ChatItem, TurnOutcome } from "@claude-desktop/shared";
import type { Messages } from "../i18n";
import { useI18n } from "../i18n/useI18n";

type TurnTiming = {
  sessionId: string;
  startAt: number;
  endAt?: number;
};

/** Localized "37秒" / "2分05秒" from a second count. */
function formatElapsed(totalSeconds: number, chat: Messages["chat"]): string {
  if (totalSeconds < 60) {
    return chat.turnStatusSeconds.replace("{seconds}", String(totalSeconds));
  }
  return chat.turnStatusMinutesSeconds
    .replace("{minutes}", String(Math.floor(totalSeconds / 60)))
    .replace("{seconds}", String(totalSeconds % 60).padStart(2, "0"));
}

/** Static completion marker for a finished turn (history turns included). */
export function TurnDoneRow({ durationMs, outcome }: { durationMs?: number; outcome?: TurnOutcome }) {
  const { t, locale } = useI18n();
  const label = outcome === "interrupted" ? (locale === "zh" ? "已中断" : "Interrupted")
    : outcome === "cancelled" ? (locale === "zh" ? "已取消" : "Cancelled")
    : outcome === "failed" ? (locale === "zh" ? "执行失败" : "Failed")
    : outcome === "completed" ? t.chat.turnStatusDone : (locale === "zh" ? "已结束" : "Ended");
  return (
    <div className={`turn-status turn-status-${outcome ?? "done"}`} role="status">
      <span className="turn-status-label">{label}</span>
      {durationMs != null ? (
        <span className="turn-status-time">
          {formatElapsed(Math.max(0, Math.round(durationMs / 1000)), t.chat)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The server has started streaming content back once any assistant activity
 * (answer text, thinking block, or tool call) lands after the latest user
 * message. Scanning from the end keeps this O(recent items).
 */
function hasAssistantActivity(items: ChatItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "text" && item.role === "user") return false;
    if (item.kind === "tool") return true;
    if (item.kind === "text" && item.role === "assistant") return true;
  }
  return false;
}

/**
 * Live turn lifecycle row for the latest turn, rendered inside the transcript
 * right below the user message and above that turn's activity group:
 * thinking (awaiting first content) -> processing (streaming) -> done.
 * Without live timing (e.g. transcript restored from disk) it falls back to
 * the static completion marker, like any other finished turn.
 */
export function TurnStatusBar({
  sessionId,
  running,
  items,
  done,
  doneDurationMs,
  outcome,
}: {
  sessionId: string | null;
  running: boolean;
  items: ChatItem[];
  /** This turn produced assistant output (drives the static fallback). */
  done?: boolean;
  /** SDK-measured turn duration for the persisted completion marker. */
  doneDurationMs?: number;
  outcome?: TurnOutcome;
}) {
  const { t } = useI18n();
  const timingRef = useRef<TurnTiming | null>(null);
  const [timing, setTiming] = useState<TurnTiming | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!sessionId) return;
    const current = timingRef.current;
    if (running) {
      // A new turn starts when the session runs with no open timing.
      if (!current || current.sessionId !== sessionId || current.endAt != null) {
        const next = { sessionId, startAt: Date.now() };
        timingRef.current = next;
        setTiming(next);
      }
      setNow(Date.now());
      const timer = window.setInterval(() => setNow(Date.now()), 500);
      return () => window.clearInterval(timer);
    }
    // running -> idle/error: freeze the elapsed time of the finished turn.
    if (current && current.sessionId === sessionId && current.endAt == null) {
      const frozen = { ...current, endAt: Date.now() };
      timingRef.current = frozen;
      setTiming(frozen);
    }
  }, [sessionId, running]);

  if (!running || !sessionId || !timing || timing.sessionId !== sessionId) {
    return done || outcome ? <TurnDoneRow durationMs={doneDurationMs} outcome={outcome} /> : null;
  }

  const phase = running
    ? hasAssistantActivity(items)
      ? "processing"
      : "thinking"
    : "done";
  const elapsedSeconds = Math.max(
    0,
    Math.floor(((timing.endAt ?? now) - timing.startAt) / 1000),
  );
  const label =
    phase === "thinking"
      ? t.chat.turnStatusThinking
      : phase === "processing"
        ? t.chat.turnStatusProcessing
        : t.chat.turnStatusDone;

  return (
    <div className={`turn-status turn-status-${phase}`} role="status">
      <span className="turn-status-label">{label}</span>
      <span className="turn-status-time">
        {formatElapsed(elapsedSeconds, t.chat)}
      </span>
    </div>
  );
}
