/** Wire-safe metadata: paths and file contents never enter room history. */
export type RoomAttachmentRef = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  kind: "image" | "text" | "binary";
  sha256: string;
};

export const ROOM_ATTACHMENT_LIMITS = {
  count: 5,
  fileBytes: 10 * 1024 * 1024,
  messageBytes: 25 * 1024 * 1024,
  modelTextBytes: 5 * 1024 * 1024,
  chunkBytes: 48 * 1024,
  cacheBytes: 512 * 1024 * 1024,
} as const;

const KEYS = new Set(["id", "name", "size", "mimeType", "kind", "sha256"]);
export function parseRoomAttachments(value: unknown): RoomAttachmentRef[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ROOM_ATTACHMENT_LIMITS.count) return null;
  const result: RoomAttachmentRef[] = [];
  const ids = new Set<string>();
  let bytes = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !KEYS.has(k))) return null;
    const { id, name, size, mimeType, kind, sha256 } = raw;
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || ids.has(id)) return null;
    if (typeof name !== "string" || !name.trim() || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") return null;
    if (!Number.isSafeInteger(size) || size < 0 || size > ROOM_ATTACHMENT_LIMITS.fileBytes) return null;
    if (typeof mimeType !== "string" || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType) || mimeType.length > 120) return null;
    if (kind !== "image" && kind !== "text" && kind !== "binary") return null;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
    bytes += size;
    if (bytes > ROOM_ATTACHMENT_LIMITS.messageBytes) return null;
    ids.add(id);
    result.push({ id, name, size, mimeType, kind, sha256 });
  }
  return result;
}

export type RoomAttachmentRequest = { requestId: string; attachment: RoomAttachmentRef; offset: number };
export type RoomAttachmentResponse = { requestId: string; offset: number; data?: string; error?: string };
