/** Room protocol v1 — transport-agnostic JSON frames. */

import type { FileChange } from "./models";

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
  "state.live": 256 * 1024,
  "state.snapshot": 2 * 1024 * 1024,
  "mod.bundle": MOD_BUNDLE_MAX_BYTES,
  envelope: 2 * 1024 * 1024 + 256,
  default: 256 * 1024,
} as const;

export type RoomRole = "host" | "admin" | "member";
export type RoomSeatKind = "human" | "agent";
export type RoomStatus = "open" | "ended";
/** 别人动我的项目时：完全允许 / 审批 / 禁止。缺省 ask。 */
export type RoomFilePolicy = "allow" | "ask" | "deny";
/** 是否把本机模型借给本房席位。缺省 off。 */
export type RoomAiShare = "off" | "pending" | "on";

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
  | "seat.update"
  | "member.role"
  | "member.kick"
  | "ai.share"
  | "ai.ask"
  | "ai.models"
  | "ai.http"
  | "file.policy"
  | "chat.user"
  | "chat.event"
  | "chat.recall"
  | "seat.stop"
  | "exec.run"
  | "exec.event"
  | "exec.result"
  | "exec.abort"
  | "node.info"
  | "game.dice"
  | "game.rps"
  | "state.live"
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
  /**
   * 成员当前打开的项目路径（随 join 上报、node.info 更新）。
   * null/缺省 = 未开项目，远程执行席位选择时据此提示。
   */
  projectPath?: string | null;
  /** 别人以我为 workspace 时的工具策略。缺省 ask。 */
  filePolicy?: RoomFilePolicy;
  /** 是否把本机 CPA 模型借给本房。缺省 off。 */
  aiShare?: RoomAiShare;
  /** 最近一次上报的模型 id（aiShare=on 时给席位下拉用）。 */
  aiModels?: string[];
  /** aiShare=pending 时，谁在请求借用。 */
  aiAskBy?: string | null;
  /**
   * 当前是否连着房间（有活着的 socket）。缺省 / 未出现 = 视为在线（旧快照）。
   * 房主在房间 open 时始终为 true。
   */
  online?: boolean;
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
  /**
   * 远程执行（docs/room-remote-exec-design.md）：这个 Agent 席位在哪台机器上
   * 运行——成员 userId。缺省 / null = 房主本机（现状行为）。
   * 废弃别名：等于 workspaceUserId，读老快照时两轴都回退到它。
   */
  executorUserId?: string | null;
  /**
   * 用谁的 CPA / 模型。缺省 = workspaceUserId / executorUserId / 房主。
   */
  aiUserId?: string | null;
  /**
   * 在谁当前打开的项目里跑 Agent 循环。缺省 = executorUserId / 房主。
   */
  workspaceUserId?: string | null;
  /**
   * 席位会话的上下文占用，执行机每轮结束后更新（本机席位由房主直写，
   * 远程席位随 exec.result 回传）。压缩后执行机回传 null，徽标清零。
   */
  contextUsage?: { ratio: number; usedTokens: number; limitTokens: number } | null;
};

/** exec.run：房主 → 执行节点，请求跑一轮（turnId 全链路幂等键）。 */
export type RoomExecRunPayload = {
  turnId: string;
  seatId: string;
  text: string;
  /** 谁发的这轮；节点用来套文件主人的 filePolicy。 */
  requesterUserId?: string | null;
};

/** seat.stop：成员 → 房主，请求停止某个 Agent 席位正在跑的输出。 */
export type RoomSeatStopPayload = {
  seatId: string;
};

/** exec.event：节点 → 房主，ack / 15s 心跳 / 阶段提示 / 流式进度（二期）。 */
export type RoomExecEventPayload = {
  turnId: string;
  seatId?: string;
  phase: "accepted" | "running" | "note";
  /** phase "note"：截至目前的回复全文（尾部截断），覆盖式更新。 */
  text?: string;
  /** phase "note"：截至目前的思考内容（覆盖式更新）。 */
  thinking?: string;
  /** phase "note"：最近在用的工具一行摘要（如 "Edit src/a.ts"）。 */
  tool?: string;
};

/** exec.result：节点 → 房主，终态回报（ok:false 也走这里，含被中止）。 */
export type RoomExecResultPayload = {
  turnId: string;
  seatId?: string;
  ok: boolean;
  text?: string;
  error?: string;
  /** 本轮改动文件（相对/绝对路径摘要，一期仅文本列举）。 */
  changes?: string[];
  /** 二期：结构化改动（截断后），各端变更栏只读查看。 */
  changesDetail?: FileChange[];
  /**
   * 执行节点每轮回报席位会话的上下文占用；null = 刚压缩过（房主清零徽标），
   * 缺省 = 老版本节点，房主保持原值。
   */
  contextUsage?: { ratio: number; usedTokens: number; limitTokens: number } | null;
  /** 本轮后执行机做了自动压缩（房主在时间线记一笔）。 */
  compacted?: boolean;
};

/** exec.abort：房主 → 节点，中止一轮（接管/超时/对账失败）。 */
export type RoomExecAbortPayload = {
  turnId: string;
  reason?: string;
};

/** node.info：客人 → 房主，上报本机当前项目路径变化（null = 未开项目）。 */
export type RoomNodeInfoPayload = {
  projectPath: string | null;
};

/** seat.update：管理员/房主（客人侧）→ 房主，改 Agent 席位。 */
export type RoomSeatUpdatePayload = {
  seatId: string;
  name?: string;
  agentName?: string;
  agentPrompt?: string;
  skillNames?: string[];
  model?: string;
  aiUserId?: string;
  workspaceUserId?: string;
  executorUserId?: string;
};

/** member.role：房主 → 自己落座 / 客人不可发。客人侧不会发此帧。 */
export type RoomMemberRolePayload = {
  userId: string;
  role: "admin" | "member";
};

/** member.kick：管理员（客人）→ 房主，请求踢人。 */
export type RoomMemberKickPayload = {
  userId: string;
};

/** ai.share：成员 → 房主（或房主本地），开关本机模型共享。 */
export type RoomAiSharePayload = {
  on: boolean;
  models?: string[];
};

/** ai.ask：房主/管理员请求借用对方 AI。 */
export type RoomAiAskPayload = {
  targetUserId: string;
  fromUserId: string;
  seatId?: string;
};

/** ai.models：拉/回报对方模型目录。 */
export type RoomAiModelsPayload = {
  requestId: string;
  targetUserId: string;
  models?: string[];
  error?: string;
};

/**
 * ai.http：文件主人机器上的 SDK → AI 主人 CPA 的 HTTP 中继。
 * 第一片带 method/path/status；后续只带 data；last 结束。
 */
export type RoomAiHttpPayload = {
  requestId: string;
  targetUserId: string;
  /** 工作目录所在节点（回传 res 用）。 */
  sourceUserId?: string;
  dir: "req" | "res";
  seq: number;
  last: boolean;
  method?: string;
  path?: string;
  status?: number;
  /** base64 正文分片 */
  data?: string;
};

/** file.policy：成员 → 房主，设置自己项目的操作策略。 */
export type RoomFilePolicyPayload = {
  policy: RoomFilePolicy;
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
  /** 撤回标记：true 时 text 已清空，各端渲染为“已撤回”占位。 */
  recalled?: boolean;
};

/** Ephemeral execution progress. Kept outside the persisted timeline. */
export type RoomLiveExecEntry = {
  turnId: string;
  seatId: string;
  text: string;
  tool?: string;
  /** Current streamed thinking tail. */
  thinking?: string;
  at: number;
};

/** Lightweight room patch used for high-frequency, non-durable state. */
export type RoomLivePatch = {
  liveExec: RoomLiveExecEntry[];
};

/** chat.recall：客人 → 房主，请求撤回自己的一条消息。 */
export type RoomChatRecallPayload = {
  itemId: string;
};

export type RoomSnapshot = {
  roomId: string;
  name: string;
  status: RoomStatus;
  port: number;
  hostLabel: string;
  inviteHost: string;
  memberCount: number;
  /** 当前连着的人数（members 里 online !== false）。 */
  onlineCount?: number;
  requireMods: boolean;
  modChecksum: string;
  autoApprove: boolean;
  hasPassword: boolean;
  members: RoomMember[];
  seats: RoomSeat[];
  items: RoomTimelineItem[];
  /**
   * 二期：远端执行中的实时进度（turnId → 截至目前的回复尾部/工具行），
   * 只活在快照里，不入时间线、不持久化。
   */
  liveExec?: RoomLiveExecEntry[];
  /** 二期：远端席位最近一轮的结构化改动（截断），各端只读查看。 */
  remoteChanges?: Record<string, FileChange[]>;
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
  /** 当前连着的人数；缺省则 UI 回退 memberCount。 */
  onlineCount?: number;
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
