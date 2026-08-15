/** Room protocol v1 — transport-agnostic JSON frames. */

export const ROOM_PROTOCOL_VERSION = 1;
export const ROOM_DEFAULT_PORT = 18765;
export const MOD_HOST_API = 1;
export const MOD_BUNDLE_MAX_BYTES = 512 * 1024;

export type RoomRole = "host" | "member";
export type RoomSeatKind = "human" | "agent";
export type RoomStatus = "open" | "ended";

export type RoomFrameType =
  | "hello"
  | "welcome"
  | "error"
  | "join"
  | "leave"
  | "kick"
  | "seat.claim"
  | "seat.release"
  | "seat.takeover"
  | "seat.return"
  | "seat.add"
  | "chat.user"
  | "chat.event"
  | "game.dice"
  | "game.rps"
  | "state.snapshot"
  | "room.closed"
  | "perm.ask"
  | "perm.decide"
  | "mod.offer"
  | "mod.fetch"
  | "mod.bundle"
  | "mod.intent"
  | "mod.patch"
  | "mod.priv"
  | "mod.fail";

export type RoomFrame<T = unknown> = {
  v: typeof ROOM_PROTOCOL_VERSION;
  roomId: string;
  seq: number;
  type: RoomFrameType;
  payload: T;
};

export type ModOfferPayload = {
  id: string;
  name: string;
  version: string;
  checksum: string;
  size: number;
};

export type ModFetchPayload = {
  checksum: string;
};

export type ModBundlePayload = {
  checksum: string;
  offset: number;
  chunk: string;
};

export type ModIntentPayload = {
  seatId: string;
  name: string;
  payload: unknown;
};

export type ModPatchPayload = {
  seq: number;
  publicView: unknown;
};

export type ModPrivPayload = {
  seq: number;
  seatId: string;
  seatView: unknown;
};

export type ModFailPayload = {
  message: string;
};

export type ModView = {
  title: string;
  phase: string;
  lines: string[];
  badges?: { label: string; tone: string }[];
};

export type RoomMember = {
  userId: string;
  name: string;
  role: RoomRole;
};

export type RoomSeat = {
  id: string;
  kind: RoomSeatKind;
  name: string;
  /** Occupying member; human seats usually the owner */
  occupantUserId: string | null;
  /** Who is currently talking instead of the agent */
  takenOverBy: string | null;
  /** Host-side SessionManager id (never sent to guests as a secret; id only) */
  sessionId: string | null;
  running: boolean;
  /** Agent persona name from settings.agents (host-only meaning) */
  agentName: string | null;
};

export type RoomTimelineItem = {
  id: string;
  at: number;
  seatId: string;
  authorUserId: string | null;
  authorLabel: string;
  kind: "user" | "assistant" | "system" | "tool" | "game";
  text: string;
  /** kind === "game": dice faces / rps hands (emoji string) */
  game?: { type: "dice" | "rps"; value: string };
};

export type RoomSnapshot = {
  roomId: string;
  name: string;
  status: RoomStatus;
  port: number;
  hostLabel: string;
  inviteHost: string;
  memberCount: number;
  requireMods: boolean;
  modChecksum: string;
  autoApprove: boolean;
  hasPassword: boolean;
  members: RoomMember[];
  seats: RoomSeat[];
  items: RoomTimelineItem[];
  /** This client's user id (so UI can pick our own human seat). */
  localUserId?: string;
};

export type RoomListItem = {
  roomId: string;
  name: string;
  status: RoomStatus;
  role: RoomRole;
  memberCount: number;
  port: number;
  inviteHost: string;
};

export function makeRoomFrame<T>(
  roomId: string,
  seq: number,
  type: RoomFrameType,
  payload: T,
): RoomFrame<T> {
  return { v: ROOM_PROTOCOL_VERSION, roomId, seq, type, payload };
}

export function parseRoomFrame(raw: string): RoomFrame | null {
  try {
    const obj = JSON.parse(raw) as Partial<RoomFrame>;
    if (obj.v !== ROOM_PROTOCOL_VERSION) return null;
    if (typeof obj.roomId !== "string" || typeof obj.type !== "string") {
      return null;
    }
    return obj as RoomFrame;
  } catch {
    return null;
  }
}

/** Short 8-char checksum for "force mods" handshake (M3 uses real file hashes). */
export function shortChecksum(parts: string[]): string {
  const s = parts.filter(Boolean).join("|");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Invite secret key (encode IP/port/password for one-tap join)
// Not military crypto — LAN convenience token. Prefix: CDR1.
// ---------------------------------------------------------------------------

export type RoomInvitePayload = {
  /** Preferred / primary host IP */
  host: string;
  /** All candidate LAN IPs (join tries in order) */
  hosts?: string[];
  port: number;
  password?: string;
  modChecksum?: string;
  roomName?: string;
};

const INVITE_PREFIX = "CDR1.";
/** Fixed XOR key material (app-shared). Obfuscation only. */
const INVITE_KEY = "claude-desktop-room-invite-v1";

function utf8ToBytes(s: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(s);
  }
  // Node / tests without TextEncoder
  const buf = Buffer.from(s, "utf8");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function bytesToUtf8(b: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(b);
  }
  return Buffer.from(b).toString("utf8");
}

function xorBytes(data: Uint8Array, key: string): Uint8Array {
  const k = utf8ToBytes(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! ^ k[i % k.length]!;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 =
    typeof btoa !== "undefined"
      ? btoa(bin)
      : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const full = b64 + pad;
  if (typeof atob !== "undefined") {
    const bin = atob(full);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const buf = Buffer.from(full, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Encode invite (host/port/password/…) into a single secret key string.
 * Example: CDR1.aGVsbG8…
 */
export function encodeRoomInvite(payload: RoomInvitePayload): string {
  const hosts = payload.hosts?.length
    ? payload.hosts
    : payload.host
      ? [payload.host]
      : [];
  const host = payload.host || hosts[0] || "";
  if (!host || !payload.port) {
    throw new Error("invite requires host and port");
  }
  const body = {
    v: 1 as const,
    h: host,
    hs: hosts.filter((x) => x && x !== host),
    p: payload.port,
    ...(payload.password ? { w: payload.password } : {}),
    ...(payload.modChecksum ? { m: payload.modChecksum } : {}),
    ...(payload.roomName ? { n: payload.roomName } : {}),
  };
  const plain = utf8ToBytes(JSON.stringify(body));
  const cipher = xorBytes(plain, INVITE_KEY);
  return INVITE_PREFIX + toBase64Url(cipher);
}

/**
 * Decode a secret key back to host/port/password.
 * Accepts optional whitespace / surrounding quotes.
 */
export function decodeRoomInvite(secret: string): RoomInvitePayload {
  let s = secret.trim().replace(/^["']|["']$/g, "");
  // Allow pasting multi-line invite with key on its own line
  if (!s.startsWith(INVITE_PREFIX)) {
    const line = s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith(INVITE_PREFIX));
    if (line) s = line;
  }
  if (!s.startsWith(INVITE_PREFIX)) {
    throw new Error("无效邀请码（应以 CDR1. 开头）");
  }
  const b64 = s.slice(INVITE_PREFIX.length).replace(/\s/g, "");
  if (!b64) throw new Error("邀请码内容为空");
  let plain: string;
  try {
    const cipher = fromBase64Url(b64);
    plain = bytesToUtf8(xorBytes(cipher, INVITE_KEY));
  } catch {
    throw new Error("邀请码无法解码");
  }
  let body: {
    v?: number;
    h?: string;
    hs?: string[];
    p?: number;
    w?: string;
    m?: string;
    n?: string;
  };
  try {
    body = JSON.parse(plain) as typeof body;
  } catch {
    throw new Error("邀请码内容损坏");
  }
  if (body.v !== 1 || !body.h || !body.p) {
    throw new Error("邀请码版本或字段无效");
  }
  const port = Number(body.p);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("邀请码端口无效");
  }
  const hosts = [body.h, ...(Array.isArray(body.hs) ? body.hs : [])].filter(
    (x, i, a): x is string => Boolean(x) && a.indexOf(x) === i,
  );
  return {
    host: body.h,
    hosts,
    port,
    ...(body.w ? { password: String(body.w) } : {}),
    ...(body.m ? { modChecksum: String(body.m) } : {}),
    ...(body.n ? { roomName: String(body.n) } : {}),
  };
}

/** True if text looks like a room invite secret key. */
export function looksLikeRoomInvite(text: string): boolean {
  const s = text.trim();
  if (s.startsWith(INVITE_PREFIX)) return true;
  return s.split(/\r?\n/).some((l) => l.trim().startsWith(INVITE_PREFIX));
}
