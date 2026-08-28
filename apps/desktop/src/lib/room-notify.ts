/**
 * 群聊桌面通知：纯决策逻辑 + 每房间「消息免打扰」本地存储。
 * 通知的实际弹出在 room-store（需要 selectRoom / window.focus 接线）。
 */

const MUTED_KEY = "room-muted.v1";

export function loadRoomMuted(): Set<string> {
  try {
    const raw = localStorage.getItem(MUTED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function isRoomMuted(roomId: string): boolean {
  return loadRoomMuted().has(roomId);
}

export function setRoomMuted(roomId: string, muted: boolean): void {
  const set = loadRoomMuted();
  if (muted) set.add(roomId);
  else set.delete(roomId);
  try {
    localStorage.setItem(MUTED_KEY, JSON.stringify([...set]));
  } catch {
    // ignore quota / private mode
  }
}

/** 一条时间线消息要不要弹桌面通知（纯函数，方便测试）。 */
export function roomNotifyDecision(opts: {
  kind: string;
  /** 消息作者 userId（system 为 null） */
  authorUserId: string | null;
  text: string;
  recalled?: boolean;
  /** 本机用户 userId */
  myUserId: string | null | undefined;
  /** 本机用户在群里的人席名（@ 判定用） */
  mySeatName: string | null;
  /** 该房间是否开了消息免打扰 */
  muted: boolean;
  /** 正在看这个房间且窗口聚焦时，不再弹通知 */
  isActiveAndFocused: boolean;
}): { notify: boolean; mention: boolean } {
  const none = { notify: false, mention: false };
  if (opts.recalled) return none;
  if (opts.kind !== "user" && opts.kind !== "assistant") return none;
  if (!opts.authorUserId) return none;
  if (opts.myUserId && opts.authorUserId === opts.myUserId) return none;
  const mention = Boolean(
    opts.mySeatName && opts.text.includes(`@${opts.mySeatName}`),
  );
  // @ 我的消息即使正在看也弹（群里 @ 需要明显提醒）——但自己正盯着这个
  // 房间时就免了，气泡就在眼前。
  if (opts.isActiveAndFocused) return none;
  if (opts.muted && !mention) return none;
  return { notify: true, mention };
}

/** 通知正文：@ 时加 [有人@我] 前缀；截断过长内容。 */
export function roomNotifyBody(text: string, mention: boolean): string {
  const body = text.replace(/\s+/g, " ").trim().slice(0, 120);
  return mention ? `[有人@我] ${body}` : body;
}
