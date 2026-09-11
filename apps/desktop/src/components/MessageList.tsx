import React, {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChatItem,
  ModelQuotaInfo,
  TurnUsage,
  TurnOutcome,
} from "@claude-desktop/shared";
import { MarkdownBody } from "./MarkdownBody";
import { AttachmentChips } from "./AttachmentChips";
import { ChatActivity } from "./ChatActivity";
import { TurnDoneRow, TurnStatusBar } from "./TurnStatusBar";
import { formatTurnUsageLine } from "../lib/format-usage";
import {
  loadNewerMessages,
  loadOlderMessages,
  rewindToMessage,
  selectSession,
  useAppStore,
} from "../state/store";
import { useI18n } from "../i18n/useI18n";
import {
  buildConversationAnchors,
  type ConversationAnchor,
} from "../lib/conversation-navigation";
import { buildConversationBlocks, preserveActivityBlockIds, type ConversationBlock } from "../lib/conversation-blocks";
import { contentEndScrollTopForMetrics } from "../lib/chat-scroll";
import { createChatScrollController } from "../lib/chat-scroll-controller";
import "./ChatProgressLayout.css";
import { toProjectRel } from "../lib/project-path";
import { getDesktop } from "../lib/desktop-api";

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
  const [showAll, setShowAll] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [confirmingUndo, setConfirmingUndo] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const title =
    files.length === 1
      ? t.changes.editedFilesOne
      : t.changes.editedFiles.replace("{count}", String(files.length));
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const visibleFiles = showAll ? files : files.slice(0, 3);
  const remaining = Math.max(0, files.length - 3);
  const canUndoTask =
    Boolean(sessionId) &&
    files.length > 0 &&
    files.every((file) => (file.eventIds?.length ?? 0) > 0);

  const undoChanges = async () => {
    if (!sessionId || undoing || !canUndoTask) return;
    setUndoing(true);
    setConfirmingUndo(false);
    setNote(null);
    try {
      const result = await getDesktop().restoreTurnChanges(
        sessionId,
        files.map((file) => ({
          path: file.path,
          eventIds: file.eventIds ?? [],
        })),
      );
      setNote(
        result.error
          ? t.changes.undoNotLatest
          : result.failed.length > 0
          ? t.changes.undoPartial
              .replace("{restored}", String(result.restored.length))
              .replace("{failed}", String(result.failed.length))
          : t.changes.undoSuccess.replace(
              "{count}",
              String(result.restored.length),
            ),
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setUndoing(false);
    }
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
          <span
            className="turn-change-stats"
            aria-label={`+${additions} -${deletions}`}
          >
            <span className="turn-change-add">+{additions}</span>
            <span className="turn-change-del">-{deletions}</span>
          </span>
        </span>
        <button
          type="button"
          className="turn-changes-undo"
          disabled={!canUndoTask || undoing}
          title={!canUndoTask ? t.changes.undoUnavailable : undefined}
          aria-haspopup="dialog"
          onClick={() => setConfirmingUndo(true)}
        >
          {undoing ? t.changes.undoing : t.changes.undo}
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d="M6 4 2.5 7.5 6 11M3 7.5h6a4 4 0 0 1 4 4" />
          </svg>
        </button>
      </div>
      <div className="turn-changes-files">
        {visibleFiles.map((file) => {
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
      {remaining > 0 ? (
        <button
          type="button"
          className="turn-changes-more"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {(showAll ? t.changes.showFewerFiles : t.changes.showMoreFiles).replace(
            "{count}",
            String(remaining),
          )}
          <svg viewBox="0 0 16 16" aria-hidden>
            <path d={showAll ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
          </svg>
        </button>
      ) : null}
      {note ? <p className="turn-changes-note">{note}</p> : null}
      {confirmingUndo ? (
        <div className="modal-overlay task-undo-overlay">
          <div
            className="agent-prompt-card task-undo-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-undo-title"
          >
            <div className="agent-prompt-kicker">
              <span className="agent-prompt-icon" aria-hidden>
                <svg viewBox="0 0 16 16">
                  <path d="M6 4 2.5 7.5 6 11M3 7.5h6a4 4 0 0 1 4 4" />
                </svg>
              </span>
              <span>{t.changes.undo}</span>
            </div>
            <h2 id="task-undo-title" className="agent-prompt-title">
              {t.changes.undoConfirmTitle}
            </h2>
            <p className="agent-prompt-description">
              {t.changes.undoConfirmDescription.replace(
                "{count}",
                String(files.length),
              )}
            </p>
            <div className="task-undo-file-list">
              {files.slice(0, 5).map((file) => (
                <span key={file.path}>
                  {toProjectRel(projectPath, file.path) ?? file.path}
                </span>
              ))}
              {files.length > 5 ? (
                <span>
                  {t.changes.undoMoreFiles.replace(
                    "{count}",
                    String(files.length - 5),
                  )}
                </span>
              ) : null}
            </div>
            <div className="agent-prompt-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmingUndo(false)}
              >
                {t.common.cancel}
              </button>
              <button
                type="button"
                className="btn btn-danger agent-prompt-danger"
                onClick={() => void undoChanges()}
              >
                {t.changes.undoConfirmAction}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TurnResponseFooter({
  text,
  usage,
  id,
}: {
  text: string;
  usage: TurnUsage;
  id: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usageLine = formatTurnUsageLine(usage);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const copyResponse = async () => {
    if (!text || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be unavailable in restricted renderer contexts.
    }
  };

  return (
    <div className="turn-response-footer" data-item-id={id}>
      {text ? (
        <button
          type="button"
          className={`turn-response-copy${copied ? " copied" : ""}`}
          title={copied ? t.common.copied : t.common.copy}
          aria-label={copied ? t.common.copied : t.common.copy}
          onClick={() => void copyResponse()}
        >
          {copied ? (
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="m3 8.2 3 3 7-7" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden>
              <rect x="5.1" y="4.8" width="7.4" height="8" rx="1.4" />
              <path d="M10.7 4.8V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v6a1.4 1.4 0 0 0 1.4 1.4h1.2" />
            </svg>
          )}
        </button>
      ) : (
        <span />
      )}
      <span className="turn-response-usage" title={usageLine}>
        {usageLine}
      </span>
    </div>
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
    return null;
  }

  if (item.kind === "usage") return null;

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

const SCROLL_LOAD_PX = 80;
const SHOW_JUMP_BOTTOM_PX = 160;

function visibleReadingAnchors(list: HTMLElement): Array<{ id: string; top: number }> {
  const bounds = list.getBoundingClientRect();
  return Array.from(list.querySelectorAll<HTMLElement>("[data-item-id]"))
    .filter(node => !node.querySelector("[data-item-id]"))
    .filter(node => { const rect = node.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom; })
    .map(node => ({ id: node.dataset.itemId!, top: node.getBoundingClientRect().top - bounds.top }));
}

function reservedTurnSpace(list: HTMLElement): number {
  const spacer = list.querySelector(".turn-scroll-spacer");
  return spacer instanceof HTMLElement ? spacer.offsetHeight : 0;
}

/** Scroll position whose viewport bottom meets the real transcript content. */
function contentEndScrollTop(list: HTMLElement): number {
  return contentEndScrollTopForMetrics(
    list.scrollHeight,
    list.clientHeight,
    reservedTurnSpace(list),
  );
}

function ConversationNavigator({
  anchors,
  activeId,
  onNavigate,
  label,
  conclusionLabel,
  pendingLabel,
}: {
  anchors: ConversationAnchor[];
  activeId: string | null;
  onNavigate: (id: string) => void;
  label: string;
  conclusionLabel: string;
  pendingLabel: string;
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
          className={`conversation-nav-item${
            anchor.id === activeId ? " active" : ""
          }`}
          aria-current={anchor.id === activeId ? "location" : undefined}
          aria-label={`${label}: ${anchor.preview || pendingLabel}`}
          onClick={() => onNavigate(anchor.id)}
        >
          <span className="conversation-nav-tick" aria-hidden />
          <span className="conversation-nav-preview" role="tooltip">
            <span className="conversation-nav-preview-role">
              {conclusionLabel}
            </span>
            <span>{anchor.preview || pendingLabel}</span>
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
  running,
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
  /** True while the session turn is running (drives the turn status row). */
  running?: boolean;
  /** Open a project-relative file in the in-app editor column. */
  onOpenFile?: (rel: string, line?: number) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const scrollControllerRef = useRef<ReturnType<typeof createChatScrollController> | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const loadingRef = useRef(false);
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const anchors = useMemo(() => buildConversationAnchors(items), [items]);
  const previousBlocks = useRef<{ sessionId: string | null; blocks: ConversationBlock[] }>({ sessionId: null, blocks: [] });
  const blocks = useMemo(() => preserveActivityBlockIds(buildConversationBlocks(items, hasNewer ? false : Boolean(running)),
    previousBlocks.current.sessionId === sessionId ? previousBlocks.current.blocks : []), [items, sessionId, running, hasNewer]);
  useLayoutEffect(() => { previousBlocks.current = { sessionId, blocks }; }, [sessionId, blocks]);
  const readingAnchor = useRef<{ sessionId: string; anchors: Array<{ id: string; top: number }> } | null>(null);

  // The turn status row belongs to the latest user turn: rendered right below
  // the user message, above that turn's activity group and answer text.
  const lastUserBlockIndex = blocks.reduce<number>(
    (acc, block, index) =>
      block.kind === "item" &&
      block.item.kind === "text" &&
      block.item.role === "user"
        ? index
        : acc,
    -1,
  );

  // Completion data per user turn: a turn owns everything up to the next user
  // message. Drives the per-turn "done" marker, history turns included.
  const turnInfoByUserId = useMemo(() => {
    const map = new Map<string, { done: boolean; durationMs?: number; outcome?: TurnOutcome }>();
    let current: string | null = null;
    for (const item of items) {
      if (item.kind === "text" && item.role === "user") {
        current = item.id;
        map.set(current, { done: Boolean(item.turnOutcome), outcome: item.turnOutcome });
        continue;
      }
      if (!current) continue;
      const entry = map.get(current)!;
      if (
        item.kind === "tool" ||
        (item.kind === "text" && item.role === "assistant")
      ) {
        entry.done = true;
      } else if (item.kind === "usage" && item.usage.durationMs != null) {
        entry.durationMs = item.usage.durationMs;
      }
    }
    return map;
  }, [items]);

  const last = items[items.length - 1];
  const pinKey = last
    ? `${last.id}:${last.kind === "text" ? `${last.text.length}:${last.streaming ? 1 : 0}` : last.kind}`
    : "0";

  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    const spacer = spacerRef.current;
    if (!list || !content || !spacer) return;
    const controller = createChatScrollController(list, content, spacer);
    scrollControllerRef.current = controller;
    return () => {
      controller.dispose();
      if (scrollControllerRef.current === controller) scrollControllerRef.current = null;
    };
  }, [sessionId, hasItems]);

  useLayoutEffect(() => {
    scrollControllerRef.current?.update({
      sessionId,
      userId: anchors[anchors.length - 1]?.id ?? null,
      running: Boolean(running),
      hasNewer: Boolean(hasNewer),
    });
  }, [sessionId, items, anchors, running, hasNewer]);

  // Correct the committed DOM before paint, including when pagination removes
  // the load button or trims the other edge of the bounded history window.
  useLayoutEffect(() => {
    const saved = readingAnchor.current;
    const list = listRef.current;
    if (!saved || !list || saved.sessionId !== sessionId) { readingAnchor.current = null; return; }
    for (const anchor of saved.anchors) {
      const node = list.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(anchor.id)}"]`);
      if (!node) continue;
      list.scrollTop += node.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.top;
      break;
    }
    if (!loadingOlder && !loadingNewer) readingAnchor.current = null;
  }, [items, sessionId, loadingOlder, loadingNewer, hasMore, hasNewer]);

  const updateScrollUi = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const distBottom = Math.max(0, contentEndScrollTop(list) - list.scrollTop);
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

  const onLoadOlder = async () => {
    if (!hasMore || !sessionId || loadingRef.current) return;
    scrollControllerRef.current?.pause();
    const list = listRef.current;
    readingAnchor.current = list ? { sessionId, anchors: visibleReadingAnchors(list) } : null;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      await loadOlderMessages(sessionId);
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  };

  const onLoadNewer = async () => {
    if (!hasNewer || !sessionId || loadingRef.current) return;
    scrollControllerRef.current?.pause();
    const list = listRef.current;
    readingAnchor.current = list ? { sessionId, anchors: visibleReadingAnchors(list) } : null;
    loadingRef.current = true;
    setLoadingNewer(true);
    try {
      await loadNewerMessages(sessionId);
    } finally {
      loadingRef.current = false;
      setLoadingNewer(false);
    }
  };

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      updateScrollUi();
      if (loadingRef.current) {
        if (readingAnchor.current?.sessionId === sessionId) readingAnchor.current.anchors = visibleReadingAnchors(list);
        return;
      }
      // Don't auto-page when the window fits on screen (opening a short tail
      // would otherwise fire both edges at scrollTop 0).
      if (list.scrollHeight <= list.clientHeight + SCROLL_LOAD_PX) return;
      if (hasMore && list.scrollTop <= SCROLL_LOAD_PX) {
        void onLoadOlder();
        return;
      }
      const distBottom = Math.max(0, contentEndScrollTop(list) - list.scrollTop);
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
    scrollControllerRef.current?.pause();
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
      if (!list) return;
      scrollControllerRef.current?.followTail(true);
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
      <div className="message-list main-chat-message-list" ref={listRef} tabIndex={0}>
        <div className="message-list-content" ref={contentRef}>
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
        {blocks.map((block, index) => {
          const userItem =
            block.kind === "item" &&
            block.item.kind === "text" &&
            block.item.role === "user"
              ? block.item
              : null;
          const turnInfo = userItem
            ? turnInfoByUserId.get(userItem.id)
            : undefined;
          return (
            <Fragment key={block.kind === "item" ? block.item.id : block.id}>
              {block.kind === "activity" ? (
                <ChatActivity
                  id={block.id}
                  entries={block.entries}
                  durationMs={block.usage?.durationMs}
                  outcome={block.outcome}
                />
              ) : block.kind === "live-activity" ? (
                <ChatActivity id={block.id} entries={block.entries} live />
              ) : block.kind === "turn-footer" ? (
                <TurnResponseFooter
                  id={block.id}
                  text={block.text}
                  usage={block.usage}
                />
              ) : (
                <MessageRow
                  item={block.item}
                  sessionId={sessionId}
                  onOpenFile={onOpenFile}
                />
              )}
              {userItem ? (
                index === lastUserBlockIndex ? (
                  running && !hasNewer ? (
                    <div
                      className="current-turn-status"
                      data-current-turn-status
                    >
                      <TurnStatusBar
                        sessionId={sessionId}
                        running
                        items={items}
                        done={Boolean(turnInfo?.done)}
                        doneDurationMs={turnInfo?.durationMs}
                        outcome={turnInfo?.outcome}
                      />
                    </div>
                  ) : (
                    <TurnStatusBar
                      sessionId={sessionId}
                      running={false}
                      items={items}
                      done={Boolean(turnInfo?.done)}
                      doneDurationMs={turnInfo?.durationMs}
                      outcome={turnInfo?.outcome}
                    />
                  )
                ) : turnInfo?.done ? (
                  <TurnDoneRow durationMs={turnInfo.durationMs} outcome={turnInfo.outcome} />
                ) : null
              ) : null}
            </Fragment>
          );
        })}
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
        <div className="turn-scroll-spacer" ref={spacerRef} aria-hidden />
      </div>
      <ConversationNavigator
        anchors={anchors}
        activeId={activeAnchorId}
        onNavigate={jumpToAnchor}
        label={t.chat.quickNavigation}
        conclusionLabel={t.chat.quickNavigationConclusion}
        pendingLabel={t.chat.quickNavigationPending}
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
