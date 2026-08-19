import React, { useRef, useState } from "react";
import type { RoomQuoteRef } from "@claude-desktop/shared";
import { useAppStore } from "../state/store";
import {
  leaveActiveRoom,
  playRps,
  rejoinRoom,
  returnSeat,
  rollDice,
  selectSeat,
  sendToSeat,
  takeoverSeat,
  useRoomStore,
} from "../state/room-store";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import { parseTrailingAt } from "../lib/at-mention";
import { formatModBadge } from "../lib/room-mod-ui";
import { useI18n } from "../i18n/useI18n";
import { ModPlayPanel } from "./ModPlayPanel";
import { RoomAddSeatModal } from "./RoomAddSeatModal";
import { RoomInviteModal } from "./RoomInviteModal";
import { RoomLeaveConfirm } from "./RoomLeaveConfirm";
import { RoomSettingsModal } from "./RoomSettingsModal";

function SeatAvatar({ kind }: { kind: "human" | "agent" }) {
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
}

export function RoomStage() {
  const { t } = useI18n();
  const room = useRoomStore((s) => s.activeRoom);
  const selectedSeatId = useRoomStore((s) => s.selectedSeatId);
  const rooms = useRoomStore((s) => s.rooms);
  const reconnectNote = useRoomStore((s) => s.reconnectNote);
  const lastError = useRoomStore((s) => s.lastError);
  const mod = useRoomStore((s) => s.mod);
  const settings = useAppStore((s) => s.settings);
  const [draft, setDraft] = useState("");
  const [invite, setInvite] = useState<{
    code: string;
    port?: number;
    listening: boolean;
  } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quote, setQuote] = useState<RoomQuoteRef | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  if (!room) {
    return (
      <div className="room-stage">
        <div className="room-stage-empty-wrap">
          <div className="room-stage-empty-icon" aria-hidden>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
              <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="16.5" cy="9.5" r="2.4" stroke="currentColor" strokeWidth="1.4" />
              <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M15.5 14.6c2.3.3 4 1.9 4 4.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </div>
          <p className="room-stage-empty-title">协作群聊</p>
          <p className="room-stage-empty">
            在左侧「群聊」里创建群聊，让局域网内的其他人加入；
            <br />
            每个席位可以是一个 Agent，也可以由人随时接管。
          </p>
        </div>
      </div>
    );
  }

  const selected = room.seats.find((s) => s.id === selectedSeatId) ?? null;
  const myRole = rooms.find((r) => r.roomId === room.roomId)?.role ?? "member";
  const offline = Boolean(
    rooms.find((r) => r.roomId === room.roomId)?.offline,
  );
  const canHost = myRole === "host";
  const myUserId = room.localUserId;
  const modActive = Boolean(room.modChecksum);
  const stageBadge = formatModBadge(
    mod?.offer?.checksum === room.modChecksum
      ? mod.offer
      : room.modChecksum
        ? { id: "", version: "", checksum: room.modChecksum }
        : null,
    t.room.modBadge,
  );
  const pulseOn = Boolean(
    room.kernel?.mods.some((m) => m.id === "room-pulse" && m.state === "active"),
  );

  // @提及：候选来自席位，弹层复用 .slash-menu 样式（纯渲染层，协议不改）
  const mention = room.status === "open" ? parseTrailingAt(draft) : null;
  const mentionMatches = mention
    ? room.seats.filter((s) =>
        s.name.toLowerCase().includes(mention.query.toLowerCase()),
      )
    : [];
  const mentionOpen = Boolean(mention && !mentionClosed && mentionMatches.length);
  const mentionSel = mentionMatches.length
    ? mentionIndex % mentionMatches.length
    : 0;

  const pickMention = (name: string) => {
    if (!mention) return;
    setDraft(`${draft.slice(0, mention.start)}@${name} `);
    setMentionIndex(0);
    inputRef.current?.focus();
  };

  // 渲染层 @名字 高亮：按席位名匹配，@自己加底色
  const seatNames = room.seats
    .map((s) => s.name)
    .sort((a, b) => b.length - a.length);
  const mySeatName =
    room.seats.find(
      (s) => s.kind === "human" && s.occupantUserId === myUserId,
    )?.name ?? null;
  const mentionRe = seatNames.length
    ? new RegExp(
        `@(${seatNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
        "g",
      )
    : null;

  const renderText = (text: string): React.ReactNode => {
    if (!mentionRe) return text;
    const out: React.ReactNode[] = [];
    let last = 0;
    let k = 0;
    for (const m of text.matchAll(mentionRe)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const name = m[1];
      out.push(
        <span
          key={k++}
          className={`room-mention${name === mySeatName ? " is-me" : ""}`}
        >
          @{name}
        </span>,
      );
      last = m.index + m[0].length;
    }
    if (!out.length) return text;
    if (last < text.length) out.push(text.slice(last));
    return out;
  };

  const onSend = async () => {
    const t = draft.trim();
    if (!t) return;
    setErr(null);
    const res = await sendToSeat(t, quote ?? undefined);
    if (!res.ok) {
      setErr(res.error ?? "发送失败");
      return;
    }
    setDraft("");
    setQuote(null);
    setMentionIndex(0);
    setMentionClosed(false);
  };

  const onDice = async () => {
    setErr(null);
    const res = await rollDice();
    if (!res.ok) setErr(res.error ?? "掷骰子失败");
  };

  const onRps = async (hand: "rock" | "scissors" | "paper") => {
    setErr(null);
    const res = await playRps(hand);
    if (!res.ok) setErr(res.error ?? "出拳失败");
  };

  const onInvite = async () => {
    if (!hasDesktopApi("getRoomInvite")) return;
    const inv = await getDesktop().getRoomInvite(room.roomId);
    if (!inv.ok) {
      setErr(inv.error ?? "只有群主可以邀请");
      return;
    }
    if (!inv.secret) {
      setErr("生成邀请码失败，请重试");
      return;
    }
    setInvite({
      code: inv.secret,
      port: inv.port,
      listening: inv.listening !== false,
    });
  };

  return (
    <div className="room-stage">
      {/* ── Header ── */}
      <header className="room-stage-head">
        <div className="room-stage-title">
          <span className="chat-title">{room.name}</span>
          <span
            className={`room-dot${room.status === "open" ? " on" : ""}${pulseOn ? " is-pulse" : ""}`}
            title={pulseOn ? t.room.pulseLive : undefined}
            aria-label={pulseOn ? t.room.pulseLive : undefined}
          />
          <span className="room-meta">
            {room.memberCount} 人 · {room.status === "open" ? "开着" : "已结束"}
            {room.kernel?.mods.some((m) => m.state === "active")
              ? ` · ${t.room.settingsExtensions} ${
                  room.kernel.mods.filter((m) => m.state === "active").length
                }`
              : ""}
          </span>
          {stageBadge ? (
            <span className="room-mod-badge" title={stageBadge}>
              {stageBadge}
            </span>
          ) : null}
        </div>
        <div className="room-stage-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setSettingsOpen(true)}
          >
            {t.room.settings}
          </button>
          {canHost && room.status === "open" ? (
            <button type="button" className="btn btn-sm" onClick={() => void onInvite()}>
              邀请
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setConfirmLeave(true)}
          >
            {canHost ? t.room.leaveConfirmYesHost : t.room.leaveConfirmYes}
          </button>
        </div>
      </header>

      {confirmLeave ? (
        <RoomLeaveConfirm
          isHost={canHost}
          roomName={room.name}
          onCancel={() => setConfirmLeave(false)}
          onConfirm={() => {
            setConfirmLeave(false);
            void leaveActiveRoom();
          }}
        />
      ) : null}

      {reconnectNote ? <div className="room-reconnect-banner">{reconnectNote}</div> : null}

      {offline ? (
        <div className="room-offline-banner">
          <span>{t.room.offlineBanner}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void rejoinRoom(room.roomId)}
          >
            {t.room.rejoin}
          </button>
        </div>
      ) : null}

      {modActive ? (
        <ModPlayPanel
          role={myRole}
          seats={room.seats}
          localUserId={myUserId}
        />
      ) : null}

      {settingsOpen ? (
        <RoomSettingsModal
          room={room}
          canHost={canHost}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {invite ? (
        <RoomInviteModal
          code={invite.code}
          port={invite.port}
          listening={invite.listening}
          onClose={() => setInvite(null)}
        />
      ) : null}

      {/* ── Seats row ── */}
      <div className="room-seats" role="tablist">
        {room.seats.map((s) => {
          const active = s.id === selectedSeatId;
          const isMine = myUserId && s.kind === "human" && s.occupantUserId === myUserId;
          return (
            <div
              key={s.id}
              role="tab"
              aria-selected={active}
              className={`room-seat${active ? " active" : ""}${s.kind === "agent" ? " is-agent" : ""}${s.running ? " is-running" : ""}${isMine ? " is-mine" : ""}`}
              onClick={() => selectSeat(s.id)}
            >
              <span className="room-seat-avatar" aria-hidden>
                <SeatAvatar kind={s.kind} />
              </span>
              <span className="room-seat-name">{s.name}</span>
              {s.running ? <span className="room-seat-pulse" aria-hidden /> : null}
              {s.takenOverBy ? <span className="room-seat-tag">接管中</span> : null}
              {isMine ? <span className="room-seat-tag mine">我</span> : null}
              {s.kind === "agent" && room.status === "open" ? (
                <span
                  className="room-seat-act"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    void (s.takenOverBy ? returnSeat(s.id) : takeoverSeat(s.id));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      void (s.takenOverBy ? returnSeat(s.id) : takeoverSeat(s.id));
                    }
                  }}
                >
                  {s.takenOverBy ? "交还" : "接管"}
                </span>
              ) : null}
            </div>
          );
        })}
        {room.status === "open" ? (
          <button type="button" className="room-seat add" onClick={() => setAddOpen(true)}>
            + 席位
          </button>
        ) : null}
      </div>

      {addOpen ? (
        <RoomAddSeatModal
          agents={settings?.agents ?? []}
          onClose={() => setAddOpen(false)}
        />
      ) : null}

      {/* ── Timeline ── */}
      <div className="room-timeline">
        {room.items.length === 0 ? (
          <p className="room-stage-empty">还没有消息，选一个席位开始</p>
        ) : (
          room.items.map((it) => {
            const seat = it.seatId ? room.seats.find((s) => s.id === it.seatId) : null;
            const seatName = seat?.name ?? "";
            const isMe = myUserId && it.authorUserId === myUserId;
            return (
              <div
                key={it.id}
                className={`room-msg${isMe ? " is-me" : ""} kind-${it.kind}${it.seatId && it.seatId === selectedSeatId ? " focus" : ""}`}
              >
                <div className="room-msg-avatar" aria-hidden>
                  {seat ? <SeatAvatar kind={seat.kind} /> : <SeatAvatar kind="human" />}
                </div>
                <div className="room-msg-body">
                  <div className="room-msg-meta">
                    <span className="room-msg-author">{it.authorLabel}</span>
                    {it.source === "kernel" ? (
                      <span className="room-msg-source">扩展</span>
                    ) : null}
                    {seatName ? <span className="room-msg-seat">{seatName}</span> : null}
                    <span className="room-msg-time">
                      {new Date(it.at).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {it.quote ? (
                    <div className="room-msg-quote">
                      <span className="room-msg-quote-author">
                        {it.quote.authorLabel}
                      </span>
                      <span className="room-msg-quote-text">{it.quote.text}</span>
                    </div>
                  ) : null}
                  {it.kind === "game" && it.game ? (
                    <div className="room-msg-game">
                      <span className="room-game-icon">{it.game.value}</span>
                      <span>{it.text}</span>
                    </div>
                  ) : (
                    <div className="room-msg-text">{renderText(it.text)}</div>
                  )}
                  {it.kind === "user" || it.kind === "assistant" ? (
                    <button
                      type="button"
                      className="room-msg-quote-btn"
                      title={t.room.quoteAction}
                      onClick={() =>
                        setQuote({
                          id: it.id,
                          authorLabel: it.authorLabel,
                          text: it.text.slice(0, 120),
                        })
                      }
                    >
                      {t.room.quoteAction}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {err || lastError ? <p className="room-err">{err || lastError}</p> : null}

      {/* ── Composer ── */}
      <div className="room-composer">
        {mentionOpen ? (
          <ul className="slash-menu at-menu" role="listbox" aria-label="提及席位">
            {mentionMatches.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={i === mentionSel ? "slash-item active" : "slash-item"}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => pickMention(s.name)}
                >
                  <span className="slash-name at-name">@{s.name}</span>
                  <span className="slash-desc">
                    {s.kind === "agent" ? "Agent" : "成员"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="room-composer-box">
          {quote ? (
            <div className="room-quote-bar">
              <span className="room-quote-bar-author">{quote.authorLabel}</span>
              <span className="room-quote-bar-text" title={quote.text}>
                {quote.text}
              </span>
              <button
                type="button"
                className="room-quote-bar-x"
                aria-label={t.common.cancel}
                onClick={() => setQuote(null)}
              >
                ×
              </button>
            </div>
          ) : null}
          <textarea
            ref={inputRef}
            className="room-input"
            rows={2}
            placeholder={
              selected
                ? `发给「${selected.name}」…  @ 提及，Enter 发送，Shift+Enter 换行`
                : "先在上方点一个席位再输入"
            }
            value={draft}
            disabled={room.status !== "open" || offline}
            onChange={(e) => {
              setDraft(e.target.value);
              setMentionIndex(0);
              setMentionClosed(false);
            }}
            onKeyDown={(e) => {
              if (mentionOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mentionMatches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex(
                    (i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
                  );
                  return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                  e.preventDefault();
                  const pick = mentionMatches[mentionSel];
                  if (pick) pickMention(pick.name);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMentionClosed(true);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
          />
          <div className="room-composer-bar">
            <div className="room-game-row">
              <button
                type="button"
                className="room-game-btn"
                disabled={room.status !== "open" || offline || !selected}
                title="掷骰子"
                onClick={() => void onDice()}
              >
                🎲
              </button>
              <button
                type="button"
                className="room-game-btn"
                disabled={room.status !== "open" || offline || !selected}
                title="石头"
                onClick={() => void onRps("rock")}
              >
                ✊
              </button>
              <button
                type="button"
                className="room-game-btn"
                disabled={room.status !== "open" || offline || !selected}
                title="剪刀"
                onClick={() => void onRps("scissors")}
              >
                ✌️
              </button>
              <button
                type="button"
                className="room-game-btn"
                disabled={room.status !== "open" || offline || !selected}
                title="布"
                onClick={() => void onRps("paper")}
              >
                ✋
              </button>
            </div>
            <button
              type="button"
              className="btn btn-sm room-send-btn"
              disabled={room.status !== "open" || offline || !draft.trim() || !selected}
              onClick={() => void onSend()}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
