import React, { memo, useMemo } from "react";
import type {
  RoomLiveExecEntry,
  RoomMention,
  RoomSeat,
  RoomTimelineItem,
} from "@claude-desktop/shared";
import { validateRoomMentions } from "@claude-desktop/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useRoomStore } from "../state/room-store";
import { MarkdownBody } from "./MarkdownBody";
import { RoomAttachments } from "./RoomAttachments";
import "./RoomTimeline.css";

export const ROOM_TIMELINE_RENDER_LIMIT = 80;
const EMPTY_LIVE_EXEC: readonly RoomLiveExecEntry[] = [];
const ROOM_RECOVERY_NOTICE_RE = /恢复(?:开房|连接|群聊)|自动恢复/;
const ROOM_PRESENCE_NOISE_RE = /加入了群聊|退出了群聊|已离线|已上线|已在线|重新连接|已重连|中继服务器已连接|已连接主机|连接成功|接管了|交还了|已交还 Agent/;

/**
 * Presence events remain in the archive, but do not need to occupy chat rows.
 * Keep only the newest room recovery result; online/offline notices stay hidden.
 */
export function compactRoomTimelineItems(
  items: readonly RoomTimelineItem[],
): readonly RoomTimelineItem[] {
  let newestRecoveryIndex = -1;
  items.forEach((item, index) => {
    if (item.kind === "system" && ROOM_RECOVERY_NOTICE_RE.test(item.text)) {
      newestRecoveryIndex = index;
    }
  });
  return items.filter((item, index) => {
    if (item.kind !== "system") return true;
    if (ROOM_PRESENCE_NOISE_RE.test(item.text)) return false;
    if (ROOM_RECOVERY_NOTICE_RE.test(item.text)) {
      return index === newestRecoveryIndex;
    }
    return true;
  });
}

export const SeatAvatar = memo(function SeatAvatar({
  kind,
}: {
  kind: "human" | "agent";
}) {
  if (kind === "agent") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="2.5" y="4" width="11" height="8" rx="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="6" cy="8" r="1" fill="currentColor" />
        <circle cx="10" cy="8" r="1" fill="currentColor" />
        <path d="M8 4V2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
});

function renderMentions(
  text: string,
  mentions: readonly RoomMention[],
  mySeatId: string | null,
): React.ReactNode {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const mention of mentions) {
    if (mention.start > last) out.push(text.slice(last, mention.start));
    out.push(
      <span
        key={mention.start}
        className={`room-mention${mention.seatId === mySeatId ? " is-me" : ""}`}
      >
        {text.slice(mention.start, mention.end)}
      </span>,
    );
    last = mention.end;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Annotate Markdown text nodes by original source offsets, never by seat names. */
function mentionMarkdownPlugin(text: string, mentions: readonly RoomMention[], mySeatId: string | null) {
  type Node = { type: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } }; data?: object };
  return function (this: { parse: (source: string) => unknown }) {
    const decodedTokens = new Map<string, string>();
    const walk = (node: Node) => {
      if (!node.children) return;
      node.children = node.children.flatMap(child => {
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (child.type !== "text" || typeof child.value !== "string" || start === undefined || end === undefined) {
          walk(child);
          return [child];
        }
        const matches = mentions.filter(m => m.start >= start && m.end <= end);
        if (!matches.length) return [child];
        const raw = text.slice(start, end);
        const value = child.value;
        const edits: { start: number; end: number; length: number }[] = [];
        if (raw !== value) {
          // Decode only Markdown escapes/references with the existing parser.
          // parse() does not run this transformer; unknown entities stay literal.
          const decoded = raw.replace(/\\[!-/:-@[-`{-~]|&(?:#[xX][\da-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z\d]{1,31});/g, (token, offset: number) => {
            let replacement = decodedTokens.get(token);
            if (replacement === undefined) {
              const parsed = this.parse(token) as Node;
              const leaf = parsed.children?.[0]?.children?.[0];
              replacement = leaf?.type === "text" ? leaf.value ?? token : token;
              decodedTokens.set(token, replacement);
            }
            edits.push({ start: offset, end: offset + token.length, length: replacement.length });
            return replacement;
          });
          if (decoded !== value) return [child];
        }
        const valueOffset = (sourceOffset: number) => {
          const offset = sourceOffset - start;
          let delta = 0;
          for (const edit of edits) {
            if (offset < edit.start) break;
            if (offset < edit.end) return edit.start + delta;
            delta += edit.length - (edit.end - edit.start);
          }
          return offset + delta;
        };
        const nodes: Node[] = [];
        let cursor = 0;
        for (const m of matches) {
          const from = valueOffset(m.start);
          const to = valueOffset(m.end);
          if (from > cursor) nodes.push({ type: "text", value: value.slice(cursor, from) });
          nodes.push({ type: "roomMention", data: { hName: "span", hProperties: { className: `room-mention${m.seatId === mySeatId ? " is-me" : ""}` } }, children: [{ type: "text", value: value.slice(from, to) }] });
          cursor = to;
        }
        if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
        return nodes;
      });
    };
    return (tree: unknown) => walk(tree as Node);
  };
}

export function resolveRoomMessageAuthorSeat(item: RoomTimelineItem, seats: readonly RoomSeat[]): RoomSeat | null {
  if (item.kind === "user" || item.kind === "game") {
    return item.authorUserId ? seats.find(s => s.kind === "human" && s.occupantUserId === item.authorUserId) ?? null : null;
  }
  if (item.kind === "assistant" || item.kind === "tool") return seats.find(s => s.kind === "agent" && s.id === item.seatId) ?? null;
  return null;
}

type RoomMessageRowProps = {
  roomId?: string;
  item: RoomTimelineItem;
  seat: RoomSeat | null;
  selected: boolean;
  isMe: boolean;
  seats: readonly RoomSeat[];
  authorSeat?: RoomSeat | null;
  mySeatId: string | null;
  onMentionSeat?: (seat: RoomSeat) => void;
  onOpenMenu: (item: RoomTimelineItem, x: number, y: number) => void;
};

function sameTimelineItem(
  a: RoomTimelineItem,
  b: RoomTimelineItem,
): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.at === b.at &&
      a.seatId === b.seatId &&
      a.authorUserId === b.authorUserId &&
      a.authorLabel === b.authorLabel &&
      a.kind === b.kind &&
      a.text === b.text &&
      a.source === b.source &&
      a.recalled === b.recalled &&
      a.taskId === b.taskId &&
      JSON.stringify(a.mentions) === JSON.stringify(b.mentions) &&
      JSON.stringify(a.attachments) === JSON.stringify(b.attachments) &&
      a.game?.type === b.game?.type &&
      a.game?.value === b.game?.value &&
      a.quote?.id === b.quote?.id &&
      a.quote?.authorLabel === b.quote?.authorLabel &&
      a.quote?.text === b.quote?.text)
  );
}

function sameRoomMessageRow(
  a: RoomMessageRowProps,
  b: RoomMessageRowProps,
): boolean {
  return (
    a.roomId === b.roomId &&
    sameTimelineItem(a.item, b.item) &&
    a.seat?.id === b.seat?.id &&
    a.seat?.kind === b.seat?.kind &&
    a.seat?.name === b.seat?.name &&
    a.selected === b.selected &&
    a.isMe === b.isMe &&
    a.mySeatId === b.mySeatId &&
    a.authorSeat?.id === b.authorSeat?.id &&
    a.authorSeat?.name === b.authorSeat?.name &&
    a.onMentionSeat === b.onMentionSeat &&
    a.onOpenMenu === b.onOpenMenu &&
    (a.seats === b.seats || (a.seats.length === b.seats.length && a.seats.every((seat, index) => {
      const other = b.seats[index];
      return seat.id === other.id && seat.name === other.name;
    })))
  );
}

export const RoomMessageRow = memo(function RoomMessageRow({
  roomId,
  item,
  selected,
  isMe,
  seats,
  authorSeat,
  mySeatId,
  onMentionSeat,
  onOpenMenu,
}: RoomMessageRowProps) {
  // For user commands seatId is the target Agent, not the human author.
  const isHuman = item.kind === "user" || item.kind === "game";
  const isAgent = item.kind === "assistant" || item.kind === "tool";
  const isSystem = item.kind === "system";
  const senderName = authorSeat?.name ?? item.authorLabel;
  const timestamp = new Date(item.at);
  const menuable =
    (item.kind === "user" || item.kind === "assistant") && !item.recalled;
  const mentions = validateRoomMentions(item.text, item.mentions, seats);
  const mentionable = menuable && authorSeat && onMentionSeat;
  return (
    <div
      className={`room-msg${isHuman ? " is-human" : isAgent ? " is-agent" : ""}${isHuman && isMe ? " is-me" : ""} kind-${item.kind}${selected ? " focus" : ""}`}
      data-task-id={item.taskId}
      onContextMenu={
        menuable
          ? (event) => {
              event.preventDefault();
              onOpenMenu(item, event.clientX, event.clientY);
            }
          : undefined
      }
    >
      {!isSystem ? (
        <div className="room-msg-avatar" aria-hidden={mentionable ? undefined : true}
          role={mentionable ? "button" : undefined}
          tabIndex={mentionable ? 0 : undefined}
          aria-label={mentionable ? `提及 ${senderName}` : undefined}
          onClick={mentionable ? () => onMentionSeat(authorSeat) : undefined}
          onKeyDown={mentionable ? event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onMentionSeat(authorSeat); }
          } : undefined}
        >
          <SeatAvatar kind={isAgent ? "agent" : "human"} />
        </div>
      ) : null}
      <div className="room-msg-body">
        {isSystem ? (
          <time className="room-notice-time" dateTime={Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined}>
            {timestamp.toLocaleString()}
          </time>
        ) : (
          <div className="room-msg-meta">
            <span className="room-msg-author">{senderName}</span>
            <span className="room-msg-time">
              {timestamp.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        )}
        {item.recalled ? (
          <div className="room-msg-text room-recalled">此消息已撤回</div>
        ) : (
          <>
            {item.quote ? (
              <div className="room-msg-quote">
                <span className="room-msg-quote-author">
                  {item.quote.authorLabel}
                </span>
                <span className="room-msg-quote-text">{item.quote.text}</span>
              </div>
            ) : null}
            {item.kind === "game" && item.game ? (
              <div className="room-msg-game">
                <span className="room-game-icon">{item.game.value}</span>
                <span>{item.text}</span>
              </div>
            ) : !item.text ? null : item.kind === "assistant" ? (
              <div className="room-msg-text md room-agent-prose">
                {mentions.length ? (
                  <div className="md-body"><ReactMarkdown
                    remarkPlugins={[remarkGfm, mentionMarkdownPlugin(item.text, mentions, mySeatId)]}
                    components={{ p: ({ children }) => <p className="md-p">{children}</p>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}
                  >{item.text}</ReactMarkdown></div>
                ) : <MarkdownBody text={item.text} />}
              </div>
            ) : (
              <div className={`room-msg-text${isAgent ? " room-agent-prose" : ""}`}>
                {renderMentions(item.text, mentions, mySeatId)}
              </div>
            )}
            {item.attachments?.length ? (
              <RoomAttachments roomId={roomId ?? ""} itemId={item.id} attachments={item.attachments} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}, sameRoomMessageRow);

const RoomLiveRows = memo(function RoomLiveRows({
  seats,
  liveExec,
}: {
  seats: readonly RoomSeat[];
  liveExec: readonly RoomLiveExecEntry[];
}) {
  const seatsById = useMemo(
    () => new Map(seats.map((seat) => [seat.id, seat])),
    [seats],
  );
  const visibleLiveExec = useMemo(
    () => liveExec.filter((entry) => entry.text || entry.tool || entry.thinking),
    [liveExec],
  );
  return (
    <>
      {seats
        .filter(
          (seat) =>
            seat.kind === "agent" &&
            seat.running &&
            !visibleLiveExec.some((entry) => entry.seatId === seat.id),
        )
        .map((seat) => (
          <div
            key={`typing-${seat.id}`}
            className="room-msg is-agent kind-assistant room-typing"
            data-seat-id={seat.id}
          >
            <div className="room-msg-avatar" aria-hidden>
              <SeatAvatar kind="agent" />
            </div>
            <div className="room-msg-body">
              <div className="room-msg-meta">
                <span className="room-msg-author">{seat.name}</span>
              </div>
              <div className="room-typing-dots" aria-label="正在工作">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        ))}
      {visibleLiveExec.map((entry) => (
        <div
          key={`live-${entry.seatId}-${entry.turnId}`}
          className="room-msg is-agent kind-assistant room-live-exec"
          data-seat-id={entry.seatId}
          data-turn-id={entry.turnId}
        >
          <div className="room-msg-avatar" aria-hidden>
            <SeatAvatar kind="agent" />
          </div>
          <div className="room-msg-body">
            <div className="room-msg-meta">
              <span className="room-msg-author">
                {seatsById.get(entry.seatId)?.name ?? "Agent"}
              </span>
              <span className="room-msg-source">实时</span>
            </div>
            {entry.thinking ? (
              <details className="room-live-thinking" open={!entry.text}>
                <summary>思考过程</summary>
                <div className="room-live-thinking-body">{entry.thinking}</div>
              </details>
            ) : null}
            {entry.text ? (
              <div className="room-msg-text md room-agent-prose room-live-text">
                <MarkdownBody text={entry.text} streaming />
              </div>
            ) : null}
            {entry.tool ? (
              <div className="room-live-tool">🔧 {entry.tool}</div>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
});

export const RoomTimeline = memo(function RoomTimeline({
  roomId,
  items,
  seats,
  liveExec,
  selectedSeatId,
  myUserId,
  timelineRef,
  onOpenMenu,
  onMentionSeat,
}: {
  roomId?: string;
  items: readonly RoomTimelineItem[];
  seats: readonly RoomSeat[];
  liveExec?: readonly RoomLiveExecEntry[];
  selectedSeatId: string | null;
  myUserId?: string;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  onOpenMenu: (item: RoomTimelineItem, x: number, y: number) => void;
  onMentionSeat?: (seat: RoomSeat) => void;
}) {
  // Existing callers pass the active snapshot's items. Never borrow another
  // room's identity for a historical/detached list supplied without roomId.
  const snapshotRoomId = useRoomStore(s => s.activeRoom?.items === items ? s.activeRoom.roomId : undefined);
  const attachmentRoomId = roomId ?? snapshotRoomId;
  const currentLiveExec = liveExec ?? EMPTY_LIVE_EXEC;
  const compactedItems = useMemo(
    () => compactRoomTimelineItems(items),
    [items],
  );
  const visibleItems = useMemo(
    () => compactedItems.slice(-ROOM_TIMELINE_RENDER_LIMIT),
    [compactedItems],
  );
  const seatsById = useMemo(
    () => new Map(seats.map((seat) => [seat.id, seat])),
    [seats],
  );
  const mySeatId = useMemo(
    () =>
      seats.find(
        (seat) =>
          seat.kind === "human" && seat.occupantUserId === myUserId,
      )?.id ?? null,
    [myUserId, seats],
  );
  const hiddenCount = compactedItems.length - visibleItems.length;

  return (
    <div className="room-timeline" ref={timelineRef}>
      {hiddenCount > 0 ? (
        <div className="room-history-truncated">
          为保持流畅，较早的 {hiddenCount} 条消息暂不渲染
        </div>
      ) : null}
      {compactedItems.length === 0 ? (
        <p className="room-stage-empty">还没有消息，选一个席位开始</p>
      ) : (
        visibleItems.map((item) => (
          <RoomMessageRow
            key={item.id}
            roomId={attachmentRoomId}
            item={item}
            seat={item.seatId ? (seatsById.get(item.seatId) ?? null) : null}
            selected={Boolean(
              item.seatId && item.seatId === selectedSeatId,
            )}
            isMe={Boolean(myUserId && item.authorUserId === myUserId)}
            seats={seats}
            authorSeat={resolveRoomMessageAuthorSeat(item, seats)}
            mySeatId={mySeatId}
            onMentionSeat={onMentionSeat}
            onOpenMenu={onOpenMenu}
          />
        ))
      )}
      <RoomLiveRows seats={seats} liveExec={currentLiveExec} />
    </div>
  );
});
