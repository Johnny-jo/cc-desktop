import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment, RoomQuoteRef, RoomSeat, RoomTimelineItem } from "@claude-desktop/shared";
import { formatFileSize, validateRoomMentions } from "@claude-desktop/shared";
import { useAppStore } from "../state/store";
import {
  askRoomAiShare,
  controlRoomTask,
  recallRoomMessage,
  rejoinRoom,
  selectSeat,
  sendToSeat,
  setRoomAiShare,
  stopRoomSeat,
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
import { resolveRoomComposeTargets } from "../lib/room-compose";
import { editRoomMentionDraft, insertRoomMention, reconcileRoomMentionDraft, type RoomDraftEdit, type RoomMentionDraft } from "../lib/room-mention-draft";
import {
  contextLevel,
  formatContextPercent,
  formatTokens,
} from "../lib/format-usage";
import { useI18n } from "../i18n/useI18n";
import { ModPlayPanel } from "./ModPlayPanel";
import { RoomAddSeatModal, type SeatDraft } from "./RoomAddSeatModal";
import { RoomInviteModal } from "./RoomInviteModal";
import { RoomPendingBanner } from "./RoomPendingBanner";
import { RoomRemoteChanges } from "./RoomRemoteChanges";
import { RoomSettingsModal } from "./RoomSettingsModal";
import { RoomTimeline, SeatAvatar, resolveRoomMessageAuthorSeat } from "./RoomTimeline";
import { RoomTaskPanel, summarizeRoomTasks } from "./RoomTaskPanel";
import { RoomCollaborationSidebar, type RoomCollaborationTab } from "./RoomCollaborationSidebar";
import "./RoomWorkspace.css";

const MAX_ROOM_COMPOSER_FILES = 5;
const MAX_ROOM_COMPOSER_FILE_SIZE = 10 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_SIZE = 5 * 1024 * 1024;
const CLIPBOARD_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function RoomStage() {
  const { t } = useI18n();
  const room = useRoomStore((s) => s.activeRoom);
  const selectedSeatId = useRoomStore((s) => s.selectedSeatId);
  const rooms = useRoomStore((s) => s.rooms);
  const reconnectNote = useRoomStore((s) => s.reconnectNote);
  const lastError = useRoomStore((s) => s.lastError);
  const settings = useAppStore((s) => s.settings);
  const [composer, setComposer] = useState<RoomMentionDraft>({ text: "", mentions: [] });
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const draft = composer.text;
  const [caret, setCaret] = useState(0);
  const pendingEdit = useRef<RoomDraftEdit | null>(null);
  const [pendingTaskKeys, setPendingTaskKeys] = useState<string[]>([]);
  const pendingTaskRefs = useRef(new Set<string>());
  // A new object also distinguishes A → B → A from the first visit to A.
  const roomGenerationRef = useRef({ roomId: room?.roomId });
  if (roomGenerationRef.current.roomId !== room?.roomId) roomGenerationRef.current = { roomId: room?.roomId };
  const roomGeneration = roomGenerationRef.current;
  const [submission, setSubmission] = useState<{ generation: typeof roomGeneration } | null>(null);
  const sendingRef = useRef<typeof submission>(null);
  const submitting = submission?.generation === roomGeneration;
  const [invite, setInvite] = useState<{
    code: string;
    port?: number;
    listening: boolean;
  } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editSeat, setEditSeat] = useState<SeatDraft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsEpochRef = useRef(0);
  const [sideOpen, setSideOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 960);
  const [sideTab, setSideTab] = useState<RoomCollaborationTab>("tasks");
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const sideToggleRef = useRef<HTMLButtonElement | null>(null);
  const [quote, setQuote] = useState<RoomQuoteRef | null>(null);
  // 拖拽进来的待发送附件（复用主对话的 readAttachment 管道）
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentReads = useRef({ roomId: room?.roomId, pending: 0, reserved: 0 });
  if (attachmentReads.current.roomId !== room?.roomId) attachmentReads.current = { roomId: room?.roomId, pending: 0, reserved: 0 };
  const [attachmentProgress, setAttachmentProgress] = useState({ roomId: room?.roomId, pending: 0 });
  const preparingAttachments = attachmentProgress.roomId === room?.roomId && attachmentProgress.pending > 0;
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
  const livePinKey = (room?.liveExec ?? [])
    .map((entry) =>
      `${entry.turnId}:${entry.text.length}:${entry.thinking?.length ?? 0}:${entry.tool ?? ""}`,
    )
    .join("|");
  const timelinePinKey = lastItem
    ? `${lastItem.id}:${lastItem.text?.length ?? 0}:${runningCount}:${livePinKey}`
    : `0:${runningCount}:${livePinKey}`;
  const openBubbleMenu = useCallback(
    (item: RoomTimelineItem, x: number, y: number) => {
      setBubbleMenu({ x, y, item });
    },
    [],
  );

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const pin = () => {
      el.scrollTop = el.scrollHeight;
    };
    pin();
    requestAnimationFrame(pin);
  }, [room?.roomId, timelinePinKey]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    let wasCompact = false;
    const updateWidth = (width: number) => {
      if (!width) return;
      const compact = width <= 820;
      if (compact && !wasCompact) setSideOpen(false);
      wasCompact = compact;
    };
    updateWidth(workspace.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => updateWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [room?.roomId]);

  // 气泡菜单：点击别处 / Esc 关闭
  useEffect(() => {
    if (!bubbleMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBubbleMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bubbleMenu]);

  useEffect(() => {
    setComposer({ text: "", mentions: [] });
    setCaret(0);
    setQuote(null);
    setAttachments([]);
    setAttErr(null);
    setErr(null);
    setMentionClosed(false);
    pendingEdit.current = null;
    const input = inputRef.current;
    if (!input) return;
    // Native beforeinput includes replacement/IME/delete ranges that a text diff loses.
    const beforeInput = (event: Event) => {
      pendingEdit.current = { start: input.selectionStart, end: input.selectionEnd, inputType: (event as InputEvent).inputType };
    };
    input.addEventListener("beforeinput", beforeInput);
    return () => input.removeEventListener("beforeinput", beforeInput);
  }, [room?.roomId]);

  if (!room) {
    return (
      <div className="room-stage room-workspace" ref={workspaceRef}>
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
            每个席位可以是一个成员或 Agent，点击席位即可快速 @ 对方。
          </p>
        </div>
      </div>
    );
  }

  const myRole = rooms.find((r) => r.roomId === room.roomId)?.role ?? "member";
  const offline = Boolean(
    rooms.find((r) => r.roomId === room.roomId)?.offline,
  );
  const canHost = myRole === "host";
  const myUserId = room.localUserId;
  const myMember = room.members.find((m) => m.userId === myUserId);
  const composeTargets = resolveRoomComposeTargets(
    draft, room.seats, myUserId, selectedSeatId, composer.mentions,
  );
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
  const taskSummary = summarizeRoomTasks(room);
  const sideId = `room-collaboration-${room.roomId}`;
  const mentionListId = `room-mentions-${room.roomId}`;
  const onSideOpenChange = (open: boolean) => {
    setSideOpen(open);
    if (!open) sideToggleRef.current?.focus();
  };

  const mention = room.status === "open" ? parseTrailingAt(draft.slice(0, caret)) : null;
  const mentionMatches = mention
    ? room.seats.filter((s) =>
        s.name.toLowerCase().includes(mention.query.toLowerCase()),
      )
    : [];
  const mentionOpen = Boolean(mention && !mentionClosed && mentionMatches.length);
  const mentionSel = mentionMatches.length
    ? mentionIndex % mentionMatches.length
    : 0;

  const insertMention = (seat: RoomSeat, start: number, end: number) => {
    if (room.status !== "open" || offline) return;
    const next = insertRoomMention(composer, start, end, seat);
    const nextCaret = start + next.text.length - (draft.length - (end - start));
    setComposer(next);
    setCaret(nextCaret);
    pendingEdit.current = null;
    setMentionIndex(0);
    setMentionClosed(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const pickMention = (seat: RoomSeat) => {
    if (mention) insertMention(seat, mention.start, inputRef.current?.selectionEnd ?? caret);
  };

  const mentionFromSeat = (seat: RoomSeat) => {
    if (seat.kind === "agent") selectSeat(seat.id);
    const input = inputRef.current;
    const selectionStart = input?.selectionStart ?? draft.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    insertMention(seat, selectionStart, selectionEnd);
  };

  const onTaskControl = async (args: Parameters<typeof controlRoomTask>[0]) => {
    const key = args.taskId ?? "policy";
    const scopedKey = `${args.roomId}:${key}`;
    if (pendingTaskRefs.current.has(scopedKey)) return;
    pendingTaskRefs.current.add(scopedKey);
    setPendingTaskKeys(current => [...current, scopedKey]);
    setErr(null);
    try {
      const result = await controlRoomTask(args);
      if (!result.ok) setErr(result.error ?? "任务操作失败");
    } finally {
      pendingTaskRefs.current.delete(scopedKey);
      setPendingTaskKeys(current => current.filter(k => k !== scopedKey));
    }
  };

  const addFiles = async (files: File[], fromClipboard = false) => {
    if (room.status !== "open" || offline) return;
    if (!hasDesktopApi("getPathForFile") && !hasDesktopApi("saveClipboardImage")) return;
    const desktop = getDesktop();
    const added: Attachment[] = [];
    const errors: string[] = [];
    const batch = attachmentReads.current;
    const prepared: { file: File; path: string }[] = [];
    const available = Math.max(0, MAX_ROOM_COMPOSER_FILES - attachments.length - batch.reserved);
    // Validate and reserve the whole selection before reading bytes or allocating base64.
    for (const file of files) {
      if (prepared.length >= available) {
        errors.push("最多 5 个附件");
        break;
      }
      try {
        const path = hasDesktopApi("getPathForFile") ? desktop.getPathForFile(file) : "";
        if (path) {
          if (file.size > MAX_ROOM_COMPOSER_FILE_SIZE) throw new Error("单个附件最大 10 MiB");
          if (!hasDesktopApi("readAttachment")) throw new Error("当前版本无法读取附件");
        } else if (fromClipboard && file.type.startsWith("image/")) {
          if (!CLIPBOARD_IMAGE_TYPES.has(file.type)) throw new Error("剪贴板图片仅支持 PNG、JPEG、WebP、GIF");
          if (!file.size) throw new Error("剪贴板图片为空");
          if (file.size > MAX_CLIPBOARD_IMAGE_SIZE) throw new Error("剪贴板图片最大 5 MiB");
          if (!hasDesktopApi("saveClipboardImage")) throw new Error("当前版本无法保存剪贴板图片");
        } else {
          throw new Error("无法获取文件路径，请从文件管理器拖入文件");
        }
        prepared.push({ file, path });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    setAttErr(errors.length ? errors.join("；") : null);
    if (!prepared.length) return;
    batch.pending++;
    batch.reserved += prepared.length;
    setAttachmentProgress({ ...batch });
    try {
      for (const { file, path } of prepared) {
        if (attachmentReads.current !== batch) return;
        try {
          if (path) {
            added.push(await desktop.readAttachment(path));
          } else {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
              reader.onabort = () => reject(new Error("图片读取已取消"));
              reader.readAsDataURL(file);
            });
            if (attachmentReads.current !== batch) return;
            // This API returns an Attachment directly, including its locally saved path.
            added.push(await desktop.saveClipboardImage(dataUrl.slice(dataUrl.indexOf(",") + 1), file.type));
          }
        } catch (e) {
          if (attachmentReads.current !== batch) return;
          const message = e instanceof Error ? e.message : String(e);
          setAttErr(current => current ? `${current}；${message}` : message);
        }
      }
      if (attachmentReads.current !== batch) return;
      if (added.length) setAttachments(current => [...current, ...added]);
    } finally {
      batch.pending--;
      batch.reserved -= prepared.length;
      if (attachmentReads.current === batch) setAttachmentProgress({ ...batch });
    }
  };

  const onSend = async () => {
    if (sendingRef.current?.generation === roomGeneration || attachmentReads.current.pending || room.status !== "open" || offline) return;
    const text = draft;
    if (!text.trim() && attachments.length === 0) return;
    setErr(null);
    const request = { generation: roomGeneration };
    const isCurrentSubmission = () => roomGenerationRef.current === roomGeneration && sendingRef.current === request;
    sendingRef.current = request;
    setSubmission(request);
    try {
      if (/(^|\s)\/stop\b/.test(text)) {
        if (!composeTargets.stopSeatIds.length) {
          setErr("请从 @ 候选中选择 Agent，或选中一个 Agent 后使用 /stop");
          return;
        }
        const results = await Promise.all(composeTargets.stopSeatIds.map(async (id) => {
          try {
            const res = await stopRoomSeat(id);
            return res.ok ? "" : `${room.seats.find(s => s.id === id)?.name ?? id}：${res.error ?? "停止失败"}`;
          } catch (error) {
            return `${room.seats.find(s => s.id === id)?.name ?? id}：${String(error)}`;
          }
        }));
        if (!isCurrentSubmission()) return;
        const failures = results.filter(Boolean);
        if (failures.length) {
          setErr(failures.join("；"));
          return;
        }
      } else {
        if (!composeTargets.sendSeatId) {
          setErr("没有可用的发言席位，请重新加入群聊");
          return;
        }
        // Submit once; the host resolves all mentioned Agents independently.
        const res = await sendToSeat(text, quote ?? undefined, composeTargets.sendSeatId, attachments, validateRoomMentions(text, composer.mentions, room.seats));
        if (!isCurrentSubmission()) return;
        if (!res.ok) {
          setErr(res.error ?? "发送失败");
          return;
        }
      }
      if (composerRef.current === composer) {
        setComposer(current => current === composer ? { text: "", mentions: [] } : current);
        setMentionIndex(0);
        setMentionClosed(false);
      }
      setQuote(current => current === quote ? null : current);
      setAttachments(current => current.filter(a => !attachments.includes(a)));
      setAttErr(current => current === attErr ? null : current);
    } catch (error) {
      if (isCurrentSubmission()) setErr(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentSubmission()) {
        sendingRef.current = null;
        setSubmission(current => current === request ? null : current);
      }
    }
  };

  const onInvite = async () => {
    const settingsEpoch = settingsEpochRef.current;
    if (!hasDesktopApi("getRoomInvite")) return { ok: false, error: "邀请功能需要新版主进程，请重启应用" };
    const inv = await getDesktop().getRoomInvite(room.roomId);
    if (!inv.ok) {
      return { ok: false, error: inv.error ?? "只有群主可以邀请" };
    }
    if (!inv.secret) {
      return { ok: false, error: "生成邀请码失败，请重试" };
    }
    if (roomGenerationRef.current !== roomGeneration) return { ok: false, error: "群聊已切换，请重新邀请" };
    if (settingsEpochRef.current !== settingsEpoch) return { ok: false, error: "邀请请求已取消" };
    setInvite({
      code: inv.secret,
      port: inv.port,
      listening: inv.listening !== false,
    });
    return { ok: true };
  };

  return (
    <div className="room-stage room-workspace" ref={workspaceRef}>
      {/* ── Header ── */}
      <header className="room-stage-head">
        <div className="room-stage-title">
          <div className="room-stage-name-row">
            <span className="chat-title" title={room.name}>{room.name}</span>
          </div>
        </div>
        <div className="room-stage-actions">
          <button ref={sideToggleRef} type="button" className="room-head-icon-btn room-collaboration-toggle"
            title={`${sideOpen ? "收起协作侧栏" : "展开协作侧栏"}${taskSummary.approvals ? ` · ${taskSummary.approvals} 项待我确认` : ""}`}
            aria-label={sideOpen ? "收起协作侧栏" : "展开协作侧栏"}
            aria-description={taskSummary.approvals ? `${taskSummary.approvals} 项待我确认` : undefined}
            aria-expanded={sideOpen} aria-controls={sideId} onClick={() => {
              if (!sideOpen && taskSummary.approvals) setSideTab("tasks");
              onSideOpenChange(!sideOpen);
            }}>
            <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden>
              <rect x="2" y="3" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M11 3v12" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            {taskSummary.approvals ? <span className="room-collaboration-alert" aria-hidden /> : null}
          </button>
          <button
            type="button"
            className="room-head-icon-btn"
            title="群聊设置"
            aria-label="群聊设置"
            onClick={() => { settingsEpochRef.current += 1; setSettingsOpen(true); }}
          >
            <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M6.7 2.2h2.6l.4 1.45c.4.16.77.38 1.1.64l1.45-.38 1.3 2.25-1.05 1.07c.07.42.07.84 0 1.26l1.05 1.07-1.3 2.25-1.45-.38c-.33.26-.7.48-1.1.64l-.4 1.45H6.7l-.4-1.45a5.2 5.2 0 0 1-1.1-.64l-1.45.38-1.3-2.25L3.5 8.49a4 4 0 0 1 0-1.26L2.45 6.16l1.3-2.25 1.45.38c.33-.26.7-.48 1.1-.64l.4-1.45Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
              <circle cx="8" cy="7.86" r="1.75" stroke="currentColor" strokeWidth="1.25" />
            </svg>
          </button>
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

      {settingsOpen ? (
        <RoomSettingsModal
          room={room}
          canHost={canHost}
          canAdmin={canManage}
          offline={offline}
          onInvite={onInvite}
          suspended={Boolean(invite)}
          onClose={() => { settingsEpochRef.current += 1; setSettingsOpen(false); }}
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

      {/* ── Body: 时间线 / 输入框 + 协作侧栏 ── */}
      <div className="room-body">
        <div className="room-main">
          {/* ── Timeline ── */}
          <RoomTimeline
            roomId={room.roomId}
            items={room.items}
            seats={room.seats}
            liveExec={room.liveExec}
            selectedSeatId={selectedSeatId}
            myUserId={myUserId}
            timelineRef={timelineRef}
            onOpenMenu={openBubbleMenu}
            onMentionSeat={mentionFromSeat}
          />

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
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) { e.preventDefault(); void addFiles(files); }
        }}
      >
        {mentionOpen ? (
          <ul id={mentionListId} className="slash-menu at-menu" role="listbox" aria-label="提及席位">
            {mentionMatches.map((s, i) => (
              <li key={s.id} role="presentation">
                <button
                  type="button"
                  id={`${mentionListId}-${s.id}`}
                  role="option"
                  aria-selected={i === mentionSel}
                  className={i === mentionSel ? "slash-item active" : "slash-item"}
                  onMouseEnter={() => setMentionIndex(i)}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => pickMention(s)}
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
          {preparingAttachments ? <div className="room-attachment-progress" role="status" aria-live="polite">正在准备附件…</div> : null}
          {submitting ? <div className="room-attachment-progress" role="status" aria-live="polite">正在发送并等待确认</div> : null}
          <textarea
            ref={inputRef}
            className="room-input"
            aria-label="群聊消息"
            aria-autocomplete="list"
            aria-controls={mentionOpen ? mentionListId : undefined}
            aria-activedescendant={mentionOpen ? `${mentionListId}-${mentionMatches[mentionSel].id}` : undefined}
            rows={2}
            placeholder="发送消息，从 @ 候选中选择成员或 Agent；/stop 停止，Enter 发送"
            value={draft}
            disabled={room.status !== "open" || offline}
            onSelect={event => setCaret(event.currentTarget.selectionStart)}
            onBeforeInput={event => {
              const input = event.currentTarget;
              pendingEdit.current = { start: input.selectionStart, end: input.selectionEnd, inputType: (event.nativeEvent as InputEvent).inputType ?? "insertText" };
            }}
            onPaste={event => {
              event.preventDefault();
              const files = Array.from(event.clipboardData.files);
              if (files.length) return addFiles(files, true);
              const text = event.clipboardData.getData("text/plain");
              const { selectionStart: start, selectionEnd: end } = event.currentTarget;
              setComposer(current => editRoomMentionDraft(current, start, end, text));
              pendingEdit.current = null;
              setCaret(start + text.length);
              setMentionClosed(true);
              requestAnimationFrame(() => inputRef.current?.setSelectionRange(start + text.length, start + text.length));
            }}
            onInput={(e) => {
              // Same-value replacements still emit input; React may omit onChange.
              const text = e.currentTarget.value;
              const edit = pendingEdit.current;
              pendingEdit.current = null;
              setComposer(current => reconcileRoomMentionDraft(current, text, edit));
              setCaret(e.currentTarget.selectionStart);
              setMentionIndex(0);
              setMentionClosed(false);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
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
                  if (pick) pickMention(pick);
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
                submitting ||
                preparingAttachments ||
                (!draft.trim() && attachments.length === 0) ||
                !composeTargets.sendSeatId
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
        {/* <div className="room-composer-foot">Enter 发送 · Shift + Enter 换行 · 可粘贴截图或拖入文件</div> */}
      </div>
        </div>

        <RoomCollaborationSidebar
          id={sideId} open={sideOpen} activeTab={sideTab} onOpenChange={onSideOpenChange} onTabChange={setSideTab}
          taskCount={taskSummary.active} seatCount={room.seats.length}
          tasks={<RoomTaskPanel room={room} offline={offline}
            pendingKeys={pendingTaskKeys.filter(key => key.startsWith(`${room.roomId}:`)).map(key => key.slice(room.roomId.length + 1))}
            onControl={args => { void onTaskControl(args); }}
          />}
          activity={modActive ? <ModPlayPanel role={myRole} seats={room.seats} localUserId={myUserId} /> : (
            <div className="room-collaboration-empty">
              <strong>本群暂无活动</strong>
              <p>群主启用 Mod 后，可在这里查看活动和参与设置。</p>
            </div>
          )}
          members={<>
              <div className="room-members-heading">
                <div className="room-side-heading">
                  <span className="room-side-title">席位 {room.seats.length}</span>
                  <span className="room-side-subtitle">
                    {room.memberCount} 位成员
                    {room.status === "open"
                      ? ` · ${fillTemplate(t.room.peopleOnline, {
                          n: String(
                            room.onlineCount ?? countOnlineMembers(room.members),
                          ),
                        })}`
                      : ""}
                  </span>
                </div>
              </div>
              <div className="room-side-list" aria-label="席位">
                {room.seats.map((s) => {
                  const active = s.id === selectedSeatId;
                  const isMine =
                    myUserId && s.kind === "human" && s.occupantUserId === myUserId;
                  const seatMember =
                    s.kind === "human"
                      ? room.members.find((m) => m.userId === s.occupantUserId)
                      : null;
                  const seatOnline = s.kind === "human" && memberIsOnline(seatMember);
                  return (
                    <div
                      key={s.id}
                      role="button"
                      aria-label={`提及 ${s.name}`}
                      tabIndex={0}
                      className={`room-seat${active ? " active" : ""}${s.kind === "agent" ? " is-agent" : ""}${s.running ? " is-running" : ""}${isMine ? " is-mine" : ""}`}
                      onClick={() => mentionFromSeat(s)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          mentionFromSeat(s);
                        }
                      }}
                    >
                      <div className="room-seat-main-row">
                        <span className="room-seat-avatar" aria-hidden>
                          <SeatAvatar kind={s.kind} />
                        </span>
                        <span className="room-seat-copy">
                          <span className="room-seat-name">{s.name}</span>
                          <span className="room-seat-inline-tags">
                            {s.kind === "human" && !seatOnline ? (
                              <span className="room-seat-tag is-offline">{t.room.memberOffline}</span>
                            ) : null}
                            {isMine ? <span className="room-seat-tag mine">我</span> : null}
                            {s.kind === "agent" && s.contextUsage === null ? (
                              <span className="room-seat-tag ctx" title="上下文已压缩，等待下一次真实用量更新">已压缩，待新用量</span>
                            ) : null}
                            {s.kind === "agent" && s.contextUsage ? (
                              <span
                                className={`room-seat-tag ctx is-${contextLevel(s.contextUsage.ratio)}`}
                                title={`席位上下文已用 ${formatContextPercent(s.contextUsage.ratio)}（${formatTokens(s.contextUsage.usedTokens)} / ${formatTokens(s.contextUsage.limitTokens)}）；超过 75% 会自动压缩`}
                              >
                                ctx {formatContextPercent(s.contextUsage.ratio)}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        {s.running ? (
                          <span className="room-seat-pulse" aria-hidden />
                        ) : null}
                      </div>
                      <div className="room-seat-tags">
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
                      </div>
                      {s.kind === "agent" && room.status === "open" && canManage ? (
                        <div className="room-seat-actions">
                          <button
                            type="button"
                            className="room-seat-act"
                            title={t.room.seatSettings}
                            aria-label={`${s.name} ${t.room.seatSettings}`}
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
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                              <path d="M6.7 2.2h2.6l.4 1.45c.4.16.77.38 1.1.64l1.45-.38 1.3 2.25-1.05 1.07c.07.42.07.84 0 1.26l1.05 1.07-1.3 2.25-1.45-.38c-.33.26-.7.48-1.1.64l-.4 1.45H6.7l-.4-1.45a5.2 5.2 0 0 1-1.1-.64l-1.45.38-1.3-2.25L3.5 8.49a4 4 0 0 1 0-1.26L2.45 6.16l1.3-2.25 1.45.38c.33-.26.7-.48 1.1-.64l.4-1.45Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
                              <circle cx="8" cy="7.86" r="1.75" stroke="currentColor" strokeWidth="1.25" />
                            </svg>
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {room.status === "open" ? (
                  <button
                    type="button"
                    className="room-seat add room-seat-add"
                    onClick={() => setAddOpen(true)}
                  >
                    + 添加 Agent 席位
                  </button>
                ) : null}
              </div>
          </>}
        />
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
                {resolveRoomMessageAuthorSeat(bubbleMenu.item, room.seats) ? <button
                  type="button" role="menuitem"
                  onClick={() => {
                    const authorSeat = resolveRoomMessageAuthorSeat(bubbleMenu.item, room.seats);
                    if (authorSeat) mentionFromSeat(authorSeat);
                    setBubbleMenu(null);
                  }}
                >提及</button> : null}
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
