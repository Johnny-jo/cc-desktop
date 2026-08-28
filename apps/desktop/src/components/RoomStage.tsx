import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment, RoomQuoteRef, RoomTimelineItem } from "@claude-desktop/shared";
import { formatFileSize } from "@claude-desktop/shared";
import { useAppStore } from "../state/store";
import {
  askRoomAiShare,
  recallRoomMessage,
  rejoinRoom,
  returnSeat,
  selectSeat,
  sendToSeat,
  setRoomAiShare,
  takeoverSeat,
  useRoomStore,
} from "../state/room-store";
import {
  canManageSeats,
  countOnlineMembers,
  memberIsOnline,
  resolveAiUserId,
  resolveWorkspaceUserId,
} from "@claude-desktop/shared";
import { fillTemplate } from "../lib/room-mod-ui";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import { parseTrailingAt } from "../lib/at-mention";
import { formatModBadge } from "../lib/room-mod-ui";
import { useI18n } from "../i18n/useI18n";
import { ModPlayPanel } from "./ModPlayPanel";
import { MarkdownBody } from "./MarkdownBody";
import { RoomAddSeatModal, type SeatDraft } from "./RoomAddSeatModal";
import { RoomInviteModal } from "./RoomInviteModal";
import { RoomPendingBanner } from "./RoomPendingBanner";
import { RoomRemoteChanges } from "./RoomRemoteChanges";
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
  const [editSeat, setEditSeat] = useState<SeatDraft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 右侧成员/席位面板：默认展开，可折叠成窄条
  const [sideOpen, setSideOpen] = useState(true);
  const [quote, setQuote] = useState<RoomQuoteRef | null>(null);
  // 拖拽进来的待发送附件（复用主对话的 readAttachment 管道）
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attErr, setAttErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // 气泡右键菜单：复制 / 引用 / 撤回
  const [bubbleMenu, setBubbleMenu] = useState<{
    x: number;
    y: number;
    item: RoomTimelineItem;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionClosed, setMentionClosed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const lastItem = room?.items[room.items.length - 1];
  const runningCount = room?.seats.filter((s) => s.running).length ?? 0;
  const timelinePinKey = lastItem
    ? `${lastItem.id}:${lastItem.text?.length ?? 0}:${runningCount}`
    : `0:${runningCount}`;

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const pin = () => {
      el.scrollTop = el.scrollHeight;
    };
    pin();
    requestAnimationFrame(pin);
  }, [room?.roomId, timelinePinKey]);

  // 气泡菜单：点击别处 / Esc 关闭
  useEffect(() => {
    if (!bubbleMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBubbleMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bubbleMenu]);

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
  const myMember = room.members.find((m) => m.userId === myUserId);
  const canManage = canHost || canManageSeats(myMember?.role);
  const hostMember = room.members.find((m) => m.role === "host");
  const hostUserId = hostMember?.userId ?? null;
  const seatMembers = room.members.map((m) => ({
    userId: m.userId,
    label: `${m.name}${m.userId === myUserId ? "（我）" : ""}`,
    projectPath: m.projectPath ?? null,
    aiShare: m.aiShare,
    aiModels: m.aiModels,
    isSelf: m.userId === myUserId,
  }));
  const defaultBindId = myUserId ?? hostUserId ?? "";
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

  const addFiles = async (files: File[]) => {
    if (!hasDesktopApi("getPathForFile") || !hasDesktopApi("readAttachment")) return;
    const desktop = getDesktop();
    const added: Attachment[] = [];
    for (const file of files) {
      try {
        const path = desktop.getPathForFile(file);
        added.push(await desktop.readAttachment(path));
      } catch (e) {
        setAttErr(e instanceof Error ? e.message : String(e));
      }
    }
    let next = [...attachments, ...added];
    if (next.length > 5) {
      setAttErr("最多 5 个附件");
      next = next.slice(0, 5);
    }
    if (added.length) setAttErr(null);
    setAttachments(next);
  };

  const onSend = async () => {
    const t = draft.trim();
    if (!t && attachments.length === 0) return;
    setErr(null);
    // @提及路由：文中 @了某个可对话的 Agent 席位时，直接发给该席位
    // （群里任何人都能 @ 任何未被接管的 Agent，不限席位创建者）。
    const mentionSeat = (() => {
      const m = t.match(/@([^\s@]+)/);
      if (!m) return null;
      const seat = room.seats.find((s) => s.name === m[1]);
      if (!seat || seat.kind !== "agent") return null;
      if (seat.takenOverBy && seat.takenOverBy !== myUserId) return null;
      return seat;
    })();
    const res = await sendToSeat(t, quote ?? undefined, mentionSeat?.id, attachments);
    if (!res.ok) {
      setErr(res.error ?? "发送失败");
      return;
    }
    setDraft("");
    setQuote(null);
    setAttachments([]);
    setAttErr(null);
    setMentionIndex(0);
    setMentionClosed(false);
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
            {offline
              ? t.room.offline
              : room.status === "open"
                ? fillTemplate(t.room.peopleOnline, {
                    n: String(
                      room.onlineCount ?? countOnlineMembers(room.members),
                    ),
                  })
                : "已结束"}
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
        </div>
      </header>

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

      {room.status === "open" ? (
        <RoomPendingBanner roomId={room.roomId} canHost={canHost} />
      ) : null}

      {room.status === "open" && myMember?.aiShare === "pending"
        ? createPortal(
            <div className="room-modal-overlay" role="presentation">
              <div
                className="room-modal"
                role="dialog"
                aria-label="借用 AI 审批"
              >
                <header className="room-modal-head">
                  <h3>借用 AI 审批</h3>
                </header>
                <div className="room-modal-body">
                  <p className="room-leave-text">
                    {room.members.find((m) => m.userId === myMember.aiAskBy)?.name ?? "成员"}{" "}
                    想借用你的 AI 在这个房间里执行任务，是否同意？
                  </p>
                </div>
                <footer className="room-modal-foot">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void setRoomAiShare(room.roomId, false)}
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void setRoomAiShare(room.roomId, true)}
                    autoFocus
                  >
                    同意
                  </button>
                </footer>
              </div>
            </div>,
            document.body,
          )
        : null}

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
          canAdmin={canManage}
          offline={offline}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {invite ? (
        <RoomInviteModal
          code={invite.code}
          port={invite.port}
          listening={invite.listening}
          encrypt={room.encrypt}
          hostFingerprint={room.hostFingerprint}
          onClose={() => setInvite(null)}
        />
      ) : null}

      {addOpen || editSeat ? (
        <RoomAddSeatModal
          agents={settings?.agents ?? []}
          models={settings?.models ?? []}
          members={seatMembers}
          canRetarget={canManage}
          onAskAiShare={(userId) => {
            void askRoomAiShare(room.roomId, userId);
          }}
          initial={
            editSeat ?? {
              name: "",
              agentName: "",
              agentPrompt: "",
              skillNames: [],
              model: "",
              executorUserId: defaultBindId,
              aiUserId: defaultBindId,
              workspaceUserId: defaultBindId,
            }
          }
          onClose={() => {
            setAddOpen(false);
            setEditSeat(null);
          }}
        />
      ) : null}

      {/* ── Body: 主区（时间线+输入框） + 右侧成员面板 ── */}
      <div className="room-body">
        <div className="room-main">
          {/* ── Timeline ── */}
          <div className="room-timeline" ref={timelineRef}>
        {room.items.length === 0 ? (
          <p className="room-stage-empty">还没有消息，选一个席位开始</p>
        ) : (
          room.items.map((it) => {
            const seat = it.seatId ? room.seats.find((s) => s.id === it.seatId) : null;
            const seatName = seat?.name ?? "";
            const isMe = myUserId && it.authorUserId === myUserId;
            const menuable =
              (it.kind === "user" || it.kind === "assistant") && !it.recalled;
            return (
              <div
                key={it.id}
                className={`room-msg${isMe ? " is-me" : ""} kind-${it.kind}${it.seatId && it.seatId === selectedSeatId ? " focus" : ""}`}
                onContextMenu={
                  menuable
                    ? (e) => {
                        e.preventDefault();
                        setBubbleMenu({ x: e.clientX, y: e.clientY, item: it });
                      }
                    : undefined
                }
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
                  {it.recalled ? (
                    <div className="room-msg-text room-recalled">此消息已撤回</div>
                  ) : (
                    <>
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
                      ) : it.kind === "assistant" ? (
                        <div className="room-msg-text md">
                          <MarkdownBody text={it.text} />
                        </div>
                      ) : (
                        <div className="room-msg-text">{renderText(it.text)}</div>
                      )}
                      {/* {it.kind === "user" || it.kind === "assistant" ? (
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
                      ) : null} */}
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
        {/* 工作动效：Agent 席位 running 时在时间线尾部挂打字气泡；
            有实时进度的远端席位改挂流式气泡 */}
        {room.seats
          .filter(
            (s) =>
              s.kind === "agent" &&
              s.running &&
              !(room.liveExec ?? []).some((e) => e.seatId === s.id && e.text),
          )
          .map((s) => (
            <div
              key={`typing-${s.id}`}
              className="room-msg kind-assistant room-typing"
            >
              <div className="room-msg-avatar" aria-hidden>
                <SeatAvatar kind="agent" />
              </div>
              <div className="room-msg-body">
                <div className="room-msg-meta">
                  <span className="room-msg-author">{s.name}</span>
                </div>
                <div className="room-typing-dots" aria-label="正在工作">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          ))}
        {(room.liveExec ?? [])
          .filter((e) => e.text || e.tool)
          .map((e) => {
            const seat = room.seats.find((s) => s.id === e.seatId);
            return (
              <div key={`live-${e.turnId}`} className="room-msg kind-assistant">
                <div className="room-msg-avatar" aria-hidden>
                  <SeatAvatar kind="agent" />
                </div>
                <div className="room-msg-body">
                  <div className="room-msg-meta">
                    <span className="room-msg-author">
                      {seat?.name ?? "Agent"}
                    </span>
                    <span className="room-msg-source">远端实时</span>
                  </div>
                  {e.text ? (
                    <div className="room-msg-text md room-live-text">
                      <MarkdownBody text={e.text} streaming />
                    </div>
                  ) : null}
                  {e.tool ? (
                    <div className="room-live-tool">🔧 {e.tool}</div>
                  ) : null}
                </div>
              </div>
            );
          })}
      </div>

      {err || lastError ? <p className="room-err">{err || lastError}</p> : null}

      {room.remoteChanges && Object.keys(room.remoteChanges).length ? (
        <RoomRemoteChanges
          remoteChanges={room.remoteChanges}
          seats={room.seats}
          memberName={(seat) => {
            const id = seat
              ? resolveWorkspaceUserId(seat, hostUserId ?? "")
              : "";
            return (
              room.members.find((m) => m.userId === id)?.name ?? "成员"
            );
          }}
        />
      ) : null}

      {/* ── Composer ── */}
      <div
        className="room-composer"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) void addFiles(files);
        }}
      >
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
        <div className={dragging ? "room-composer-box dragging" : "room-composer-box"}>
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
          {attachments.length > 0 ? (
            <div className="composer-attachments">
              {attachments.map((a) => (
                <div key={a.path} className="composer-attachment">
                  <span className="composer-attachment-name" title={a.path}>
                    {a.name}
                  </span>
                  <span className="composer-attachment-meta">
                    {formatFileSize(a.size)} · {a.kind}
                  </span>
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    onClick={() =>
                      setAttachments(attachments.filter((x) => x.path !== a.path))
                    }
                    title="移除"
                    aria-label={`移除 ${a.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {attErr ? <div className="composer-attachment-error">{attErr}</div> : null}
          <textarea
            ref={inputRef}
            className="room-input"
            rows={2}
            placeholder={
              selected
                ? `发给「${selected.name}」…  @ 提及，可拖文件进来，Enter 发送`
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
            <button
              type="button"
              className="sendstop-btn sendstop-send"
              disabled={
                room.status !== "open" ||
                offline ||
                (!draft.trim() && attachments.length === 0) ||
                !selected
              }
              onClick={() => void onSend()}
              title="发送"
              aria-label="发送"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M8 13V3.5M8 3.5L3.5 8M8 3.5L12.5 8"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
        </div>

        {/* ── 右侧成员/席位面板（可折叠） ── */}
        <aside className={`room-side${sideOpen ? "" : " collapsed"}`}>
          {sideOpen ? (
            <>
              <div className="room-side-head">
                <span className="room-side-title">
                  成员 {room.memberCount}
                  {room.status === "open"
                    ? ` · ${fillTemplate(t.room.peopleOnline, {
                        n: String(
                          room.onlineCount ?? countOnlineMembers(room.members),
                        ),
                      })}`
                    : ""}
                </span>
                <button
                  type="button"
                  className="room-side-toggle"
                  title="收起成员栏"
                  aria-label="收起成员栏"
                  onClick={() => setSideOpen(false)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M6 3l5 5-5 5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
              <div className="room-side-list" role="tablist" aria-label="席位">
                {room.seats.map((s) => {
                  const active = s.id === selectedSeatId;
                  const isMine =
                    myUserId && s.kind === "human" && s.occupantUserId === myUserId;
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
                      {s.running ? (
                        <span className="room-seat-pulse" aria-hidden />
                      ) : null}
                      {s.kind === "agent" && hostUserId ? (
                        <>
                          {resolveWorkspaceUserId(s, hostUserId) !== hostUserId ? (
                            <span className="room-seat-tag remote">
                              文件·{room.members.find((m) => m.userId === resolveWorkspaceUserId(s, hostUserId))?.name ?? "成员"}
                            </span>
                          ) : null}
                          {resolveAiUserId(s, hostUserId) !==
                          resolveWorkspaceUserId(s, hostUserId) ? (
                            <span className="room-seat-tag">
                              AI·{room.members.find((m) => m.userId === resolveAiUserId(s, hostUserId))?.name ?? "成员"}
                            </span>
                          ) : null}
                        </>
                      ) : null}
                      {s.takenOverBy ? (
                        <span className="room-seat-tag">接管中</span>
                      ) : null}
                      {s.kind === "human" ? (
                        <span
                          className={`room-seat-tag${
                            memberIsOnline(
                              room.members.find(
                                (m) => m.userId === s.occupantUserId,
                              ),
                            )
                              ? ""
                              : " is-offline"
                          }`}
                        >
                          {memberIsOnline(
                            room.members.find(
                              (m) => m.userId === s.occupantUserId,
                            ),
                          )
                            ? t.room.memberOnline
                            : t.room.memberOffline}
                        </span>
                      ) : null}
                      {isMine ? <span className="room-seat-tag mine">我</span> : null}
                      {s.kind === "agent" && room.status === "open" && canManage ? (
                        <span
                          className="room-seat-act"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            const ws = resolveWorkspaceUserId(s, hostUserId ?? defaultBindId);
                            const ai = resolveAiUserId(s, hostUserId ?? defaultBindId);
                            setEditSeat({
                              seatId: s.id,
                              name: s.name,
                              agentName: s.agentName ?? "",
                              agentPrompt: s.agentPrompt ?? "",
                              skillNames: s.skillNames ?? [],
                              model: s.model ?? "",
                              executorUserId: ws,
                              workspaceUserId: ws,
                              aiUserId: ai,
                            });
                          }}
                        >
                          {t.room.seatSettings}
                        </span>
                      ) : null}
                      {s.kind === "agent" && room.status === "open" ? (
                        <span
                          className="room-seat-act"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            void (s.takenOverBy
                              ? returnSeat(s.id)
                              : takeoverSeat(s.id));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.stopPropagation();
                              void (s.takenOverBy
                                ? returnSeat(s.id)
                                : takeoverSeat(s.id));
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
                  <button
                    type="button"
                    className="room-seat add"
                    onClick={() => setAddOpen(true)}
                  >
                    + 席位
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <button
              type="button"
              className="room-side-toggle room-side-expand"
              title="展开成员栏"
              aria-label="展开成员栏"
              onClick={() => setSideOpen(true)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M10 3l-5 5 5 5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="room-side-count">
                {room.onlineCount ?? countOnlineMembers(room.members)}
              </span>
            </button>
          )}
        </aside>
      </div>

      {bubbleMenu
        ? createPortal(
            <div
              className="tab-menu-overlay"
              onClick={() => setBubbleMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setBubbleMenu(null);
              }}
            >
              <div
                className="tab-menu"
                role="menu"
                style={{ left: bubbleMenu.x, top: bubbleMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void navigator.clipboard?.writeText(bubbleMenu.item.text);
                    setBubbleMenu(null);
                  }}
                >
                  复制
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setQuote({
                      id: bubbleMenu.item.id,
                      authorLabel: bubbleMenu.item.authorLabel,
                      text: bubbleMenu.item.text.slice(0, 120),
                    });
                    setBubbleMenu(null);
                    inputRef.current?.focus();
                  }}
                >
                  引用
                </button>
                {canHost ||
                (bubbleMenu.item.authorUserId &&
                  bubbleMenu.item.authorUserId === myUserId) ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-danger"
                    onClick={() => {
                      const itemId = bubbleMenu.item.id;
                      setBubbleMenu(null);
                      void recallRoomMessage(room.roomId, itemId).then((res) => {
                        if (!res.ok) setErr(res.error ?? "撤回失败");
                      });
                    }}
                  >
                    撤回
                  </button>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
