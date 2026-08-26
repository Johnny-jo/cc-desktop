/** Room protocol v1 — transport-agnostic JSON frames. */

export const ROOM_PROTOCOL_VERSION = 1;
export const ROOM_DEFAULT_PORT = 18765;
export const MOD_HOST_API = 1;
export const MOD_KERNEL_API = 2;
export const MOD_BUNDLE_MAX_BYTES = 512 * 1024;

export const ROOM_HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * Guest wait for the first hs.challenge. Longer than the prove-phase
 * timeout because a relay work-channel may still be pairing after the
 * guest socket is already open (hello sits in the relay buffer until then).
 */
export const ROOM_HANDSHAKE_OPEN_TIMEOUT_MS = 20_000;
export const ROOM_FRAME_LIMITS = {
  handshake: 8 * 1024,
  "chat.user": 64 * 1024,
  "chat.event": 64 * 1024,
  "state.snapshot": 2 * 1024 * 1024,
  "mod.bundle": MOD_BUNDLE_MAX_BYTES,
  envelope: 2 * 1024 * 1024 + 256,
  default: 256 * 1024,
} as const;

export type RoomRole = "host" | "member";
export type RoomSeatKind = "human" | "agent";
export type RoomStatus = "open" | "ended";

/** Path that won the join race: T0 = LAN ws, T1 = public wss, T2 = cf tunnel. */
export type RoomPath = "T0" | "T1" | "T2";

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
  /** Extra system prompt for this agent seat. */
  agentPrompt?: string;
  /** Skill names this seat should prefer. */
  skillNames?: string[];
  /** Optional model override; omit = host default. */
  model?: string;
};

/** QQ-style quoted message reference (id + excerpt snapshot) */
export type RoomQuoteRef = {
  id: string;
  authorLabel: string;
  text: string;
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
  /** Host kernel railway / system note. Guests render as a badge only. */
  source?: "kernel";
  quote?: RoomQuoteRef;
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
  /** Whether room frames are AEAD-encrypted after the HMAC handshake. */
  encrypt: boolean;
  /** Host device fingerprint (64-hex); guests learn it from the handshake. */
  hostFingerprint?: string;
  /** This client's user id (so UI can pick our own human seat). */
  localUserId?: string;
  /** Read-only kernel projection. Never includes source or KV. */
  kernel?: {
    mods: Array<{
      id: string;
      name: string;
      version: string;
      state: string;
      pendingReason?: string;
      failedReason?: string;
    }>;
  };
};

export type RoomListItem = {
  roomId: string;
  name: string;
  status: RoomStatus;
  role: RoomRole;
  memberCount: number;
  port: number;
  inviteHost: string;
  /** guest lost connection — room + history kept locally, can rejoin */
  offline?: boolean;
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
// Invite secret key (encode host/port/fingerprint for one-tap join)
// Not military crypto — LAN convenience token. Prefix: CDR2. (legacy: CDR1.)
// CDR2 never carries the room password; confidentiality comes from AEAD.
// ---------------------------------------------------------------------------

export type RoomInvitePayload = {
  /** Preferred / primary host IP */
  host: string;
  /** All candidate LAN IPs (join tries in order) */
  hosts?: string[];
  port: number;
  /** wss:// relay endpoints (T1/T2) */
  wss?: string[];
  /** Host device fingerprint (64-hex); proven by the handshake HMAC */
  hostFingerprint: string;
  modChecksum?: string;
  roomName?: string;
};

/**
 * Decoded CDR1 invite. Tests / diagnostics only — a CDR1 code embedded the
 * room password and must never be used as a join credential.
 */
export type LegacyRoomInvite = RoomInvitePayload & {
  password?: string;
  legacy: true;
};

const INVITE_PREFIX = "CDR2.";
const LEGACY_INVITE_PREFIX = "CDR1.";
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

/** Wire shape of an invite body (v1 = legacy CDR1, v2 = CDR2). */
type InviteBody = {
  v?: number;
  h?: string;
  hs?: string[];
  p?: number;
  u?: string[];
  f?: string;
  w?: string;
  m?: string;
  n?: string;
};

/** Find the invite line inside a (possibly multi-line) paste. */
function extractInviteLine(secret: string, prefix: string): string | null {
  const s = secret.trim().replace(/^["']|["']$/g, "");
  if (s.startsWith(prefix)) return s;
  const line = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith(prefix));
  return line ?? null;
}

function decodeInviteBody(line: string, prefix: string): InviteBody {
  const b64 = line.slice(prefix.length).replace(/\s/g, "");
  if (!b64) throw new Error("邀请码内容为空");
  let plain: string;
  try {
    const cipher = fromBase64Url(b64);
    plain = bytesToUtf8(xorBytes(cipher, INVITE_KEY));
  } catch {
    throw new Error("邀请码无法解码");
  }
  try {
    return JSON.parse(plain) as InviteBody;
  } catch {
    throw new Error("邀请码内容损坏");
  }
}

function parseInvitePort(p: number | undefined): number {
  const port = Number(p);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error("邀请码端口无效");
  }
  return port;
}

function inviteHosts(h: string, hs: string[] | undefined): string[] {
  return [h, ...(Array.isArray(hs) ? hs : [])].filter(
    (x, i, a): x is string => Boolean(x) && a.indexOf(x) === i,
  );
}

/**
 * Encode invite (host/port/fingerprint/…) into a single secret key string.
 * Example: CDR2.aGVsbG8…
 * Never carries the room password; throws when hostFingerprint is missing.
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
  if (!payload.hostFingerprint) {
    throw new Error("invite requires hostFingerprint");
  }
  const body = {
    v: 2 as const,
    h: host,
    hs: hosts.filter((x) => x && x !== host),
    p: payload.port,
    ...(payload.wss?.length ? { u: payload.wss } : {}),
    f: payload.hostFingerprint,
    ...(payload.roomName ? { n: payload.roomName } : {}),
    ...(payload.modChecksum ? { m: payload.modChecksum } : {}),
  };
  const plain = utf8ToBytes(JSON.stringify(body));
  const cipher = xorBytes(plain, INVITE_KEY);
  return INVITE_PREFIX + toBase64Url(cipher);
}

/**
 * Decode a CDR2. secret key back to host/port/fingerprint.
 * Accepts optional whitespace / surrounding quotes / multi-line paste.
 * CDR1. codes are refused: they embedded the room password.
 */
export function decodeRoomInvite(secret: string): RoomInvitePayload {
  if (extractInviteLine(secret, LEGACY_INVITE_PREFIX)) {
    throw new Error("该邀请码由旧版本生成，安全性不足，请让房主重新生成");
  }
  const line = extractInviteLine(secret, INVITE_PREFIX);
  if (!line) {
    throw new Error("无效邀请码（应以 CDR2. 开头）");
  }
  const body = decodeInviteBody(line, INVITE_PREFIX);
  if (body.v !== 2 || !body.h || !body.p || !body.f) {
    throw new Error("邀请码版本或字段无效");
  }
  return {
    host: body.h,
    hosts: inviteHosts(body.h, body.hs),
    port: parseInvitePort(body.p),
    ...(Array.isArray(body.u) && body.u.length
      ? { wss: body.u.map(String) }
      : {}),
    hostFingerprint: String(body.f),
    ...(body.m ? { modChecksum: String(body.m) } : {}),
    ...(body.n ? { roomName: String(body.n) } : {}),
  };
}

/**
 * Decode a legacy CDR1. invite for hint / diagnostics only.
 * @internal tests & diagnostics — UI must not use the result to join.
 */
export function decodeLegacyRoomInviteForHint(secret: string): LegacyRoomInvite {
  const line = extractInviteLine(secret, LEGACY_INVITE_PREFIX);
  if (!line) {
    throw new Error("不是旧版邀请码（应以 CDR1. 开头）");
  }
  const body = decodeInviteBody(line, LEGACY_INVITE_PREFIX);
  if (body.v !== 1 || !body.h || !body.p) {
    throw new Error("邀请码版本或字段无效");
  }
  return {
    host: body.h,
    hosts: inviteHosts(body.h, body.hs),
    port: parseInvitePort(body.p),
    // CDR1 has no device fingerprint; empty string marks "unknown".
    hostFingerprint: "",
    legacy: true,
    ...(body.w ? { password: String(body.w) } : {}),
    ...(body.m ? { modChecksum: String(body.m) } : {}),
    ...(body.n ? { roomName: String(body.n) } : {}),
  };
}

/** @internal test only — production code must never emit CDR1 (it embeds the password). */
export function encodeCdr1ForTest(payload: {
  host: string;
  hosts?: string[];
  port: number;
  password?: string;
  modChecksum?: string;
  roomName?: string;
}): string {
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
  return LEGACY_INVITE_PREFIX + toBase64Url(cipher);
}

/** True if text looks like a room invite secret key (CDR1. or CDR2.). */
export function looksLikeRoomInvite(text: string): boolean {
  return (
    extractInviteLine(text, INVITE_PREFIX) !== null ||
    extractInviteLine(text, LEGACY_INVITE_PREFIX) !== null
  );
}
