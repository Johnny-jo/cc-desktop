import React, { useLayoutEffect, useRef, useState } from "react";
import {
  getToolActivityStatus,
  isLiveActivityEntry,
  type ActivityEntry,
} from "../lib/conversation-blocks";
import { requestRevealChange, useAppStore } from "../state/store";
import { useI18n } from "../i18n/useI18n";
import "./ChatActivity.css";

function activityStatusLabel(
  status: ReturnType<typeof getToolActivityStatus>,
  { locale, t }: ReturnType<typeof useI18n>,
): string {
  switch (status) {
    case "running": return t.chat.activityInProgress;
    case "done": return t.chat.activityComplete;
    case "error": return t.chat.activityFailed;
    case "paused": return locale === "zh" ? "已暂停" : "Paused";
    case "stopped": return locale === "zh" ? "已停止" : "Stopped";
    case "unknown": return locale === "zh" ? "状态未知" : "Status unknown";
  }
}

function formatActivityDuration(milliseconds?: number): string | null {
  if (milliseconds == null || !Number.isFinite(milliseconds)) return null;
  if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function ToolActivityIcon({ name }: { name: string }) {
  const normalized = name.toLowerCase();
  const isTool = (toolName: string) =>
    normalized === toolName ||
    normalized.endsWith(`:${toolName}`) ||
    normalized.endsWith(`__${toolName}`);

  if (["todowrite", "taskcreate", "tasklist", "taskget"].some(isTool)) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <rect x="2.5" y="2" width="11" height="12" rx="2" />
        <path d="m4.5 5.2 1 1 1.5-1.5M8.5 5.5h2.5M4.5 9h2M8.5 9h2.5M4.5 11.5h2M8.5 11.5h2.5" />
      </svg>
    );
  }

  if (["taskupdate", "update_plan"].some(isTool)) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <path d="M12.8 6A5 5 0 0 0 4.4 3.8L2.5 5.5M2.5 2.5v3h3M3.2 10a5 5 0 0 0 8.4 2.2l1.9-1.7M13.5 13.5v-3h-3" />
        <path d="m6 8 1.4 1.4L10 6.8" />
      </svg>
    );
  }

  if (["agent", "task"].some(isTool)) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <path d="M4 4.5v7M4 8.5h4a4 4 0 0 0 4-4" />
        <circle cx="4" cy="3" r="1.5" />
        <circle cx="4" cy="13" r="1.5" />
        <circle cx="12" cy="3" r="1.5" />
      </svg>
    );
  }

  if (isTool("askuserquestion")) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <path d="M3.1 2.8h9.8a1.6 1.6 0 0 1 1.6 1.6v5.2a1.6 1.6 0 0 1-1.6 1.6H7l-3.8 2.3.7-2.3h-.8a1.6 1.6 0 0 1-1.6-1.6V4.4a1.6 1.6 0 0 1 1.6-1.6Z" />
        <path d="M6.2 6a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.2M8 10.2h.01" />
      </svg>
    );
  }

  if (isTool("grep")) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <circle cx="6.6" cy="6.6" r="4.4" />
        <path d="m9.8 9.8 3.6 3.6M4.6 5.4h4M4.6 7.5h2.8" />
      </svg>
    );
  }

  if (isTool("websearch")) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <circle cx="6.6" cy="6.6" r="4.5" />
        <path d="M2.1 6.6h9M6.6 2.1a6.4 6.4 0 0 1 0 9M6.6 2.1a6.4 6.4 0 0 0 0 9m3.2-1.3 3.6 3.6" />
      </svg>
    );
  }

  if (normalized.includes("write") || normalized.includes("edit")) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <path d="m10.8 2.4 2.8 2.8-7.4 7.4-3.4.6.6-3.4 7.4-7.4Z" />
        <path d="m9.7 3.5 2.8 2.8" />
      </svg>
    );
  }

  if (
    normalized.includes("delete") ||
    normalized.includes("remove") ||
    normalized.includes("unlink")
  ) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <path d="m6.1 3-3.6 5.2a1.7 1.7 0 0 0 .3 2.3l2.4 1.9h4.1l4.2-6L9.2 3H6.1Z" />
        <path d="m5.2 12.4 4.1-5.8" />
      </svg>
    );
  }

  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("terminal") ||
    normalized.includes("exec")
  ) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <rect x="1.8" y="2.5" width="12.4" height="11" rx="2" />
        <path d="m4.2 6 2 2-2 2M8 10h3.5" />
      </svg>
    );
  }

  if (isTool("read")) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <path d="M4.8 2.5h6.1a2 2 0 0 1 2 2v9H4.8a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" />
        <path d="M5.3 2.5v11M7.5 5.2h3" />
      </svg>
    );
  }

  if (normalized.includes("skill")) {
    return (
      <svg className="activity-step-icon" viewBox="0 0 16 16" aria-hidden>
        <path d="M8 4.3C6.7 3 4.6 2.6 2.5 3.1v9.2c2.1-.5 4.2-.1 5.5 1.2V4.3Z" />
        <path d="M8 4.3C9.3 3 11.4 2.6 13.5 3.1v9.2c-2.1-.5-4.2-.1-5.5 1.2" />
      </svg>
    );
  }

  return null;
}

function ToolActivityStep({
  entry,
  current,
}: {
  entry: Extract<ActivityEntry, { kind: "tool" }>;
  current: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const tool = entry.tool;
  const status = getToolActivityStatus(tool);
  const hasDetails = Boolean(tool.resultPreview || tool.todos?.length);
  const isFileEdit = tool.name === "Write" || tool.name === "Edit";

  return (
    <div
      className={`activity-step activity-step-${status}${current ? " current" : ""}`}
      data-item-id={entry.id}
    >
      <button
        type="button"
        className="activity-step-main"
        disabled={!hasDetails}
        aria-expanded={hasDetails ? detailsOpen : undefined}
        onClick={() => hasDetails && setDetailsOpen((value) => !value)}
      >
        {current ? <span className="activity-spinner" aria-hidden /> : null}
        <ToolActivityIcon name={tool.name} />
        <span className="activity-step-name">{tool.name}</span>
        {tool.summary ? (
          <span className="activity-step-summary" title={tool.summary}>
            {tool.summary}
          </span>
        ) : null}
        <span className="activity-step-status">{activityStatusLabel(status, i18n)}</span>
        {current && tool.elapsedSeconds != null ? (
          <span className="activity-step-meta">
            {tool.elapsedSeconds < 10
              ? `${tool.elapsedSeconds.toFixed(1)}s`
              : `${Math.round(tool.elapsedSeconds)}s`}
          </span>
        ) : null}
      </button>
      {detailsOpen ? (
        <div className="activity-step-details">
          {tool.todos?.length ? (
            <ul className="activity-todo-list">
              {tool.todos.map((todo, index) => (
                <li key={index} className={`activity-todo activity-todo-${todo.status}`}>
                  {current && todo.status === "in_progress" ? (
                    <span className="activity-spinner" aria-hidden />
                  ) : null}
                  <span>{todo.content}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {tool.resultPreview ? (
            <pre className="activity-tool-preview">{tool.resultPreview}</pre>
          ) : null}
          {isFileEdit && activeSessionId ? (
            <button
              type="button"
              className="activity-view-change"
              onClick={() =>
                requestRevealChange({
                  sessionId: activeSessionId,
                  toolUseId: tool.id,
                  path: tool.summary || undefined,
                })
              }
            >
              {t.changes.viewChanges}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingActivityEvent({
  entry,
  current,
}: {
  entry: Extract<ActivityEntry, { kind: "thinking" }>;
  current: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const text = entry.text || t.chat.activityThinkingNow;

  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => {
      const overflowing = node.scrollWidth > node.clientWidth + 1;
      setCanExpand((previous) =>
        previous === overflowing ? previous : overflowing,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div
      className={`activity-step activity-thinking-event${
        current ? " current" : " activity-step-done"
      }${expanded ? " expanded" : ""}`}
      data-item-id={entry.id}
    >
      <button
        type="button"
        className={`activity-thinking-toggle${canExpand ? "" : " is-static"}`}
        disabled={!canExpand}
        aria-expanded={canExpand ? expanded : undefined}
        aria-label={
          canExpand
            ? expanded
              ? t.chat.activityCollapseThinking
              : t.chat.activityExpandThinking
            : undefined
        }
        onClick={() => canExpand && setExpanded((value) => !value)}
      >
        {current ? <span className="activity-spinner" aria-hidden /> : null}
        <span ref={textRef} className="activity-thinking-text">{text}</span>
        {current ? <span className="activity-step-status">{t.chat.activityInProgress}</span> : null}
        {canExpand ? (
          <span className="activity-thinking-chevron" aria-hidden>
            <svg viewBox="0 0 16 16">
              <path d="m6 3 5 5-5 5" />
            </svg>
          </span>
        ) : null}
      </button>
    </div>
  );
}

function CompactionActivityEvent({ id }: { id: string }) {
  const { t } = useI18n();

  return (
    <div
      className="activity-step activity-step-done activity-compaction-event"
      data-item-id={id}
    >
      <span className="activity-compaction-icon" aria-hidden>
        <svg viewBox="0 0 16 16">
          <path d="M5.5 2.5H3.8A1.3 1.3 0 0 0 2.5 3.8v1.7M10.5 2.5h1.7a1.3 1.3 0 0 1 1.3 1.3v1.7M5.5 13.5H3.8a1.3 1.3 0 0 1-1.3-1.3v-1.7M10.5 13.5h1.7a1.3 1.3 0 0 0 1.3-1.3v-1.7" />
          <path d="m5 8 2-2M5 8l2 2M11 8 9 6M11 8l-2 2" />
        </svg>
      </span>
      <span>{t.chat.activityContextCompacted}</span>
    </div>
  );
}

export function ChatActivity({
  id,
  entries: allEntries,
  durationMs,
  live = false,
}: {
  id: string;
  entries: ActivityEntry[];
  durationMs?: number;
  live?: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  // Only the user changes archive expansion. Live progress has its own body.
  const [open, setOpen] = useState(false);
  const entries = allEntries.filter(entry => isLiveActivityEntry(entry) === live);
  if (entries.length === 0) return null;

  const statuses = entries
    .filter(entry => entry.kind === "tool")
    .map(entry => getToolActivityStatus(entry.tool));
  const failureCount = statuses.filter(status => status === "error").length;
  const failed = failureCount > 0;
  const unresolved = statuses.find(status => status === "unknown" || status === "paused" || status === "stopped");
  const status = live ? "running" : failed ? "error" : unresolved ?? "done";
  const thinkingCount = entries.filter(entry => entry.kind === "thinking").length;
  const toolCount = statuses.length;
  const hasCompaction = entries.some(entry => entry.kind === "compaction");
  const duration = formatActivityDuration(durationMs);
  const summary = [
    thinkingCount > 0
      ? t.chat.activityThinkingCount.replace("{count}", String(thinkingCount))
      : null,
    toolCount > 0
      ? t.chat.activityToolCount.replace("{count}", String(toolCount))
      : null,
    duration ? t.chat.activityDuration.replace("{duration}", duration) : null,
  ].filter(Boolean).join(" · ") || (hasCompaction ? t.chat.activityContextCompacted : "");
  const bodyId = `${id}-body`;
  const heading = (
    <>
      <span className="activity-group-title">
        {live ? t.chat.activityRunning : t.chat.activityTitle}
      </span>
      <span className="activity-group-summary">{summary}</span>
      {!live ? (
        <span className="activity-chevron" aria-hidden>
          <svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>
        </span>
      ) : null}
      <span className={`activity-group-status status-${status}`}>
        {failed
          ? t.chat.activityFailedCount.replace("{count}", String(failureCount))
          : activityStatusLabel(status, i18n)}
      </span>
    </>
  );

  return (
    <div
      className={`chat-activity activity-group${open || live ? " open" : ""}${live ? " active live" : ""}${failed ? " failed" : ""}`}
      data-item-id={id}
    >
      {live ? (
        <div className="activity-group-heading">{heading}</div>
      ) : (
        <button
          type="button"
          className="activity-group-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          title={open ? t.chat.activityCollapse : t.chat.activityExpand}
          onClick={() => setOpen(value => !value)}
        >
          {heading}
        </button>
      )}
      {open || live ? (
        <div id={bodyId} className="activity-group-body">
          {entries.map(entry => {
            if (entry.kind === "compaction") {
              return <CompactionActivityEvent key={entry.id} id={entry.id} />;
            }
            if (entry.kind === "tool") {
              return <ToolActivityStep key={entry.id} entry={entry} current={live} />;
            }
            return <ThinkingActivityEvent key={entry.id} entry={entry} current={live} />;
          })}
        </div>
      ) : null}
    </div>
  );
}
