import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatItem, ModelQuotaInfo } from "@claude-desktop/shared";
import { ToolCard } from "./ToolCard";
import { MarkdownBody } from "./MarkdownBody";
import { AttachmentChips } from "./AttachmentChips";
import { formatTurnUsageLine } from "../lib/format-usage";
import {
  loadNewerMessages,
  loadOlderMessages,
  requestRevealChange,
  rewindToMessage,
  selectSession,
  useAppStore,
} from "../state/store";
import { useI18n } from "../i18n/useI18n";
import {
  buildConversationAnchors,
  type ConversationAnchor,
} from "../lib/conversation-navigation";
import { toProjectRel } from "../lib/project-path";

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

function ThinkingBlock({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  const [open, setOpen] = useState(active);

  // Codex-style lifecycle: reveal the reasoning while it is arriving, then
  // fold it when answer generation begins. Completed reasoning stays available
  // for an explicit manual re-open.
  useEffect(() => {
    setOpen(active);
  }, [active]);

  return (
    <div
      className={`msg-thinking${open ? " open" : ""}${active ? " active" : ""}`}
    >
      <button
        type="button"
        className="msg-thinking-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span>{active ? "思考中…" : "思考过程"}</span>
      </button>
      {open ? (
        <div className="msg-thinking-body">{text || "正在组织思路…"}</div>
      ) : null}
    </div>
  );
}

/** Rewind affordance on user bubbles that carry an SDK checkpoint id. */
function RewindButton({ sdkMsgId }: { sdkMsgId: string }) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const running = useAppStore((s) =>
    s.activeSessionId
      ? s.sessions.some((x) => x.id === s.activeSessionId && x.status === "running")
      : false,
  );
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

/** Trailing "[Attached: a, b]" marker embedded in display text by sendMessage;
 * stripped when we render rich chips instead. */
const ATTACHED_TAIL = /\n\n\[Attached: [^\]]*\]\s*$/;

function TurnChangesCard({
  files,
  sessionId,
  onOpenFile,
}: {
  files: Extract<ChatItem, { kind: "changes" }>["files"];
  sessionId: string | null;
  onOpenFile?: (rel: string, line?: number) => void;
}) {
  const { t } = useI18n();
  const projectPath = useAppStore((state) => state.projectPath);
  const [open, setOpen] = useState(true);
  const title =
    files.length === 1
      ? t.changes.editedFilesOne
      : t.changes.editedFiles.replace("{count}", String(files.length));

  const viewChanges = () => {
    if (!sessionId || !files[0]) return;
    requestRevealChange({ sessionId, path: files[0].path });
  };

  return (
    <section className="turn-changes-card">
      <div className="turn-changes-head">
        <span className="turn-changes-icon" aria-hidden>
          <svg viewBox="0 0 20 20">
            <rect x="4.25" y="3" width="11.5" height="14" rx="2" />
            <path d="M10 7.25v5.5M7.25 10h5.5" />
          </svg>
        </span>
        <span className="turn-changes-title">
          <strong>{title}</strong>
          <button
            type="button"
            className="turn-changes-view"
            onClick={viewChanges}
            disabled={!sessionId}
          >
            {t.changes.viewChanges}
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M6 3.5h6.5V10M12.5 3.5L6 10" />
            </svg>
          </button>
        </span>
      </div>
      {open ? (
        <div className="turn-changes-files">
          {files.map((file) => {
            const rel = toProjectRel(projectPath, file.path);
            const label = rel ?? file.path;
            return (
              <button
                key={file.path}
                type="button"
                className="turn-change-file"
                disabled={!rel || !onOpenFile}
                title={
                  rel
                    ? t.changes.openAtLine.replace("{line}", String(file.line))
                    : file.path
                }
                onClick={() => {
                  if (rel) onOpenFile?.(rel, file.line);
                }}
              >
                <span className="turn-change-path">{label}</span>
                <span
                  className="turn-change-stats"
                  aria-label={`+${file.additions} -${file.deletions}`}
                >
                  <span className="turn-change-add">+{file.additions}</span>
                  <span className="turn-change-del">-{file.deletions}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <button
        type="button"
        className="turn-changes-collapse"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? t.changes.collapseFiles : t.changes.expandFiles}
        <svg viewBox="0 0 16 16" aria-hidden>
          <path d={open ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
        </svg>
      </button>
    </section>
  );
}

const MessageRow = memo(function MessageRow({
  item,
  sessionId,
  onOpenFile,
}: {
  item: ChatItem;
  sessionId: string | null;
  onOpenFile?: (rel: string, line?: number) => void;
}) {
  if (item.kind === "tool") {
    return (
      <div className="message-row tool-row" data-item-id={item.id}>
        <ToolCard tool={item.tool} />
      </div>
    );
  }

  if (item.kind === "usage") {
    return (
      <div className="message-row usage-row" data-item-id={item.id}>
        <div className="usage-chip" title="This turn">
          {formatTurnUsageLine(item.usage)}
        </div>
      </div>
    );
  }

  if (item.kind === "changes") {
    return (
      <div className="message-row turn-changes-row" data-item-id={item.id}>
        <TurnChangesCard
          files={item.files}
          sessionId={sessionId}
          onOpenFile={onOpenFile}
        />
      </div>
    );
  }

  const role = item.role;

  // Skill / long injected text → collapsible card (never dump open).
  if (role === "assistant" && !item.streaming && looksLikeSkillDump(item.text)) {
    return (
      <div className="message-row skill-row" data-item-id={item.id}>
        <CollapsedTextCard text={item.text} />
      </div>
    );
  }

  return (
    <div
      className={`message-row role-${role}${item.streaming ? " streaming" : ""}`}
      data-item-id={item.id}
    >
      {role === "user" ? (
        <div className="bubble bubble-user" title={item.text}>
          {item.attachments?.length
            ? item.text.replace(ATTACHED_TAIL, "")
            : item.text}
          {item.streaming ? <span className="cursor">▍</span> : null}
          {item.sdkMsgId ? <RewindButton sdkMsgId={item.sdkMsgId} /> : null}
          {item.attachments?.length ? (
            <AttachmentChips attachments={item.attachments} onOpenFile={onOpenFile} />
          ) : null}
        </div>
      ) : role === "system" ? (
        <div className="bubble bubble-system">{item.text}</div>
      ) : (
        <div className="bubble bubble-assistant">
          {item.thinkingText || (item.thinking && item.streaming) ? (
            <ThinkingBlock
              text={item.thinkingText ?? ""}
              active={Boolean(item.thinking && item.streaming)}
            />
          ) : null}
          {item.thinking && item.streaming && !item.text ? null : (
            <MarkdownBody text={item.text} streaming={item.streaming} />
          )}
        </div>
      )}
    </div>
  );
});

function lastItemStreaming(items: ChatItem[]): boolean {
  const last = items[items.length - 1];
  return Boolean(last && last.kind === "text" && last.streaming);
}

const SCROLL_LOAD_PX = 80;
const SHOW_JUMP_BOTTOM_PX = 160;

function itemTop(list: HTMLElement, id: string): number | null {
  const node = list.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
  if (!(node instanceof HTMLElement)) return null;
  return node.getBoundingClientRect().top;
}

function ConversationNavigator({
  anchors,
  activeId,
  onNavigate,
  label,
  userLabel,
  assistantLabel,
}: {
  anchors: ConversationAnchor[];
  activeId: string | null;
  onNavigate: (id: string) => void;
  label: string;
  userLabel: string;
  assistantLabel: string;
}) {
  if (anchors.length < 2) return null;
  return (
    <nav
      className="conversation-navigator"
      aria-label={label}
      style={{ height: `${Math.min(340, Math.max(24, anchors.length * 8))}px` }}
    >
      {anchors.map((anchor) => (
        <button
          key={anchor.id}
          type="button"
          className={`conversation-nav-item role-${anchor.role}${
            anchor.id === activeId ? " active" : ""
          }`}
          aria-current={anchor.id === activeId ? "location" : undefined}
          aria-label={`${label}: ${anchor.preview}`}
          title={anchor.id}
          onClick={() => onNavigate(anchor.id)}
        >
          <span className="conversation-nav-tick" aria-hidden />
          <span className="conversation-nav-preview" role="tooltip">
            <span className="conversation-nav-preview-role">
              {anchor.role === "user" ? userLabel : assistantLabel}
            </span>
            <span>{anchor.preview}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}

function ModelQuotaRail({
  quota,
  label,
  staleLabel,
}: {
  quota: ModelQuotaInfo;
  label: string;
  staleLabel: string;
}) {
  const limiting = quota.windows.reduce((worst, window) =>
    window.usedPercent > worst.usedPercent ? window : worst,
  );
  const remaining = Math.max(0, Math.min(100, 100 - limiting.usedPercent));
  const level = remaining <= 5 ? "danger" : remaining <= 20 ? "warn" : "ok";
  return (
    <div
      className={`model-quota-rail model-quota-rail-${level}`}
      role="meter"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(remaining)}
    >
      <span className="model-quota-rail-track" aria-hidden>
        <span
          className="model-quota-rail-fill"
          style={{ height: `${remaining}%` }}
        />
      </span>
      <span className="model-quota-rail-popover">
        <strong>{Math.round(remaining)}% {label}</strong>
        <span>{quota.modelId} · {quota.provider}</span>
        {quota.stale ? <span>{staleLabel}</span> : null}
        {quota.windows.map((window) => (
          <span key={window.label}>
            {window.label}: {Math.round(100 - window.usedPercent)}%
            {window.resetAt ? ` · ${new Date(window.resetAt).toLocaleString()}` : ""}
          </span>
        ))}
        {quota.accountCount > 1 ? <span>{quota.accountCount} accounts</span> : null}
      </span>
    </div>
  );
}

/** Skeleton bubbles shown while a session transcript loads from disk. */
function TranscriptSkeleton() {
  return (
    <div className="message-list skeleton" aria-busy="true">
      {["a", "u", "a", "u", "a"].map((role, i) => (
        <div
          key={i}
          className={`skeleton-row ${role === "u" ? "skeleton-user" : "skeleton-assistant"}`}
        >
          <div className="skeleton-bubble">
            <span className="skeleton-line w-90" />
            <span className="skeleton-line w-70" />
            {role === "a" ? <span className="skeleton-line w-40" /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MessageList({
  items,
  sessionId,
  hasMore,
  hasNewer,
  loading,
  modelQuota,
  onOpenFile,
}: {
  items: ChatItem[];
  sessionId: string | null;
  hasMore?: boolean;
  hasNewer?: boolean;
  /** Disk page in flight — show the skeleton instead of the empty hero. */
  loading?: boolean;
  /** Actual provider quota observed or queried through CPA for the selected model. */
  modelQuota?: ModelQuotaInfo | null;
  /** Open a project-relative file in the in-app editor column. */
  onOpenFile?: (rel: string, line?: number) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const loadingRef = useRef(false);
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const anchors = useMemo(() => buildConversationAnchors(items), [items]);

  const last = items[items.length - 1];
  const pinKey = last
    ? `${last.id}:${last.kind === "text" ? `${last.text.length}:${last.streaming ? 1 : 0}` : last.kind}`
    : "0";

  useEffect(() => {
    if (hasNewer) return;
    const list = listRef.current;
    if (!list) return;
    const pin = () => {
      list.scrollTop = list.scrollHeight;
    };
    pin();
    requestAnimationFrame(pin);
    // pinKey already encodes last-item id / length / streaming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinKey, sessionId, hasNewer]);

  const updateScrollUi = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const distBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const showBottom = Boolean(hasNewer) || distBottom > SHOW_JUMP_BOTTOM_PX;
    setShowJumpToBottom((prev) => (prev === showBottom ? prev : showBottom));

    if (anchors.length === 0) {
      setActiveAnchorId(null);
      return;
    }
    const listTop = list.getBoundingClientRect().top;
    const focusY = listTop + Math.min(list.clientHeight * 0.32, 220);
    let next = anchors[0]!.id;
    for (const anchor of anchors) {
      const node = list.querySelector(
        `[data-item-id="${CSS.escape(anchor.id)}"]`,
      );
      if (!(node instanceof HTMLElement)) continue;
      if (node.getBoundingClientRect().top <= focusY) next = anchor.id;
      else break;
    }
    if (distBottom <= 8 && !hasNewer) next = anchors[anchors.length - 1]!.id;
    setActiveAnchorId((prev) => (prev === next ? prev : next));
  }, [anchors, hasNewer]);

  useEffect(() => {
    const frame = requestAnimationFrame(updateScrollUi);
    return () => cancelAnimationFrame(frame);
  }, [pinKey, sessionId, updateScrollUi]);

  const restoreAnchor = (anchorId: string, prevTop: number) => {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (!el) return;
      const nextTop = itemTop(el, anchorId);
      if (nextTop == null) return;
      el.scrollTop += nextTop - prevTop;
    });
  };

  const onLoadOlder = async () => {
    if (!hasMore || !sessionId || loadingRef.current) return;
    const list = listRef.current;
    const anchorId = items[0]?.id;
    const prevTop = list && anchorId ? itemTop(list, anchorId) : null;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      await loadOlderMessages(sessionId);
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
    if (anchorId && prevTop != null) restoreAnchor(anchorId, prevTop);
  };

  const onLoadNewer = async () => {
    if (!hasNewer || !sessionId || loadingRef.current) return;
    const list = listRef.current;
    const anchorId = items[items.length - 1]?.id;
    const prevTop = list && anchorId ? itemTop(list, anchorId) : null;
    loadingRef.current = true;
    setLoadingNewer(true);
    try {
      await loadNewerMessages(sessionId);
    } finally {
      loadingRef.current = false;
      setLoadingNewer(false);
    }
    if (anchorId && prevTop != null) restoreAnchor(anchorId, prevTop);
  };

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      updateScrollUi();
      if (loadingRef.current) return;
      // Don't auto-page when the window fits on screen (opening a short tail
      // would otherwise fire both edges at scrollTop 0).
      if (list.scrollHeight <= list.clientHeight + SCROLL_LOAD_PX) return;
      if (hasMore && list.scrollTop <= SCROLL_LOAD_PX) {
        void onLoadOlder();
        return;
      }
      const distBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (hasNewer && distBottom <= SCROLL_LOAD_PX) {
        void onLoadNewer();
      }
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    return () => list.removeEventListener("scroll", onScroll);
    // Intentionally close over the latest loaders / flags.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionId,
    hasMore,
    hasNewer,
    items[0]?.id,
    items[items.length - 1]?.id,
    updateScrollUi,
  ]);

  const jumpToAnchor = useCallback((id: string) => {
    const list = listRef.current;
    if (!list) return;
    const node = list.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
    if (!(node instanceof HTMLElement)) return;
    const listTop = list.getBoundingClientRect().top;
    const nodeTop = node.getBoundingClientRect().top;
    list.scrollTo({
      top:
        list.scrollTop +
        nodeTop -
        listTop -
        Math.min(96, list.clientHeight * 0.18),
      behavior: "smooth",
    });
    setActiveAnchorId(id);
  }, []);

  const jumpToBottom = async () => {
    if (hasNewer && sessionId) {
      setLoadingNewer(true);
      try {
        // Selecting a history window that has newer pages reloads the live tail.
        await selectSession(sessionId);
      } finally {
        setLoadingNewer(false);
      }
    }
    requestAnimationFrame(() => {
      const list = listRef.current;
      list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    });
  };

  if (loading && items.length === 0) {
    return (
      <div className="message-list-shell">
        <TranscriptSkeleton />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="message-list-shell">
        <div className="message-list empty">
          <div className="empty-hero">
            <div className="empty-hero-title">{t.chat.emptyHeroTitle}</div>
            <p className="empty-hero-sub">{t.chat.emptyHeroSub}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list-shell">
      <div className="message-list" ref={listRef}>
        {hasMore && sessionId ? (
          <button
            type="button"
            className="message-load-older"
            disabled={loadingOlder}
            onClick={() => void onLoadOlder()}
          >
            {loadingOlder ? t.common.loading : t.chat.loadOlder}
          </button>
        ) : null}
        {items.map((item) => (
          <MessageRow
            key={item.id}
            item={item}
            sessionId={sessionId}
            onOpenFile={onOpenFile}
          />
        ))}
        {hasNewer && sessionId ? (
          <button
            type="button"
            className="message-load-newer"
            disabled={loadingNewer}
            onClick={() => void onLoadNewer()}
          >
            {loadingNewer ? t.common.loading : t.chat.loadNewer}
          </button>
        ) : null}
      </div>
      <ConversationNavigator
        anchors={anchors}
        activeId={activeAnchorId}
        onNavigate={jumpToAnchor}
        label={t.chat.quickNavigation}
        userLabel={t.chat.quickNavigationUser}
        assistantLabel={t.chat.quickNavigationAssistant}
      />
      {modelQuota ? (
        <ModelQuotaRail
          quota={modelQuota}
          label={t.chat.modelQuotaRemaining}
          staleLabel={t.chat.modelQuotaStale}
        />
      ) : null}
      {showJumpToBottom ? (
        <button
          type="button"
          className="scroll-to-bottom-btn"
          disabled={loadingNewer}
          title={t.chat.scrollToBottom}
          aria-label={t.chat.scrollToBottom}
          onClick={() => void jumpToBottom()}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M12 4v14m0 0 6-6m-6 6-6-6" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
