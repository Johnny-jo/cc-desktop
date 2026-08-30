import React, { memo, useMemo } from "react";
import type {
  RoomLiveExecEntry,
  RoomSeat,
  RoomTimelineItem,
} from "@claude-desktop/shared";
import { MarkdownBody } from "./MarkdownBody";

export const ROOM_TIMELINE_RENDER_LIMIT = 80;
const EMPTY_LIVE_EXEC: readonly RoomLiveExecEntry[] = [];
const ROOM_RECOVERY_NOTICE_RE = /重新连接|已重连|恢复(?:开房|连接|群聊)|自动恢复/;
const ROOM_PRESENCE_NOISE_RE = /加入了群聊|退出了群聊|中继服务器已连接|已连接主机|连接成功|接管了|交还了|已交还 Agent/;

/**
 * Presence events remain in the archive, but do not need to occupy chat rows.
 * Keep only the newest recovery result so a reconnect is still visible once.
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
    if (ROOM_RECOVERY_NOTICE_RE.test(item.text)) {
      return index === newestRecoveryIndex;
    }
    return !ROOM_PRESENCE_NOISE_RE.test(item.text);
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
  seatNames: readonly string[],
  mySeatName: string | null,
): React.ReactNode {
  if (!seatNames.length) return text;
  const escaped = seatNames.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const mentionRe = new RegExp(`@(${escaped.join("|")})`, "g");
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(mentionRe)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const name = match[1] ?? "";
    out.push(
      <span
        key={key++}
        className={`room-mention${name === mySeatName ? " is-me" : ""}`}
      >
        @{name}
      </span>,
    );
    last = index + match[0].length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type RoomMessageRowProps = {
  item: RoomTimelineItem;
  seat: RoomSeat | null;
  selected: boolean;
  isMe: boolean;
  seatNames: readonly string[];
  mySeatName: string | null;
  onOpenMenu: (item: RoomTimelineItem, x: number, y: number) => void;
};

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a === b ||
    (a.length === b.length && a.every((value, index) => value === b[index]));
}

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
    sameTimelineItem(a.item, b.item) &&
    a.seat?.id === b.seat?.id &&
    a.seat?.kind === b.seat?.kind &&
    a.seat?.name === b.seat?.name &&
    a.selected === b.selected &&
    a.isMe === b.isMe &&
    a.mySeatName === b.mySeatName &&
    a.onOpenMenu === b.onOpenMenu &&
    sameStrings(a.seatNames, b.seatNames)
  );
}

export const RoomMessageRow = memo(function RoomMessageRow({
  item,
  seat,
  selected,
  isMe,
  seatNames,
  mySeatName,
  onOpenMenu,
}: RoomMessageRowProps) {
  const menuable =
    (item.kind === "user" || item.kind === "assistant") && !item.recalled;
  return (
    <div
      className={`room-msg${isMe ? " is-me" : ""} kind-${item.kind}${selected ? " focus" : ""}`}
      onContextMenu={
        menuable
          ? (event) => {
              event.preventDefault();
              onOpenMenu(item, event.clientX, event.clientY);
            }
          : undefined
      }
    >
      <div className="room-msg-avatar" aria-hidden>
        <SeatAvatar kind={seat?.kind ?? "human"} />
      </div>
      <div className="room-msg-body">
        <div className="room-msg-meta">
          <span className="room-msg-author">{item.authorLabel}</span>
          {item.source === "kernel" ? (
            <span className="room-msg-source">扩展</span>
          ) : null}
          {seat?.name ? <span className="room-msg-seat">{seat.name}</span> : null}
          <span className="room-msg-time">
            {new Date(item.at).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
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
            ) : item.kind === "assistant" ? (
              <div className="room-msg-text md">
                <MarkdownBody text={item.text} />
              </div>
            ) : (
              <div className="room-msg-text">
                {renderMentions(item.text, seatNames, mySeatName)}
              </div>
            )}
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
  return (
    <>
      {seats
        .filter(
          (seat) =>
            seat.kind === "agent" &&
            seat.running &&
            !liveExec.some(
              (entry) =>
                entry.seatId === seat.id && (entry.text || entry.thinking),
            ),
        )
        .map((seat) => (
          <div
            key={`typing-${seat.id}`}
            className="room-msg kind-assistant room-typing"
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
      {liveExec
        .filter((entry) => entry.text || entry.tool || entry.thinking)
        .map((entry) => (
          <div key={`live-${entry.turnId}`} className="room-msg kind-assistant">
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
                <div className="room-msg-text md room-live-text">
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
  items,
  seats,
  liveExec,
  selectedSeatId,
  myUserId,
  timelineRef,
  onOpenMenu,
}: {
  items: readonly RoomTimelineItem[];
  seats: readonly RoomSeat[];
  liveExec?: readonly RoomLiveExecEntry[];
  selectedSeatId: string | null;
  myUserId?: string;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  onOpenMenu: (item: RoomTimelineItem, x: number, y: number) => void;
}) {
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
  const seatNames = useMemo(
    () => seats.map((seat) => seat.name).sort((a, b) => b.length - a.length),
    [seats],
  );
  const mySeatName = useMemo(
    () =>
      seats.find(
        (seat) =>
          seat.kind === "human" && seat.occupantUserId === myUserId,
      )?.name ?? null,
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
            item={item}
            seat={item.seatId ? (seatsById.get(item.seatId) ?? null) : null}
            selected={Boolean(
              item.seatId && item.seatId === selectedSeatId,
            )}
            isMe={Boolean(myUserId && item.authorUserId === myUserId)}
            seatNames={seatNames}
            mySeatName={mySeatName}
            onOpenMenu={onOpenMenu}
          />
        ))
      )}
      <RoomLiveRows seats={seats} liveExec={currentLiveExec} />
    </div>
  );
});
