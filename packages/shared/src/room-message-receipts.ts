/** Bound retry storage without allowing an evicted id to execute again. */
export const ROOM_MESSAGE_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ROOM_MESSAGE_RECEIPT_LIMIT = 8192;
export type RoomMessageReceipt = { userId: string; id: string; digest: string; at: number };

export function createRoomMessageId(): string {
  return `${Date.now()}-${globalThis.crypto.randomUUID()}`;
}

export function roomMessageTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^([1-9][0-9]{12})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(value);
  return match ? Number(match[1]) : null;
}
