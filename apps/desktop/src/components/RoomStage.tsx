import React, { useState } from "react";
import { useAppStore } from "../state/store";
import {
  addSeat,
  leaveActiveRoom,
  playRps,
  returnSeat,
  rollDice,
  selectSeat,
  sendToSeat,
  takeoverSeat,
  useRoomStore,
} from "../state/room-store";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";

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
  const room = useRoomStore((s) => s.activeRoom);
  const selectedSeatId = useRoomStore((s) => s.selectedSeatId);
  const rooms = useRoomStore((s) => s.rooms);
  const reconnectNote = useRoomStore((s) => s.reconnectNote);
  const lastError = useRoomStore((s) => s.lastError);
  const settings = useAppStore((s) => s.settings);
  const [draft, setDraft] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteText, setInviteText] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

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
          <p className="room-stage-empty-title">协作房间</p>
          <p className="room-stage-empty">
            在左侧「房间」里创建房间，让局域网内的其他人加入；
            <br />
            每个席位可以是一个 Agent，也可以由人随时接管。
          </p>
        </div>
      </div>
    );
  }

  const selected = room.seats.find((s) => s.id === selectedSeatId) ?? null;
  const myRole = rooms.find((r) => r.roomId === room.roomId)?.role ?? "member";
  const canHost = myRole === "host";
  const myUserId = room.localUserId;

  const onSend = async () => {
    const t = draft.trim();
    if (!t) return;
    setErr(null);
    const res = await sendToSeat(t);
    if (!res.ok) {
      setErr(res.error ?? "发送失败");
      return;
    }
    setDraft("");
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

  const copyInvite = async () => {
    if (!hasDesktopApi("getRoomInvite")) return;
    const inv = await getDesktop().getRoomInvite(room.roomId);
    if (!inv.ok) {
      setErr(inv.error ?? "只有房主可以邀请");
      return;
    }
    if (!inv.secret) {
      setErr("生成邀请码失败，请重试");
      return;
    }
    const text = inv.secret;
    setInviteText(
      [
        `房间邀请码（复制给对方）`,
        text,
        inv.listening === false
          ? "警告：主机未在监听，请重新创建房间"
          : `对方在「房间 → 加入房间」粘贴即可；本机防火墙需放行 TCP ${inv.port}`,
      ].join("\n"),
    );
    setInviteOpen(true);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  };

  return (
    <div className="room-stage">
      {/* ── Header ── */}
      <header className="room-stage-head">
        <div className="room-stage-title">
          <span className="chat-title">{room.name}</span>
          <span className={`room-dot ${room.status === "open" ? "on" : ""}`} />
          <span className="room-meta">
            {room.memberCount} 人 · {room.status === "open" ? "开着" : "已结束"}
          </span>
        </div>
        <div className="room-stage-actions">
          {canHost && room.status === "open" ? (
            <button type="button" className="btn btn-sm" onClick={() => void copyInvite()}>
              邀请
            </button>
          ) : null}
          {confirmLeave ? (
            <span className="room-leave-confirm">
              {canHost ? "退出并解散？" : "退出？"}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setConfirmLeave(false);
                  void leaveActiveRoom();
                }}
              >
                确定
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmLeave(false)}
              >
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setConfirmLeave(true)}
            >
              {canHost ? "退出并解散" : "退出房间"}
            </button>
          )}
        </div>
      </header>

      {reconnectNote ? <div className="room-reconnect-banner">{reconnectNote}</div> : null}

      {inviteOpen ? (
        <div className="room-invite-bar">
          <pre>{inviteText || "已复制邀请信息"}</pre>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setInviteOpen(false)}>
            ×
          </button>
        </div>
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
          <button type="button" className="room-seat add" onClick={() => setAddOpen((v) => !v)}>
            + 席位
          </button>
        ) : null}
      </div>

      {addOpen ? (
        <div className="room-add-seat">
          <input
            placeholder="席位名（如 架构Agent）"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
          />
          <select
            className="select"
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              if (v) setAddName(v);
            }}
          >
            <option value="">从自定义 Agent 选…</option>
            {(settings?.agents ?? []).map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              const n = addName.trim();
              if (!n) return;
              void addSeat("agent", n, n);
              setAddName("");
              setAddOpen(false);
            }}
          >
            添加
          </button>
        </div>
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
                    {seatName ? <span className="room-msg-seat">{seatName}</span> : null}
                    <span className="room-msg-time">
                      {new Date(it.at).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {it.kind === "game" && it.game ? (
                    <div className="room-msg-game">
                      <span className="room-game-icon">{it.game.value}</span>
                      <span>{it.text}</span>
                    </div>
                  ) : (
                    <div className="room-msg-text">{it.text}</div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {err || lastError ? <p className="room-err">{err || lastError}</p> : null}

      {/* ── Composer ── */}
      <div className="room-composer">
        <textarea
          className="room-input"
          rows={2}
          placeholder={
            selected
              ? `发给「${selected.name}」…  Enter 发送，Shift+Enter 换行`
              : "先在上方点一个席位再输入"
          }
          value={draft}
          disabled={room.status !== "open"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
        />
        <div className="room-composer-actions">
          <div className="room-game-row">
            <button
              type="button"
              className="room-game-btn"
              disabled={room.status !== "open" || !selected}
              title="掷骰子"
              onClick={() => void onDice()}
            >
              🎲
            </button>
            <button
              type="button"
              className="room-game-btn"
              disabled={room.status !== "open" || !selected}
              title="石头"
              onClick={() => void onRps("rock")}
            >
              ✊
            </button>
            <button
              type="button"
              className="room-game-btn"
              disabled={room.status !== "open" || !selected}
              title="剪刀"
              onClick={() => void onRps("scissors")}
            >
              ✌️
            </button>
            <button
              type="button"
              className="room-game-btn"
              disabled={room.status !== "open" || !selected}
              title="布"
              onClick={() => void onRps("paper")}
            >
              ✋
            </button>
          </div>
          <button
            type="button"
            className="btn btn-sm room-send-btn"
            disabled={room.status !== "open" || !draft.trim() || !selected}
            onClick={() => void onSend()}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
