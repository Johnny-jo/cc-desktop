/**
 * 群聊席位会话桥：room-store 在快照/选房时同步当前房间的席位 sessionId，
 * store.ts 据此缓存这些隐藏会话的 diff 并自动弹出变更栏。
 * 独立成叶子模块，避免两个 store 之间循环引用。
 */
let activeRoomId: string | null = null;
let seatSessions = new Set<string>();

export function syncRoomSeatSessions(
  roomId: string | null,
  sessionIds: Array<string | null | undefined>,
): void {
  activeRoomId = roomId;
  seatSessions = new Set(
    sessionIds.filter((s): s is string => typeof s === "string" && !!s),
  );
}

export function isActiveRoomSeatSession(sessionId: string): boolean {
  return activeRoomId !== null && seatSessions.has(sessionId);
}
