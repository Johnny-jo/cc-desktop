import { useSyncExternalStore } from "react";
import type {
  Attachment,
  ModOfferPayload,
  RoomListItem,
  RoomLivePatch,
  RoomQuoteRef,
  RoomSnapshot,
} from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import {
  isRoomMuted,
  roomNotifyBody,
  roomNotifyDecision,
} from "../lib/room-notify";
import { clearActiveSession, clearChangesSessionOverride, detachedWindowRoomId, detachedWindowSessionId } from "./store";
import { syncRoomSeatSessions } from "./room-changes-bridge";

export type RoomModState = {
  offer?: ModOfferPayload;
  publicView?: unknown;
  seatViews?: Record<string, unknown>;
  seq?: number;
  fail?: string;
  actions?: Record<string, { params?: unknown; hint?: string }>;
};

export type RoomModPack = {
  id: string;
  name: string;
  version: string;
  checksum: string;
  packDir: string;
  source: "bundled" | "cache";
  hostApi?: 1 | 2;
};

export type RoomPendingDevice = { fp: string; name: string };

type RoomUiState = {
  rooms: RoomListItem[];
  activeRoomId: string | null;
  activeRoom: RoomSnapshot | null;
  selectedSeatId: string | null;
  lastError: string | null;
  /** Modal: create | join | null */
  dialog: "create" | "join" | null;
  /** Banner while guest reconnects */
  reconnectNote: string | null;
  mod: RoomModState | null;
  /** Host side: devices waiting for approval in the active room */
  pendingDevices: RoomPendingDevice[];
  /** Host side: a known device came back with a new fingerprint */
  fingerprintChanged: boolean;
  /** Guest join dialog: waiting for host approval */
  joinPhase: "pending-approval" | null;
};

const state: RoomUiState = {
  rooms: [],
  activeRoomId: null,
  activeRoom: null,
  selectedSeatId: null,
  lastError: null,
  dialog: null,
  reconnectNote: null,
  mod: null,
  pendingDevices: [],
  fingerprintChanged: false,
  joinPhase: null,
};

const modsByRoom = new Map<string, RoomModState>();
const pendingByRoom = new Map<
  string,
  { devices: RoomPendingDevice[]; fingerprintChanged: boolean }
>();
/** 每个房间已见过的最后一条时间线消息 id —— 桌面通知的新消息差分游标。 */
const lastItemIdByRoom = new Map<string, string>();
/** Bumped on every pending write so in-flight list fetches cannot clobber live events. */
let pendingEpoch = 0;

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<RoomUiState>) {
  Object.assign(state, patch);
  emit();
}

/** 在群聊侧栏显示一条错误（如旧主进程缺新 IPC 时的降级提示）。 */
export function setRoomError(message: string | null): void {
  set({ lastError: message });
}

export function useRoomStore<T>(sel: (s: RoomUiState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sel(state),
    () => sel(state),
  );
}

export function getRoomState(): RoomUiState {
  return state;
}

export function openRoomDialog(kind: "create" | "join"): void {
  set({ dialog: kind, lastError: null });
}

export function closeRoomDialog(): void {
  set({ dialog: null });
}

function pickDefaultSeat(room: RoomSnapshot | null | undefined): string | null {
  if (!room) return null;
  const mine = room.localUserId;
  return (
    room.seats.find(
      (s) => s.kind === "human" && (!mine || s.occupantUserId === mine),
    )?.id ??
    room.seats.find((s) => s.kind === "agent")?.id ??
    room.seats[0]?.id ??
    null
  );
}

export function selectRoom(roomId: string | null): void {
  if (roomId) clearActiveSession();
  if (!roomId) {
    syncRoomSeatSessions(null, []);
    clearChangesSessionOverride();
  }
  const pending = roomId ? pendingByRoom.get(roomId) : undefined;
  set({
    activeRoomId: roomId,
    selectedSeatId: null,
    reconnectNote: null,
    lastError: null,
    mod: roomId ? (modsByRoom.get(roomId) ?? null) : null,
    pendingDevices: pending?.devices ?? [],
    fingerprintChanged: pending?.fingerprintChanged ?? false,
  });
  if (roomId && hasDesktopApi("getRoom")) {
    void getDesktop()
      .getRoom(roomId)
      .then((r) => {
        const room = r.room;
        if (room) {
          syncRoomSeatSessions(
            room.roomId,
            room.seats.map((s) => s.sessionId),
          );
        }
        set({
          activeRoom: room,
          selectedSeatId: state.selectedSeatId ?? pickDefaultSeat(room),
          mod: modsByRoom.get(roomId) ?? state.mod,
        });
      })
      .catch(() => undefined);
  } else {
    set({ activeRoom: null, mod: null });
  }
}

export function selectSeat(seatId: string | null): void {
  set({ selectedSeatId: seatId });
}

/** Host side: replace the approval queue for a room (IPC event or poll). */
export function getPendingEpoch(): number {
  return pendingEpoch;
}

export function setRoomPending(
  roomId: string,
  devices: RoomPendingDevice[],
  fingerprintChanged = false,
): void {
  pendingEpoch += 1;
  if (!devices.length && !fingerprintChanged) pendingByRoom.delete(roomId);
  else pendingByRoom.set(roomId, { devices, fingerprintChanged });
  if (state.activeRoomId === roomId) {
    const cur = pendingByRoom.get(roomId);
    set({
      pendingDevices: cur?.devices ?? [],
      fingerprintChanged: cur?.fingerprintChanged ?? false,
    });
  }
}

export async function refreshRooms(): Promise<void> {
  if (!hasDesktopApi("listRooms")) return;
  try {
    const { rooms } = await getDesktop().listRooms();
    set({ rooms });
    if (state.activeRoomId) {
      const fresh = await getDesktop().getRoom(state.activeRoomId);
      if (fresh.room) {
        set({ activeRoom: fresh.room });
      } else {
        // Room deleted on disk
        set({ activeRoomId: null, activeRoom: null });
      }
    }
  } catch {
    // ignore
  }
}

/**
 * 桌面通知：对快照做尾部差分，别人发的新消息弹系统通知；
 * @ 我时正文加 [有人@我] 前缀；免打扰房间只弹 @。
 * 第一次见到某房间（入房/刷新）只记录游标，不补弹历史消息。
 */
function maybeNotifyRoomItems(room: RoomSnapshot): void {
  // 分窗（会话窗/群聊窗）不弹：主窗口常驻，由它统一通知，避免双弹
  if (detachedWindowSessionId() || detachedWindowRoomId()) return;
  const items = room.items;
  const cursor = lastItemIdByRoom.get(room.roomId);
  const tail = items[items.length - 1];
  if (!tail) return;
  if (!cursor) {
    lastItemIdByRoom.set(room.roomId, tail.id);
    return;
  }
  if (cursor === tail.id) return;
  const idx = items.findIndex((i) => i.id === cursor);
  // 游标被 400 条窗口挤出去了：放弃差分，重置到队尾，避免历史消息刷屏
  if (idx < 0) {
    lastItemIdByRoom.set(room.roomId, tail.id);
    return;
  }
  lastItemIdByRoom.set(room.roomId, tail.id);
  if (typeof Notification === "undefined") return;
  const fresh = items.slice(idx + 1);
  if (!fresh.length) return;
  const mySeatName =
    room.seats.find(
      (s) => s.kind === "human" && s.occupantUserId === room.localUserId,
    )?.name ?? null;
  const muted = isRoomMuted(room.roomId);
  const activeFocused = state.activeRoomId === room.roomId && document.hasFocus();
  for (const it of fresh) {
    const d = roomNotifyDecision({
      kind: it.kind,
      authorUserId: it.authorUserId,
      text: it.text,
      recalled: it.recalled,
      myUserId: room.localUserId,
      mySeatName,
      muted,
      isActiveAndFocused: activeFocused,
    });
    if (!d.notify) continue;
    try {
      const n = new Notification(`${room.name} · ${it.authorLabel}`, {
        body: roomNotifyBody(it.text, d.mention),
        silent: false,
      });
      n.onclick = () => {
        window.focus();
        selectRoom(room.roomId);
      };
    } catch {
      // 通知不可用（权限/平台）时静默跳过
    }
  }
}

export function bindRoomEvents(): () => void {
  if (!hasDesktopApi("on")) return () => undefined;
  return getDesktop().on("room:event", (...args: unknown[]) => {
    const ev = args[0] as {
      roomId: string;
      joining?: "pending-approval" | null;
      room?: RoomSnapshot;
      livePatch?: RoomLivePatch;
      closed?: boolean;
      offline?: boolean;
      silent?: boolean;
      reconnecting?: boolean;
      reconnectAttempt?: number;
      error?: boolean;
      message?: string;
      mod?: RoomModState;
      pending?: RoomPendingDevice[];
      fingerprintChanged?: boolean;
    };
    if (ev?.joining === "pending-approval") {
      set({ joinPhase: "pending-approval" });
    }
    if (!ev?.roomId) return;

    // Streaming progress is intentionally a tiny patch: do not rebuild room
    // lists, notifications, seat-session bridges, or the timeline here.
    if (ev.livePatch) {
      if (state.activeRoomId === ev.roomId && state.activeRoom) {
        set({
          activeRoom: {
            ...state.activeRoom,
            liveExec: ev.livePatch.liveExec.length
              ? ev.livePatch.liveExec
              : undefined,
          },
        });
      }
      return;
    }

    // Host approval queue pushes arrive without a snapshot.
    if (ev.pending) {
      setRoomPending(ev.roomId, ev.pending, ev.fingerprintChanged === true);
    }

    // Guest: host left / reconnect exhausted — room + history are kept in main;
    // refresh the list so it shows ended / offline instead of disappearing.
    if (ev.closed) {
      const msg = ev.message ?? "群聊已关闭";
      modsByRoom.delete(ev.roomId);
      const patch: Partial<RoomUiState> = { reconnectNote: null };
      if (ev.offline && state.activeRoomId === ev.roomId && state.activeRoom) {
        patch.activeRoom = { ...state.activeRoom, status: "ended" };
      }
      set(patch);
      void refreshRooms();
      if (!ev.silent) {
        set({ lastError: msg });
      }
      return;
    }

    if (ev.error) {
      set({ lastError: ev.message ?? "群聊操作失败" });
      return;
    }

    if (ev.reconnecting) {
      set({
        reconnectNote:
          ev.message ??
          `正在重连${ev.reconnectAttempt ? `（${ev.reconnectAttempt}/3）` : ""}…`,
      });
      if (ev.room && state.activeRoomId === ev.roomId) {
        set({ activeRoom: ev.room });
      }
      return;
    }

    if (!ev.room) return;
    set({ reconnectNote: null });
    maybeNotifyRoomItems(ev.room);
    if (state.activeRoomId === ev.roomId) {
      syncRoomSeatSessions(
        ev.roomId,
        ev.room.seats.map((s) => s.sessionId),
      );
    }
    const rooms = state.rooms.filter((r) => r.roomId !== ev.roomId);
    const prev = state.rooms.find((r) => r.roomId === ev.roomId);
    rooms.unshift({
      roomId: ev.room.roomId,
      name: ev.room.name,
      status: ev.room.status,
      role: prev?.role ?? "member",
      memberCount: ev.room.memberCount,
      port: ev.room.port,
      inviteHost: ev.room.inviteHost,
    });
    const stillMine =
      state.selectedSeatId &&
      ev.room.seats.some((s) => s.id === state.selectedSeatId);
    if (!ev.room.modChecksum) {
      modsByRoom.delete(ev.roomId);
    } else if (
      ev.mod &&
      (ev.mod.offer?.checksum || ev.mod.fail || ev.mod.publicView !== undefined)
    ) {
      modsByRoom.set(ev.roomId, ev.mod);
    }
    set({
      rooms,
      activeRoom:
        state.activeRoomId === ev.roomId ? ev.room : state.activeRoom,
      ...(state.activeRoomId === ev.roomId && !stillMine
        ? { selectedSeatId: pickDefaultSeat(ev.room) }
        : {}),
      ...(state.activeRoomId === ev.roomId
        ? { mod: modsByRoom.get(ev.roomId) ?? null }
        : {}),
    });
  });
}

export async function createRoom(opts: {
  name: string;
  password?: string;
  port?: number;
  requireMods?: boolean;
  autoApprove?: boolean;
  encrypt?: boolean;
  publicWss?: string;
  tunnel?: boolean;
  relay?: string;
  relayToken?: string;
}): Promise<{ ok: boolean; error?: string; roomId?: string }> {
  if (!hasDesktopApi("createRoom")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  const res = await getDesktop().createRoom(opts);
  if (!res.ok || !res.room) {
    set({ lastError: res.error ?? "创建失败" });
    return { ok: false, error: res.error };
  }
  set({ lastError: null });
  await refreshRooms();
  selectRoom(res.room.roomId);
  return { ok: true, roomId: res.room.roomId };
}

export async function joinRoom(opts: {
  host: string;
  port: number;
  password?: string;
  name?: string;
  modChecksum?: string;
  hosts?: string[];
  wss?: string[];
  hostFingerprint?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("joinRoom")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  set({ joinPhase: null });
  const res = await getDesktop().joinRoom(opts);
  set({ joinPhase: null });
  if (!res.ok || !res.room) {
    set({ lastError: res.error ?? "加入失败" });
    return { ok: false, error: res.error };
  }
  set({ dialog: null, lastError: null });
  await refreshRooms();
  selectRoom(res.room.roomId);
  return { ok: true };
}

/** Member leave or host dismiss (host leave deletes room). */
export async function leaveActiveRoom(): Promise<void> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("leaveRoom")) return;
  modsByRoom.delete(id);
  await getDesktop().leaveRoom(id);
  selectRoom(null);
  await refreshRooms();
}

export async function endActiveRoom(): Promise<void> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("endRoom")) return;
  await getDesktop().endRoom(id);
  selectRoom(null);
  await refreshRooms();
}

export async function addSeat(
  kind: "human" | "agent",
  name: string,
  agentName?: string,
  extra?: {
    agentPrompt?: string;
    skillNames?: string[];
    model?: string;
    executorUserId?: string;
    aiUserId?: string;
    workspaceUserId?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("addRoomSeat")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  const res = await getDesktop().addRoomSeat(id, kind, name, agentName, extra);
  if (res.room) set({ activeRoom: res.room });
  return { ok: res.ok !== false, error: res.error };
}

export async function updateSeat(
  seatId: string,
  patch: {
    name?: string;
    agentName?: string;
    agentPrompt?: string;
    skillNames?: string[];
    model?: string;
    executorUserId?: string;
    aiUserId?: string;
    workspaceUserId?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("updateRoomSeat")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  const res = await getDesktop().updateRoomSeat(id, seatId, patch);
  if (res.room) set({ activeRoom: res.room });
  return { ok: res.ok !== false, error: res.error };
}

export async function rollDice(): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  const seatId = state.selectedSeatId;
  if (!id || !seatId) return { ok: false, error: "请先选一个席位" };
  if (!hasDesktopApi("roomDice")) return { ok: false, error: "请完全重启应用" };
  return getDesktop().roomDice(id, seatId);
}

export async function playRps(
  hand: "rock" | "scissors" | "paper",
): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  const seatId = state.selectedSeatId;
  if (!id || !seatId) return { ok: false, error: "请先选一个席位" };
  if (!hasDesktopApi("roomRps")) return { ok: false, error: "请完全重启应用" };
  return getDesktop().roomRps(id, seatId, hand);
}

export async function sendToSeat(
  text: string,
  quote?: RoomQuoteRef,
  /** 显式目标席位（@提及路由）；缺省用当前选中席位。 */
  targetSeatId?: string,
  /** 拖拽/选择进来的附件；内容只在本机执行的席位上有意义。 */
  attachments?: Attachment[],
): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  const seatId = targetSeatId ?? state.selectedSeatId;
  if (!id || !seatId) return { ok: false, error: "请先选一个席位" };
  if (!hasDesktopApi("sendRoomMessage")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  const res = await getDesktop().sendRoomMessage(id, seatId, text, quote, attachments);
  if (res.ok) set({ lastError: null });
  return res;
}

/** @agent /stop：停止某个 Agent 席位正在跑的输出。 */
export async function stopRoomSeat(
  seatId: string,
): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  if (!id) return { ok: false, error: "没有打开的房间" };
  if (!hasDesktopApi("stopRoomSeat")) {
    return { ok: false, error: "请完全重启应用后再使用" };
  }
  return getDesktop().stopRoomSeat(id, seatId);
}

/** Rejoin a room we dropped from (uses stored join info in main). */
export async function rejoinRoom(
  roomId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("rejoinRoom")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  const res = await getDesktop().rejoinRoom(roomId);
  if (!res.ok) {
    set({ lastError: res.error ?? "重连失败" });
    return { ok: false, error: res.error };
  }
  set({ lastError: null, reconnectNote: null });
  await refreshRooms();
  selectRoom(roomId);
  return { ok: true };
}

/** Host: approve a pending device fingerprint. */
export async function approveRoomDevice(
  roomId: string,
  fingerprint: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("approveRoomDevice")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().approveRoomDevice(roomId, fingerprint);
}

/** Host: deny a pending device fingerprint. */
export async function denyRoomDevice(
  roomId: string,
  fingerprint: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("denyRoomDevice")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().denyRoomDevice(roomId, fingerprint);
}

/** Host: kick a member (connection dropped, device blacklisted). */
export async function kickRoomMember(
  roomId: string,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("kickRoomMember")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().kickRoomMember(roomId, userId);
}

export async function setRoomMemberRole(
  roomId: string,
  userId: string,
  role: "admin" | "member",
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("setRoomMemberRole")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().setRoomMemberRole(roomId, userId, role);
}

export async function setRoomFilePolicy(
  roomId: string,
  policy: import("@claude-desktop/shared").RoomFilePolicy,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("setRoomFilePolicy")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().setRoomFilePolicy(roomId, policy);
}

export async function setRoomAiShare(
  roomId: string,
  on: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("setRoomAiShare")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().setRoomAiShare(roomId, on);
}

export async function askRoomAiShare(
  roomId: string,
  targetUserId: string,
  seatId?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("askRoomAiShare")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().askRoomAiShare(roomId, targetUserId, seatId);
}

/** Host: rename the room; snapshot broadcast refreshes every client. */
export async function renameRoom(
  roomId: string,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("renameRoom")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().renameRoom(roomId, name);
}

/** Recall a message: own messages for anyone; the host can recall any. */
export async function recallRoomMessage(
  roomId: string,
  itemId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("recallRoomMessage")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().recallRoomMessage(roomId, itemId);
}

/** Host: list devices waiting for approval. */
export async function listRoomPending(
  roomId: string,
): Promise<{ ok: boolean; pending: Array<{ fp: string; name: string }> }> {
  if (!hasDesktopApi("listRoomPending")) {
    return { ok: false, pending: [] };
  }
  return getDesktop().listRoomPending(roomId);
}

export async function peekRoom(opts: {
  host: string;
  port: number;
  hosts?: string[];
  wss?: string[];
}): Promise<{ ok: boolean; offer?: ModOfferPayload; error?: string }> {
  if (!hasDesktopApi("peekRoom")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().peekRoom(opts);
}

export async function fetchRoomMod(opts: {
  host: string;
  port: number;
  checksum: string;
  password?: string;
  hostFingerprint?: string;
  hosts?: string[];
  wss?: string[];
}): Promise<{
  ok: boolean;
  checksum?: string;
  offer?: ModOfferPayload;
  error?: string;
}> {
  if (!hasDesktopApi("fetchRoomMod")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  return getDesktop().fetchRoomMod(opts);
}

export async function hasRoomMod(checksum: string): Promise<boolean> {
  if (!hasDesktopApi("hasRoomMod")) return false;
  const res = await getDesktop().hasRoomMod(checksum);
  return Boolean(res.has);
}

export async function listRoomMods(): Promise<RoomModPack[]> {
  if (!hasDesktopApi("listRoomMods")) return [];
  const res = await getDesktop().listRoomMods();
  return res.mods ?? [];
}

export async function disableRoomKernelMod(
  roomId: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("disableRoomKernelMod")) {
    return { ok: false, error: "请完全重启应用后再卸载群聊扩展" };
  }
  const res = await getDesktop().disableRoomKernelMod(roomId, id);
  if (!res.ok) {
    set({ lastError: res.error ?? "卸载扩展失败" });
    return { ok: false, error: res.error };
  }
  if (res.room && state.activeRoomId === roomId) {
    set({ activeRoom: res.room, lastError: null });
  }
  return { ok: true };
}

export async function listRoomKernelMemory(
  roomId: string,
): Promise<{ ok: boolean; entries: Array<{ key: string; value: string }>; error?: string }> {
  if (!hasDesktopApi("listRoomKernelMemory")) {
    return { ok: false, entries: [], error: "请完全重启应用后再查看共享记忆" };
  }
  const res = await getDesktop().listRoomKernelMemory(roomId);
  if (!res.ok) {
    return { ok: false, entries: [], error: res.error };
  }
  return { ok: true, entries: res.entries ?? [] };
}

export async function setRoomKernelMemory(
  roomId: string,
  key: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("setRoomKernelMemory")) {
    return { ok: false, error: "请完全重启应用后再改共享记忆" };
  }
  return getDesktop().setRoomKernelMemory(roomId, key, value);
}

export async function deleteRoomKernelMemory(
  roomId: string,
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("deleteRoomKernelMemory")) {
    return { ok: false, error: "请完全重启应用后再改共享记忆" };
  }
  return getDesktop().deleteRoomKernelMemory(roomId, key);
}

export type KernelImproveProposal = {
  id: string;
  packId: string;
  modJs: string;
  at: number;
  note?: string;
  status: "pending" | "applied" | "rejected" | "failed";
  decision: "pending" | "apply" | "reject";
  error?: string;
};

export type KernelImproveState = {
  autonomy: 0 | 1 | 2;
  proposals: KernelImproveProposal[];
  canRollback: string[];
};

export async function setRoomKernelAutonomy(
  roomId: string,
  level: 0 | 1 | 2,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("setRoomKernelAutonomy")) {
    return { ok: false, error: "请完全重启应用后再改自主权" };
  }
  return getDesktop().setRoomKernelAutonomy(roomId, level);
}

export async function getRoomKernelImprove(
  roomId: string,
): Promise<{ ok: boolean; state?: KernelImproveState; error?: string }> {
  if (!hasDesktopApi("getRoomKernelImprove")) {
    return { ok: false, error: "请完全重启应用后再查看改善提案" };
  }
  const res = await getDesktop().getRoomKernelImprove(roomId);
  if (!res.ok) return { ok: false, error: res.error };
  return {
    ok: true,
    state: {
      autonomy: res.autonomy ?? 0,
      proposals: res.proposals ?? [],
      canRollback: res.canRollback ?? [],
    },
  };
}

export async function proposeRoomKernelImprove(
  roomId: string,
  packId: string,
  modJs: string,
  note?: string,
): Promise<{ ok: boolean; decision?: string; status?: string; error?: string }> {
  if (!hasDesktopApi("proposeRoomKernelImprove")) {
    return { ok: false, error: "请完全重启应用后再提交改善提案" };
  }
  return getDesktop().proposeRoomKernelImprove(roomId, packId, modJs, note);
}

export async function applyRoomKernelProposal(
  roomId: string,
  proposalId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("applyRoomKernelProposal")) {
    return { ok: false, error: "请完全重启应用后再批准提案" };
  }
  return getDesktop().applyRoomKernelProposal(roomId, proposalId);
}

export async function rejectRoomKernelProposal(
  roomId: string,
  proposalId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("rejectRoomKernelProposal")) {
    return { ok: false, error: "请完全重启应用后再拒绝提案" };
  }
  return getDesktop().rejectRoomKernelProposal(roomId, proposalId);
}

export async function rollbackRoomKernelImprove(
  roomId: string,
  packId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("rollbackRoomKernelImprove")) {
    return { ok: false, error: "请完全重启应用后再回滚扩展" };
  }
  return getDesktop().rollbackRoomKernelImprove(roomId, packId);
}

export async function enableRoomKernelMod(
  roomId: string,
  packDir: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("enableRoomKernelMod")) {
    return { ok: false, error: "请完全重启应用后再使用群聊扩展" };
  }
  const res = await getDesktop().enableRoomKernelMod(roomId, packDir);
  if (!res.ok) {
    set({ lastError: res.error ?? "启用扩展失败" });
    return { ok: false, error: res.error };
  }
  if (res.room && state.activeRoomId === roomId) {
    set({ activeRoom: res.room, lastError: null });
  }
  return { ok: true };
}

export async function enableRoomMod(
  roomId: string,
  packDir: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("enableRoomMod")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  const res = await getDesktop().enableRoomMod(roomId, packDir);
  if (!res.ok) {
    set({ lastError: res.error ?? "启用模组失败" });
    return { ok: false, error: res.error };
  }
  if (res.room && state.activeRoomId === roomId) {
    set({ activeRoom: res.room, lastError: null });
  }
  return { ok: true };
}

export async function startRoomMod(): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("startRoomMod")) {
    return { ok: false, error: "请完全重启应用" };
  }
  const res = await getDesktop().startRoomMod(id);
  if (!res.ok) set({ lastError: res.error ?? "开始失败" });
  return res;
}

export async function endRoomMod(): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("endRoomMod")) {
    return { ok: false, error: "请完全重启应用" };
  }
  const res = await getDesktop().endRoomMod(id);
  if (!res.ok) set({ lastError: res.error ?? "结束失败" });
  else modsByRoom.delete(id);
  if (res.ok && state.activeRoomId === id) {
    const fresh = hasDesktopApi("getRoom")
      ? await getDesktop().getRoom(id).catch(() => ({ room: null }))
      : { room: null };
    set({
      mod: null,
      lastError: null,
      ...(fresh.room ? { activeRoom: fresh.room } : {}),
    });
  }
  return res;
}

export async function resetRoomMod(): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("resetRoomMod")) {
    return { ok: false, error: "请完全重启应用" };
  }
  const res = await getDesktop().resetRoomMod(id);
  if (!res.ok) set({ lastError: res.error ?? "重置失败" });
  return res;
}

export async function recoverRoomMod(): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("recoverRoomMod")) {
    return { ok: false, error: "请完全重启应用" };
  }
  const res = await getDesktop().recoverRoomMod(id);
  if (!res.ok) set({ lastError: res.error ?? "恢复失败" });
  return res;
}

export async function sendRoomModIntent(
  seatId: string,
  name: string,
  payload?: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  if (!id || !seatId) return { ok: false, error: "请先选一个席位" };
  if (!hasDesktopApi("sendRoomModIntent")) {
    return { ok: false, error: "请完全重启应用后再使用群聊" };
  }
  const res = await getDesktop().sendRoomModIntent(id, seatId, name, payload);
  if (!res.ok) set({ lastError: res.error ?? "操作失败" });
  return res;
}
