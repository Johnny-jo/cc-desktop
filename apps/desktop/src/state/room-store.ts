import { useSyncExternalStore } from "react";
import type {
  ModOfferPayload,
  RoomListItem,
  RoomSnapshot,
} from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import { clearActiveSession } from "./store";

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
};

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
};

const modsByRoom = new Map<string, RoomModState>();

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<RoomUiState>) {
  Object.assign(state, patch);
  emit();
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
    room.seats.find((s) => s.kind === "agent" && !s.takenOverBy)?.id ??
    room.seats[0]?.id ??
    null
  );
}

export function selectRoom(roomId: string | null): void {
  if (roomId) clearActiveSession();
  set({
    activeRoomId: roomId,
    selectedSeatId: null,
    reconnectNote: null,
    lastError: null,
    mod: roomId ? (modsByRoom.get(roomId) ?? null) : null,
  });
  if (roomId && hasDesktopApi("getRoom")) {
    void getDesktop()
      .getRoom(roomId)
      .then((r) => {
        const room = r.room;
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

export function bindRoomEvents(): () => void {
  if (!hasDesktopApi("on")) return () => undefined;
  return getDesktop().on("room:event", (...args: unknown[]) => {
    const ev = args[0] as {
      roomId: string;
      room?: RoomSnapshot;
      closed?: boolean;
      silent?: boolean;
      reconnecting?: boolean;
      reconnectAttempt?: number;
      error?: boolean;
      message?: string;
      mod?: RoomModState;
    };
    if (!ev?.roomId) return;

    // Guest: host left / reconnect failed
    if (ev.closed) {
      const msg = ev.message ?? "房间已关闭";
      const rooms = state.rooms.filter((r) => r.roomId !== ev.roomId);
      const wasActive = state.activeRoomId === ev.roomId;
      modsByRoom.delete(ev.roomId);
      set({
        rooms,
        reconnectNote: null,
        ...(wasActive
          ? {
              activeRoomId: null,
              activeRoom: null,
              selectedSeatId: null,
              mod: null,
            }
          : {}),
      });
      if (!ev.silent) {
        set({ lastError: msg });
      }
      if (hasDesktopApi("deleteRoom")) {
        void getDesktop().deleteRoom(ev.roomId).catch(() => undefined);
      }
      return;
    }

    if (ev.error) {
      set({ lastError: ev.message ?? "房间操作失败" });
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
    if (
      ev.mod &&
      (ev.mod.offer?.checksum || ev.mod.fail || ev.mod.publicView !== undefined)
    ) {
      modsByRoom.set(ev.roomId, ev.mod);
    } else if (!ev.room.modChecksum) {
      modsByRoom.delete(ev.roomId);
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
}): Promise<{ ok: boolean; error?: string; roomId?: string }> {
  if (!hasDesktopApi("createRoom")) {
    return { ok: false, error: "请完全重启应用后再使用房间" };
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
}): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("joinRoom")) {
    return { ok: false, error: "请完全重启应用后再使用房间" };
  }
  const res = await getDesktop().joinRoom(opts);
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
): Promise<void> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("addRoomSeat")) return;
  const res = await getDesktop().addRoomSeat(id, kind, name, agentName);
  if (res.room) set({ activeRoom: res.room });
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

export async function takeoverSeat(seatId: string): Promise<void> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("takeoverSeat")) return;
  await getDesktop().takeoverSeat(id, seatId);
  set({ selectedSeatId: seatId });
}

export async function returnSeat(seatId: string): Promise<void> {
  const id = state.activeRoomId;
  if (!id || !hasDesktopApi("returnSeat")) return;
  await getDesktop().returnSeat(id, seatId);
}

export async function sendToSeat(
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const id = state.activeRoomId;
  const seatId = state.selectedSeatId;
  if (!id || !seatId) return { ok: false, error: "请先选一个席位" };
  if (!hasDesktopApi("sendRoomMessage")) {
    return { ok: false, error: "请完全重启应用后再使用房间" };
  }
  const res = await getDesktop().sendRoomMessage(id, seatId, text);
  if (res.ok) set({ lastError: null });
  return res;
}

export async function peekRoom(opts: {
  host: string;
  port: number;
}): Promise<{ ok: boolean; offer?: ModOfferPayload; error?: string }> {
  if (!hasDesktopApi("peekRoom")) {
    return { ok: false, error: "请完全重启应用后再使用房间" };
  }
  return getDesktop().peekRoom(opts);
}

export async function fetchRoomMod(opts: {
  host: string;
  port: number;
  checksum: string;
}): Promise<{
  ok: boolean;
  checksum?: string;
  offer?: ModOfferPayload;
  error?: string;
}> {
  if (!hasDesktopApi("fetchRoomMod")) {
    return { ok: false, error: "请完全重启应用后再使用房间" };
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

export async function enableRoomMod(
  roomId: string,
  packDir: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!hasDesktopApi("enableRoomMod")) {
    return { ok: false, error: "请完全重启应用后再使用房间" };
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
  if (res.ok && state.activeRoomId === id) set({ mod: null });
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
    return { ok: false, error: "请完全重启应用后再使用房间" };
  }
  const res = await getDesktop().sendRoomModIntent(id, seatId, name, payload);
  if (!res.ok) set({ lastError: res.error ?? "操作失败" });
  return res;
}
