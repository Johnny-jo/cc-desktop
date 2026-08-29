import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { BrowserWindow } from "electron";
import { IPC, MOD_BUNDLE_MAX_BYTES } from "@claude-desktop/shared";
import type {
  Attachment,
  ModOfferPayload,
  PermissionMode,
  RoomAiAskPayload,
  RoomAiSharePayload,
  RoomChatRecallPayload,
  RoomExecAbortPayload,
  RoomExecEventPayload,
  RoomExecResultPayload,
  RoomAiHttpPayload,
  RoomExecRunPayload,
  RoomFilePolicy,
  RoomFilePolicyPayload,
  RoomListItem,
  RoomMember,
  RoomMemberKickPayload,
  RoomNodeInfoPayload,
  RoomPath,
  RoomQuoteRef,
  RoomRole,
  RoomSeat,
  RoomSeatKind,
  RoomSeatStopPayload,
  RoomSeatUpdatePayload,
  RoomSnapshot,
  RoomTimelineItem,
  RoomFrame,
  RoomFrameType,
  FileChange,
  SdkNormalizedEvent,
} from "@claude-desktop/shared";
import {
  canKickMember,
  canManageSeats,
  canSetMemberRole,
  countOnlineMembers,
  effectiveFilePolicy,
  resolveAiUserId,
  resolveWorkspaceUserId,
} from "@claude-desktop/shared";
import type { DeviceKeys } from "@claude-desktop/shared/room-crypto";
import type { Handshake } from "@claude-desktop/shared/room-handshake";
import {
  ROOM_DEFAULT_PORT,
  ROOM_HANDSHAKE_OPEN_TIMEOUT_MS,
  ROOM_HANDSHAKE_TIMEOUT_MS,
  ROOM_PROTOCOL_VERSION,
  encodeRoomInvite,
  makeRoomFrame,
  parseRoomFrame,
} from "@claude-desktop/shared";
import { deriveSessionKey, fingerprintPublic } from "@claude-desktop/shared/room-crypto";
import {
  HandshakeReject,
  makeHandshake,
  provePassword,
  verifyPassword,
} from "@claude-desktop/shared/room-handshake";
import { parsePdu } from "@claude-desktop/shared/room-pdu";
import type { SessionManager, SessionRunOpts } from "./session-manager";
import type { SettingsStore } from "./settings-store";
import { BUILTIN_PATH_GUARD_SKILL } from "./skill-store";
import type { CpaSupervisor } from "./cpa-supervisor";
import {
  buildReqFrames,
  buildResFrames,
  concatChunks,
  parseBorrowToken,
  startLoopbackProxy,
  type LoopbackProxy,
} from "./room-ai-proxy";
import type { RoomArchive, StoredRoom } from "./room-archive";
import { ModHost, type ModSeat } from "./mod-host";
import {
  hasModCache,
  listModPacks,
  loadModDir,
  readModBytes,
  writeModBytes,
  writeModCache,
  type LoadedMod,
  type ModPackInfo,
} from "./mod-package";
import {
  listKernelPacks,
  loadKernelDir,
  peekHostApi,
  toKernelActivatePack,
  writeKernelCache,
  type LoadedKernelMod,
} from "./mod-kernel-package";
import {
  ModKernel,
  KERNEL_BUDGET_DEFAULT,
  kernelLog,
  type ChatInEnvelope,
  type KernelActivatePack,
} from "./mod-kernel";
import { HostRoomKv } from "./mod-kernel-store";
import {
  decideImproveApply,
  KernelImproveStore,
  trialKernelSource,
  type KernelAutonomy,
} from "./mod-kernel-improve";
import { hashModFiles } from "@claude-desktop/shared/mod-hash";
import { RoomConnection } from "./room-connection";
import { loadOrCreateDeviceKeys } from "./room-device-store";
import {
  frameLimit,
  HandshakeWatchdog,
  startWsHeartbeat,
  TokenBucket,
} from "./room-limits";
import { isHandshakeReason, RoomMetrics } from "./room-metrics";
import { startRoomRelay } from "./room-relay";
import { readNamedTunnelConfig, startRoomTunnel } from "./room-tunnel";
import {
  getKernelCacheDir,
  getKernelImprovePath,
  getKernelStorePath,
  getModCacheDir,
  getModPersistPath,
  type RuntimePathEnv,
} from "./runtime-paths";
import {
  actionNames,
  formatRoomModPrompt,
  illegalActionMessage,
  parseRoomModAct,
  ROOM_MOD_PREFIX,
  toModActionMap,
  tryCreateRoomModMcp,
  type ModActionSchema,
} from "./room-mod-agent";
import {
  mergeSessionRunOpts,
  tryCreateImproveMcp,
  tryCreateMemoryMcp,
  type KernelImproveHost,
} from "./mod-kernel-compile";

const MOD_CHECKSUM_RE = /^[0-9a-f]{64}$/;
export const ROOM_MOD_BUNDLE_CHUNK = 48 * 1024;
/** Guest reconnect: 5 attempts, exponential backoff 1s/2s/4s/8s/8s (task 9). */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 8_000] as const;
/** Per-connection inbound abuse bucket (spec §9): 30 msg/s sustained, 60 burst. */
const ROOM_CONN_RATE_PER_SEC = 30;
const ROOM_CONN_BURST = 60;
/** Consecutive oversized messages before the socket is dropped (task 14). */
const ROOM_OVERSIZED_MAX_STREAK = 5;
/**
 * Runtime mirror of the RoomFrameType union (task 14 unknown-type guard).
 * parseRoomFrame accepts any string as `type`, so this set is the only way to
 * tell a forged/unknown frame type apart at runtime. Keep in sync with
 * packages/shared/src/room-protocol.ts.
 */
const KNOWN_ROOM_FRAME_TYPES: ReadonlySet<string> = new Set<RoomFrameType>([
  "hello",
  "welcome",
  "error",
  "join",
  "leave",
  "kick",
  "seat.claim",
  "seat.release",
  "seat.takeover",
  "seat.return",
  "seat.add",
  "seat.update",
  "member.role",
  "member.kick",
  "ai.share",
  "ai.ask",
  "ai.models",
  "ai.http",
  "file.policy",
  "chat.user",
  "chat.event",
  "chat.recall",
  "seat.stop",
  "exec.run",
  "exec.event",
  "exec.result",
  "exec.abort",
  "node.info",
  "game.dice",
  "game.rps",
  "state.snapshot",
  "room.closed",
  "perm.ask",
  "perm.decide",
  "mod.offer",
  "mod.fetch",
  "mod.bundle",
  "mod.intent",
  "mod.patch",
  "mod.priv",
  "mod.fail",
]);

type GuestWs = WebSocket & {
  userId?: string;
  fetching?: boolean;
  guard?: ConnGuard;
};

/** Per-connection abuse guard (task 14), attached in onGuest. */
type ConnGuard = {
  bucket: TokenBucket;
  /** Consecutive over-limit messages; the socket dies at the streak cap. */
  oversized: number;
  /** Abuse charges so far (oversized / unknown type / forged roomId). */
  abused: number;
};

/* ── 远程执行（docs/room-remote-exec-design.md §4/§5） ───────────── */

/** ack 超时：下发后 10s 无首帧，重发一次，再等 10s 判失败。 */
const EXEC_ACK_TIMEOUT_MS = 10_000;
/** 节点心跳间隔。 */
const EXEC_HEARTBEAT_INTERVAL_MS = 15_000;
/** 心跳超时：60s 无 exec.event → 失联。 */
const EXEC_HEARTBEAT_TIMEOUT_MS = 60_000;
/** 单轮总时长上限。 */
const EXEC_TOTAL_TIMEOUT_MS = 10 * 60_000;
/** 席位会话上下文占用超过这个比例就自动压缩（与渲染端主会话的 0.75 一致）。 */
const ROOM_AUTO_COMPACT_RATIO = 0.75;

type RemoteTurnState =
  | "dispatched"
  | "running"
  | "done"
  | "failed"
  | "aborted"
  | "timeout";

/** 房主侧台账：一轮派发给成员机器的执行。 */
type RemoteTurn = {
  turnId: string;
  seatId: string;
  requesterUserId: string | null;
  executorUserId: string;
  state: RemoteTurnState;
  dispatchedAt: number;
  lastEventAt: number;
  doneAt?: number;
  error?: string;
  ackTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  totalTimer?: ReturnType<typeof setTimeout>;
  /** ack 超时后已重发过一次。 */
  resent?: boolean;
  /** 原始任务文本（ack 超时重发用）。 */
  text: string;
};

/** 节点侧：正在本机跑的一轮。 */
type NodeTurn = {
  turnId: string;
  seatId: string;
  requesterUserId?: string | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  /** 本机 SessionManager 会话（abort 用），start 之后才有。 */
  sessionId?: string;
  /** 本轮开始时间（过滤本轮改动用）。 */
  startedAt: number;
  /** 二期：流式进度累计文本。 */
  liveText: string;
  /** 流式思考内容（覆盖式发给房主）。 */
  liveThinking?: string;
  /** 二期：最近工具一行摘要。 */
  liveTool?: string;
  /** 二期：上次向房主发进度的时间（节流）。 */
  lastLiveSendAt: number;
};

/** 房主侧 liveExec 条目（快照字段，节流广播，不持久化）。 */
type LiveExecEntry = {
  turnId: string;
  seatId: string;
  text: string;
  tool?: string;
  thinking?: string;
  at: number;
};

/** 节点流式进度发送节流间隔。 */
const EXEC_LIVE_INTERVAL_MS = 800;
/** 进度文本尾部保留长度。 */
const EXEC_LIVE_TEXT_TAIL = 1500;

/** Charge one abuse event to the connection's token bucket (spec §9). */
function chargeAbuse(guard: ConnGuard | undefined): void {
  if (!guard) return;
  guard.bucket.take();
  guard.abused += 1;
}

/** Per-socket handshake scratch state (host side), pre hs.ok. */
type GuestHandshakeState = {
  guestFp?: string;
  guestName?: string;
  guestPub?: Buffer;
  userId?: string;
  /** Known userId arrived with a new fingerprint — re-approval required. */
  fpChanged?: boolean;
  nonce?: Buffer;
  key?: Buffer;
};

type RoomRecord = {
  roomId: string;
  name: string;
  password: string;
  port: number;
  requireMods: boolean;
  autoApprove: boolean;
  /** AEAD-encrypt room frames after the HMAC handshake (default true). */
  encrypt: boolean;
  /** Host device fingerprint (64-hex). For host records: our own device fp. */
  hostFingerprint: string;
  /**
   * Public wss:// endpoint (reverse proxy / tunnel) written into the invite's
   * u array. TLS is terminated outside this process — S1 never does it here.
   */
  publicWss?: string;
  /** Live cloudflared child + its public wss URL while the T2 tunnel is up. */
  tunnel?: { wss: string; kill: () => void };
  /** Live self-hosted relay handle + its public join URL while connected. */
  relay?: { url: string; kill: () => void };
  /**
   * Persisted relay config (host rooms): on restart the same relayRoomId is
   * re-registered, so the relay join URL in old invites keeps working.
   */
  relayAddr?: string;
  relayToken?: string;
  relayRoomId?: string;
  /** Tunnel requested at create — re-opened on resume (quick tunnels get a new URL). */
  tunnelWanted?: boolean;
  /** Archived host room that was open at exit — hosting resumes on startup. */
  resumePending?: boolean;
  /** Process-level X25519 device identity (shared by all rooms). */
  deviceKeys: DeviceKeys;
  /** Post-handshake connections (host: one per guest ws; guest: the client ws). */
  connections: Map<WebSocket, RoomConnection>;
  /** Devices that proved the password but await host approval (task 8). */
  pendingByFp: Map<
    string,
    {
      ws: WebSocket;
      name: string;
      nonce: Buffer;
      guestPub: Buffer;
      key: Buffer;
      userId?: string;
      fpChanged?: boolean;
      upgrade: () => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  /** Kicked device fingerprints — rejected on hs.hello. */
  blacklist: Set<string>;
  /** Devices approved before (TOFU memory; keyed by fingerprint). */
  knownDevices: Map<string, { fp: string; name: string; userId?: string }>;
  modChecksum: string;
  status: "open" | "ended";
  hostUserId: string;
  hostLabel: string;
  localUserId: string;
  localRole: "host" | "member";
  members: RoomMember[];
  seats: RoomSeat[];
  items: RoomTimelineItem[];
  seq: number;
  server: WebSocketServer | null;
  guests: Set<WebSocket>;
  client: WebSocket | null;
  /** Guest: reconnect info */
  joinInfo?: {
    host: string;
    hosts: string[];
    port: number;
    password?: string;
    modChecksum?: string;
    secret?: string;
    hostFingerprint?: string;
    /** wss:// relay endpoints from the CDR2 invite (T1/T2). */
    wss?: string[];
    /** Path that won the join race (T0/T1/T2) — feeds room metrics (task 12). */
    path?: RoomPath;
  };
  reconnecting?: boolean;
  /** Guest dropped (reconnect exhausted) — room + history kept, can rejoin */
  offline?: boolean;
  /** Guest is leaving on purpose — do not reconnect. */
  closing?: boolean;
  /** Bumped to cancel an in-flight reconnect loop. */
  reconnectGen?: number;
  modLoaded?: LoadedMod;
  modHost?: ModHost;
  modStarted?: boolean;
  modEnded?: boolean;
  modOffer?: ModOfferPayload;
  modPublicView?: unknown;
  modSeatViews?: Record<string, unknown>;
  modSeq?: number;
  modFail?: string;
  modActionsBySeat?: Record<string, Record<string, ModActionSchema>>;
  intentChain?: Promise<unknown>;
  kernel?: ModKernel;
  kernelStore?: HostRoomKv;
  kernelPacks?: KernelActivatePack[];
  kernelLoaded?: LoadedKernelMod[];
  kernelImprove?: KernelImproveStore;
  kernelProjection?: RoomSnapshot["kernel"];
  inboundChain?: Promise<unknown>;
  kernelTimers?: ReturnType<typeof setInterval>[];
  /** 房主侧：派发出去的远程执行轮（turnId → 台账）。 */
  remoteTurns?: Map<string, RemoteTurn>;
  /** 节点侧：本机正在跑的远程执行轮。 */
  nodeTurns?: Map<string, NodeTurn>;
  /** 节点侧：席位 → 本机 SessionManager 会话（续会话用）。 */
  nodeSeatSessions?: Map<string, string>;
  /** 房主侧：在跑远程轮的实时进度（快照字段，不持久化）。 */
  liveExec?: Map<string, LiveExecEntry>;
  /** 房主侧：席位 → 最近一轮结构化改动（截断，快照字段）。 */
  remoteChanges?: Record<string, FileChange[]>;
};

function lanAddresses(): string[] {
  const ifs = os.networkInterfaces();
  const out: string[] = [];
  for (const list of Object.values(ifs)) {
    for (const n of list ?? []) {
      // Node may report family as 4/6 or "IPv4"/"IPv6" depending on version
      const fam = n.family as string | number;
      if (n.internal) continue;
      const v4 = fam === "IPv4" || fam === 4;
      const v6 = fam === "IPv6" || fam === 6;
      if (!v4 && !v6) continue;
      if (v4 && n.address.startsWith("127.")) continue;
      // Skip IPv6 link-local (fe80::/10) — not routable beyond the segment.
      if (v6 && n.address.toLowerCase().startsWith("fe80:")) continue;
      if (!out.includes(n.address)) out.push(n.address);
    }
  }
  // Prefer non-APIPA (169.254.x) and non-virtual-looking first; IPv6 last.
  out.sort((a, b) => {
    const score = (ip: string) => {
      if (ip.startsWith("169.254.")) return 3;
      if (ip.includes(":")) return 2;
      if (ip.startsWith("192.168.") || ip.startsWith("10.")) return 0;
      if (ip.startsWith("172.")) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
  return out.length ? out : ["127.0.0.1"];
}

/** ws URL for a LAN host — IPv6 literals need brackets: ws://[2001:db8::1]:18765 */
function lanWsUrl(host: string, port: number): string {
  const bare = host.trim().replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `ws://[${bare}]:${port}` : `ws://${bare}:${port}`;
}

/**
 * Candidate classification: T0 = LAN/loopback ws; T2 = wss through a
 * Cloudflare tunnel; T1 = any other public endpoint (other wss, or a ws://
 * self-hosted relay on a public VPS).
 */
export function pathForCandidateUrl(url: string): RoomPath {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "T0";
  }
  const proto = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (proto === "ws:") return isPrivateOrLoopbackHost(host) ? "T0" : "T1";
  if (proto === "wss:") {
    if (host.includes("trycloudflare") || host.includes("cfargotunnel")) {
      return "T2";
    }
    return "T1";
  }
  return "T0";
}

/** RFC1918 / loopback / link-local check for ws:// candidates (T0 vs T1). */
function isPrivateOrLoopbackHost(host: string): boolean {
  if (!host || host === "localhost") return true;
  if (host.includes(":")) {
    // IPv6 literals: ::1 loopback, fe80::/10 link-local.
    const h = host.toLowerCase();
    return h === "::1" || h === "0:0:0:0:0:0:0:1" || h.startsWith("fe80:");
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!m) return false; // a hostname, not an IP literal — treat as public
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

function lanAddress(): string {
  return lanAddresses()[0] ?? "127.0.0.1";
}

function displayName(): string {
  return os.userInfo().username || "user";
}

/** Wait until the WS server is actually accepting connections. */
function waitForListening(
  wss: WebSocketServer,
  port: number,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = wss as WebSocketServer & {
      address?: () => { port?: number } | string | null;
    };
    // Already listening?
    try {
      const addr = typeof server.address === "function" ? server.address() : null;
      if (addr && typeof addr === "object" && addr.port) {
        resolve();
        return;
      }
    } catch {
      // continue
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`端口 ${port} 监听超时`));
    }, timeoutMs);

    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      wss.off("listening", onListening);
      wss.off("error", onError);
    };
    wss.on("listening", onListening);
    wss.on("error", onError);
  });
}

export class RoomService {
  private rooms = new Map<string, RoomRecord>();
  private readonly getWindow: () => BrowserWindow | null;
  /**
   * Multi-window push (main + detached room/session windows). When absent,
   * safeSend falls back to getWindow() — tests inject only getWindow.
   */
  private readonly sendToAllWindows?: (channel: string, payload: unknown) => void;
  private readonly sessions: SessionManager;
  private readonly settings: SettingsStore;
  private readonly archive: RoomArchive | null;
  private readonly userDataDir: string;
  private readonly isPackaged: boolean;
  private readonly resourcesPath?: string;
  /** Optional cloudflared override (T2 tunnel; tests inject a fake binary). */
  private readonly cloudflaredPath?: string;
  /** Process-level room device identity (persisted under userData). */
  private readonly deviceKeys: DeviceKeys;
  private readonly deviceFp: string;
  /** Injectable backoff sleep for guest reconnect (tests make it instant). */
  private reconnectSleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /** Injectable half-open handshake timeout (tests shrink it to ms). */
  private handshakeTimeoutMs: number = ROOM_HANDSHAKE_TIMEOUT_MS;
  /**
   * Guest wait for the first hs.challenge (tests shrink it). Covers relay
   * work-channel pairing after the guest socket is already open.
   */
  private handshakeOpenTimeoutMs: number = ROOM_HANDSHAKE_OPEN_TIMEOUT_MS;
  /**
   * Test-only hook: when false, wss:// join candidates skip TLS CA checks so
   * self-signed local test certs pass. Never set outside tests — production
   * guests always verify the relay certificate against the system CA.
   */
  private wssRejectUnauthorized?: boolean;
  /**
   * Process-wide room transport counters (task 12). Public readonly so the
   * debug IPC can snapshot them; tests inject a quiet instance.
   */
  readonly metrics: RoomMetrics;
  private readonly cpa?: CpaSupervisor;
  private readonly aiProxies = new Map<string, LoopbackProxy>();
  private readonly aiHttpWait = new Map<
    string,
    {
      parts: Map<number, string>;
      status?: number;
      resolve: (v: { status: number; body: Buffer }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly aiHttpAssemble = new Map<
    string,
    {
      method?: string;
      path?: string;
      targetUserId: string;
      sourceUserId: string;
      parts: Map<number, string>;
    }
  >();
  /** 本机审批中的房间轮次（filePolicy = ask）：requestId → 挂起的决议。 */
  private readonly turnAsks = new Map<
    string,
    {
      roomId: string;
      resolve: (allow: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(opts: {
    getWindow: () => BrowserWindow | null;
    /** Push a channel to every live renderer window (main + detached). */
    sendToAllWindows?: (channel: string, payload: unknown) => void;
    sessions: SessionManager;
    settings: SettingsStore;
    archive?: RoomArchive | null;
    userDataDir?: string;
    isPackaged?: boolean;
    resourcesPath?: string;
    cloudflaredPath?: string;
    /** Injectable transport counters (tests pass a silent logger). */
    metrics?: RoomMetrics;
    cpa?: CpaSupervisor;
  }) {
    this.getWindow = opts.getWindow;
    this.sendToAllWindows = opts.sendToAllWindows;
    this.sessions = opts.sessions;
    this.settings = opts.settings;
    this.cpa = opts.cpa;
    this.archive = opts.archive ?? null;
    this.userDataDir = opts.userDataDir ?? os.tmpdir();
    this.isPackaged = opts.isPackaged ?? false;
    this.resourcesPath = opts.resourcesPath;
    this.cloudflaredPath = opts.cloudflaredPath;
    this.deviceKeys = loadOrCreateDeviceKeys(this.userDataDir);
    this.deviceFp = fingerprintPublic(this.deviceKeys.publicRaw);
    this.metrics = opts.metrics ?? new RoomMetrics();
    this.hydrateFromArchive();
    // Fire-and-forget: rebind host rooms that were open at exit (each
    // completion/failure pushes a roomEvent; resume never throws).
    this.resumeArchivedRooms();
  }

  private pathEnv(): RuntimePathEnv {
    return {
      isPackaged: this.isPackaged,
      userDataDir: this.userDataDir,
      ...(this.resourcesPath ? { resourcesPath: this.resourcesPath } : {}),
      ...(this.cloudflaredPath ? { cloudflaredPath: this.cloudflaredPath } : {}),
    };
  }

  listMods(): {
    mods: Array<ModPackInfo & { hostApi?: 1 | 2 }>;
  } {
    const play = listModPacks(this.pathEnv()).map((p) => ({ ...p, hostApi: 1 as const }));
    const kernel = listKernelPacks(this.pathEnv());
    return { mods: [...play, ...kernel] };
  }

  hasMod(checksum: string): { ok: true; has: boolean } {
    return { ok: true, has: hasModCache(this.pathEnv(), checksum) };
  }

  /** Delete a cached (user/synced) mod pack. Bundled packs are read-only. */
  deleteMod(packDir: string): { ok: boolean; error?: string } {
    const env = this.pathEnv();
    const resolved = path.resolve(packDir);
    const cacheRoots = [getModCacheDir(env), getKernelCacheDir(env)].map((r) =>
      path.resolve(r),
    );
    if (!cacheRoots.some((root) => path.dirname(resolved) === root)) {
      return { ok: false, error: "只能删除缓存目录中的 Mod" };
    }
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Scaffold a minimal kernel mod (hostApi 2) into the kernel cache dir. */
  scaffoldMod(input: { id: string; name: string }): {
    ok: boolean;
    packDir?: string;
    error?: string;
  } {
    const id = input.id.trim();
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(id)) {
      return { ok: false, error: "id 只能包含小写字母、数字和连字符（2-49 字符）" };
    }
    const name = input.name.trim() || id;
    const dir = path.join(getKernelCacheDir(this.pathEnv()), `user-${id}`);
    if (fs.existsSync(dir)) {
      return { ok: false, error: "同名 Mod 目录已存在" };
    }
    const manifest = {
      id,
      name,
      version: "0.1.0",
      hostApi: 2,
      inject: [],
      provides: [],
      permissions: [],
      hooks: ["room.chat.in"],
    };
    const modJs = `// ${name} — kernel mod (hostApi 2)
// 文档参见 docs/mods/hostapi-2.md
export function activate(ctx) {
  ctx.hooks.on("room.chat.in", (env) => {
    // 返回 { action: "drop", reason } 丢弃消息；
    // 返回 { action: "replace", value: { ...env, text } } 改写；
    // 返回 { action: "continue" } 或不返回则原样透传。
    return { action: "continue" };
  });
}
`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        "utf8",
      );
      fs.writeFileSync(path.join(dir, "mod.js"), modJs, "utf8");
      return { ok: true, packDir: dir };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private hydrateFromArchive(): void {
    if (!this.archive) return;
    for (const stored of this.archive.loadIndex()) {
      // No live socket after restart: guest rooms show ended (manual rejoin);
      // host rooms left open are flagged resumePending and rebound by
      // resumeArchivedRooms() right after this hydrate.
      const status = stored.status === "open" ? "ended" : stored.status;
      const rec: RoomRecord = {
        roomId: stored.roomId,
        name: stored.name,
        // Host rooms persist their own password (resume hosting); older
        // archives only carry join.password on guest rooms — a pre-resume
        // host archive without it simply reopens passwordless.
        password: stored.password ?? stored.join?.password ?? "",
        port: stored.port,
        requireMods: Boolean(stored.requireMods),
        autoApprove: Boolean(stored.autoApprove),
        encrypt: stored.encrypt ?? true,
        hostFingerprint:
          stored.hostFingerprint ?? stored.join?.hostFingerprint ?? "",
        // Public paths default to "not restored" on old archives that lack
        // the fields; the LAN listener resumes regardless.
        ...(stored.publicWss ? { publicWss: stored.publicWss } : {}),
        ...(stored.tunnel ? { tunnelWanted: true } : {}),
        ...(stored.relay ? { relayAddr: stored.relay } : {}),
        ...(stored.relayToken ? { relayToken: stored.relayToken } : {}),
        ...(stored.relayRoomId ? { relayRoomId: stored.relayRoomId } : {}),
        deviceKeys: this.deviceKeys,
        connections: new Map(),
        pendingByFp: new Map(),
        blacklist: new Set(stored.blacklist ?? []),
        knownDevices: new Map(
          (stored.knownDevices ?? []).map((d) => [d.fp, d]),
        ),
        modChecksum: stored.modChecksum ?? "",
        status,
        hostUserId: stored.role === "host" ? (stored.localUserId ?? "") : "",
        hostLabel: stored.hostLabel ?? "",
        localUserId: stored.localUserId ?? "",
        localRole: stored.role,
        members: (stored.members ?? []).map((m) => ({
          ...m,
          // 重启后没有活 socket：只有房主自己算在线，客人等手动重连。
          online: stored.role === "host" ? m.role === "host" : m.online,
        })),
        seats: stored.seats ?? [],
        items: stored.items ?? [],
        seq: 1,
        server: null,
        guests: new Set(),
        client: null,
        ...(stored.offline ||
        (stored.role === "member" && stored.status === "open")
          ? { offline: true }
          : {}),
        ...(stored.join
          ? {
              joinInfo: {
                host: stored.join.host,
                hosts: stored.join.hosts ?? [stored.join.host],
                port: stored.join.port,
                password: stored.join.password,
                modChecksum: stored.join.modChecksum,
                secret: stored.join.secret,
                hostFingerprint: stored.join.hostFingerprint,
                wss: stored.join.wss,
                path: stored.join.path,
              },
            }
          : {}),
      };
      // Host rooms left open at exit resume hosting on startup: same port +
      // persisted device keys → same fingerprint → the old invite stays valid.
      if (stored.status === "open" && stored.role === "host") {
        rec.resumePending = true;
      }
      this.rooms.set(rec.roomId, rec);
      // Keep the archived "open" for rooms about to resume — if the app dies
      // mid-resume the next launch retries; a failed resume persists "ended".
      if (status !== stored.status && !rec.resumePending) this.persist(rec);
    }
  }

  /** Rebind every archived host room left open at exit (fire-and-forget). */
  private resumeArchivedRooms(): void {
    for (const r of this.rooms.values()) {
      if (!r.resumePending) continue;
      r.resumePending = undefined;
      void this.resumeHostRoom(r);
    }
  }

  /**
   * Resume hosting one archived room: rebind its original port (0.0.0.0) with
   * the same onGuest wiring as create(), then re-establish the persisted
   * public paths. Never throws — a failed resume marks the room ended with a
   * system timeline message and leaves the other rooms alone.
   */
  private async resumeHostRoom(r: RoomRecord): Promise<void> {
    try {
      const bound = await this.bindHostServer(r);
      if (!bound.ok) {
        r.status = "ended";
        this.append(r, {
          kind: "system",
          text: `重启后自动恢复开房失败：${bound.error}。房间已标记为结束，可重新创建`,
          authorLabel: "系统",
        });
        this.emit(r);
        return;
      }
      r.status = "open";
      this.append(r, {
        kind: "system",
        text: `已从上次退出恢复开房 · 监听 0.0.0.0:${r.port}（原邀请码仍有效）`,
        authorLabel: "系统",
      });
      // publicWss is a stable external endpoint — nothing to re-establish;
      // hydrate already restored it and invite() picks it up from here.
      if (r.tunnelWanted) {
        // Quick tunnels get a random URL per process (old invites lose the
        // tunnel entry); named tunnels read the stable endpoint from
        // userData/cloudflare-tunnel.json. Tunnel failure degrades to LAN.
        const named = readNamedTunnelConfig(this.userDataDir);
        const t = await startRoomTunnel({ port: r.port, env: this.pathEnv() });
        if (t.ok) {
          r.tunnel = { wss: t.wss, kill: t.kill };
          this.append(r, {
            kind: "system",
            text: `Cloudflare 隧道已开启：${t.wss}`,
            authorLabel: "系统",
          });
          if (!named) {
            this.append(r, {
              kind: "system",
              text: "隧道地址已更新，旧邀请码的隧道入口已失效，请重新分享邀请码",
              authorLabel: "系统",
            });
          }
        } else {
          this.append(r, {
            kind: "system",
            text: `Cloudflare 隧道不可用：${t.error}（房间仍可通过局域网加入）`,
            authorLabel: "系统",
          });
        }
      }
      if (r.relayAddr && r.relayRoomId) {
        // Re-register the same room id → the relay join URL is unchanged, so
        // old invites keep working. Relay failure degrades to LAN.
        const res = await startRoomRelay({
          relay: r.relayAddr,
          ...(r.relayToken ? { token: r.relayToken } : {}),
          roomId: r.relayRoomId,
          localPort: r.port,
        });
        if (res.ok) {
          r.relay = { url: res.url, kill: res.kill };
          this.append(r, {
            kind: "system",
            text: `中继服务器已连接：${res.url}`,
            authorLabel: "系统",
          });
        } else {
          this.append(r, {
            kind: "system",
            text: `中继不可用：${res.error}（房间仍可通过局域网加入）`,
            authorLabel: "系统",
          });
        }
      }
      this.persist(r);
      this.emit(r);
    } catch (err) {
      // Belt and braces: a resume failure must never take the app down.
      r.status = "ended";
      try {
        r.server?.close();
      } catch {
        // ignore
      }
      r.server = null;
      this.append(r, {
        kind: "system",
        text: `重启后自动恢复开房失败：${err instanceof Error ? err.message : String(err)}`,
        authorLabel: "系统",
      });
      this.emit(r);
    }
  }

  list(): RoomListItem[] {
    return [...this.rooms.values()]
      .filter((r) => r.status === "open" || r.items.length > 0)
      .map((r) => ({
        roomId: r.roomId,
        name: r.name,
        status: r.status,
        role: r.localRole,
        memberCount: r.members.length,
        onlineCount: countOnlineMembers(r.members),
        port: r.port,
        inviteHost: r.joinInfo?.host || lanAddress(),
        ...(r.offline ? { offline: true } : {}),
      }))
      .sort((a, b) => {
        // open first
        if (a.status !== b.status) return a.status === "open" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  get(roomId: string): RoomSnapshot | null {
    const r = this.rooms.get(roomId);
    if (r) return this.snapshot(r);
    const stored = this.archive?.loadRoom(roomId);
    if (!stored) return null;
    return {
      roomId: stored.roomId,
      name: stored.name,
      status: stored.status,
      port: stored.port,
      hostLabel: stored.hostLabel ?? "",
      inviteHost: stored.inviteHost,
      memberCount: stored.memberCount,
      requireMods: Boolean(stored.requireMods),
      modChecksum: stored.modChecksum ?? "",
      autoApprove: Boolean(stored.autoApprove),
      hasPassword: Boolean(stored.hasPassword),
      encrypt: stored.encrypt ?? true,
      hostFingerprint: stored.hostFingerprint ?? stored.join?.hostFingerprint,
      members: stored.members ?? [],
      seats: stored.seats ?? [],
      items: stored.items ?? [],
    };
  }

  /** Resolve hidden seat/worker sessions for scoped renderer IPC routing. */
  roomIdForSession(sessionId: string): string | undefined {
    for (const room of this.rooms.values()) {
      if (room.seats.some((seat) => seat.sessionId === sessionId)) {
        return room.roomId;
      }
      if (
        [...(room.nodeTurns?.values() ?? [])].some(
          (turn) => turn.sessionId === sessionId,
        )
      ) {
        return room.roomId;
      }
    }
    return undefined;
  }

  invite(roomId: string) {
    const r = this.rooms.get(roomId);
    if (!r || r.localRole !== "host") {
      return { ok: false as const, error: "只有群主可以邀请" };
    }
    const hosts = lanAddresses();
    const host = hosts[0] ?? "127.0.0.1";
    const wssList = [r.publicWss, r.tunnel?.wss, r.relay?.url].filter(
      (u): u is string => Boolean(u),
    );
    let secret: string | undefined;
    try {
      // CDR2: host/port/fingerprint only — the password never goes in here.
      secret = encodeRoomInvite({
        host,
        hosts,
        port: r.port,
        hostFingerprint: r.hostFingerprint,
        modChecksum: r.modChecksum || undefined,
        roomName: r.name,
        ...(wssList.length ? { wss: wssList } : {}),
      });
    } catch {
      secret = undefined;
    }
    return {
      ok: true as const,
      host,
      hosts,
      port: r.port,
      // Shown to the host only; guests must type it themselves.
      password: r.password || undefined,
      modChecksum: r.modChecksum || undefined,
      hostFingerprint: r.hostFingerprint,
      listening: Boolean(r.server),
      secret,
    };
  }

  async peek(opts: {
    host: string;
    port: number;
    hosts?: string[];
    wss?: string[];
  }): Promise<{ ok: boolean; offer?: ModOfferPayload; error?: string }> {
    const host = this.normalizeHost(opts.host);
    const port = opts.port;
    if (!host || !port) return { ok: false, error: "请填写地址和端口" };
    const cached = this.cachedOffer(host, port);
    if (cached) return { ok: true, offer: cached };
    const urls = this.joinCandidateUrls(host, opts.hosts, port, opts.wss);
    return this.withHostSocket(urls, async (ws) => {
      const pending = waitFrame(ws, "mod.offer", 8000);
      this.sendRaw(ws, "pending", 1, "hello", {
        protocol: ROOM_PROTOCOL_VERSION,
      });
      const frame = await pending;
      if (!frame) return { ok: false, error: "主机未返回模组信息" };
      if (frame.type === "error") {
        return {
          ok: false,
          error: (frame.payload as { message?: string })?.message ?? "窥探失败",
        };
      }
      return { ok: true, offer: frame.payload as ModOfferPayload };
    });
  }

  async fetchMod(opts: {
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
    const host = this.normalizeHost(opts.host);
    const port = opts.port;
    const checksum = (opts.checksum ?? "").trim();
    if (!host || !port) return { ok: false, error: "请填写地址和端口" };
    if (!MOD_CHECKSUM_RE.test(checksum)) {
      return { ok: false, error: "模组校验码无效" };
    }
    const urls = this.joinCandidateUrls(host, opts.hosts, port, opts.wss);
    return this.withHostSocket(urls, async (ws) => {
      const pendingOffer = waitFrame(ws, "mod.offer", 8000);
      this.sendRaw(ws, "pending", 1, "hello", {
        protocol: ROOM_PROTOCOL_VERSION,
      });
      const offerFrame = await pendingOffer;
      if (!offerFrame || offerFrame.type === "error") {
        return {
          ok: false,
          error:
            (offerFrame?.payload as { message?: string })?.message ??
            "主机未返回模组信息",
        };
      }
      const offer = offerFrame.payload as ModOfferPayload;
      if (!offer.checksum || offer.size <= 0) {
        return { ok: false, error: "群聊未启用模组", offer };
      }
      if (offer.checksum !== checksum) {
        return { ok: false, error: "模组校验码不一致", offer };
      }
      // Host serves mod.fetch before hs.ok (checksum is already in the
      // invite). Skipping the handshake avoids a fake approval request
      // for this short-lived download — join() still does the real one.
      const collecting = collectBundles(ws, null, checksum, offer.size, 30_000);
      this.sendRaw(ws, "pending", 2, "mod.fetch", { checksum });
      const collected = await collecting;
      if (!collected.ok) {
        return { ok: false, error: collected.error, offer };
      }
      const bytes = collected.bytes;
      try {
        const loaded = writeModBytes(this.pathEnv(), bytes);
        if (loaded.checksum !== checksum) {
          return { ok: false, error: "模组校验码不一致", offer };
        }
        return { ok: true, checksum: loaded.checksum, offer };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          offer,
        };
      }
    });
  }

  async enableMod(
    roomId: string,
    packDir: string,
  ): Promise<{
    ok: boolean;
    room?: RoomSnapshot;
    offer?: ModOfferPayload;
    error?: string;
  }> {
    const r = this.rooms.get(roomId);
    if (!r || r.localRole !== "host") {
      return { ok: false, error: "只有群主可以启用模组" };
    }
    if (r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.modStarted && !r.modEnded) {
      return { ok: false, error: "请先结束当前玩法" };
    }
    if (peekHostApi(packDir) === 2) {
      return { ok: false, error: "这是群聊扩展，请用扩展入口启用" };
    }
    let loaded: LoadedMod;
    try {
      loaded = loadModDir(packDir);
      readModBytes(loaded);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/exceeds/.test(msg)) {
        return {
          ok: false,
          error: `模组超过 ${MOD_BUNDLE_MAX_BYTES} 字节上限`,
        };
      }
      return { ok: false, error: msg };
    }
    let host: ModHost;
    try {
      host = await ModHost.start({
        roomId: r.roomId,
        loaded,
        persistPath: getModPersistPath(this.pathEnv(), r.roomId),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const prev = r.modHost;
    r.modHost = host;
    if (prev) {
      try {
        prev.dispose();
      } catch {
        // ignore
      }
    }
    host.onFail((msg) => this.onModFail(r, msg));
    try {
      writeModCache(this.pathEnv(), loaded);
    } catch {
      // cache is optional
    }
    r.modLoaded = loaded;
    r.modStarted = false;
    r.modEnded = false;
    r.modFail = undefined;
    r.modPublicView = undefined;
    r.modSeatViews = undefined;
    r.modSeq = 0;
    r.modChecksum = loaded.checksum;
    r.requireMods = true;
    r.modOffer = this.buildOffer(r);
    this.pushState(r);
    return { ok: true, room: this.snapshot(r), offer: r.modOffer };
  }

  async startMod(roomId: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.hostRoom(roomId);
    if (!r.ok) return r;
    const rec = r.room;
    if (!rec.modHost || !rec.modLoaded) {
      return { ok: false, error: "尚未启用模组" };
    }
    if (rec.modFail) return { ok: false, error: rec.modFail };
    if (rec.modStarted && !rec.modEnded) {
      return { ok: false, error: "玩法已开始" };
    }
    const { min, max } = rec.modLoaded.manifest.seats;
    if (rec.seats.length < min || rec.seats.length > max) {
      return { ok: false, error: `席位数量须在 ${min}–${max} 之间` };
    }
    return this.enqueueIntent(rec, () =>
      this.dispatchMod(rec, {
        seatId: "",
        name: "mod.start",
        payload: { seats: toModSeats(rec.seats) },
        actorUserId: rec.hostUserId,
        after: () => {
          rec.modStarted = true;
          rec.modEnded = false;
        },
      }),
    );
  }

  async endMod(roomId: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.hostRoom(roomId);
    if (!r.ok) return r;
    const rec = r.room;
    if (!rec.modHost && !rec.modChecksum) {
      return { ok: false, error: "尚未启用模组" };
    }
    if (rec.modHost && rec.modStarted && !rec.modEnded) {
      await this.enqueueIntent(rec, () =>
        this.dispatchMod(rec, {
          seatId: "",
          name: "mod.end",
          payload: {},
          actorUserId: rec.hostUserId,
          persist: false,
        }),
      );
    }
    this.clearMod(rec);
    this.pushState(rec);
    return { ok: true };
  }

  async resetMod(roomId: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.hostRoom(roomId);
    if (!r.ok) return r;
    const rec = r.room;
    if (!rec.modHost || !rec.modStarted || rec.modEnded) {
      return { ok: false, error: "玩法未开始" };
    }
    return this.enqueueIntent(rec, async () => {
      try {
        await rec.modHost!.resetToStart(toModSeats(rec.seats));
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      rec.modFail = undefined;
      return this.dispatchMod(rec, {
        seatId: "",
        name: "mod.start",
        payload: { seats: toModSeats(rec.seats) },
        actorUserId: rec.hostUserId,
      });
    });
  }

  async recoverMod(roomId: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.hostRoom(roomId);
    if (!r.ok) return r;
    const rec = r.room;
    if (!rec.modHost) return { ok: false, error: "尚未启用模组" };
    try {
      await rec.modHost.restoreFromDisk();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    rec.modFail = undefined;
    rec.modStarted = true;
    rec.modEnded = false;
    await this.publishViews(rec);
    return { ok: true };
  }

  async modIntent(
    roomId: string,
    seatId: string,
    name: string,
    payload: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const rec = this.rooms.get(roomId);
    if (!rec || rec.status !== "open") return { ok: false, error: "群聊不可用" };
    const seat = rec.seats.find((s) => s.id === seatId);
    if (!seat) return { ok: false, error: "请先选一个席位" };
    if (rec.localRole !== "host") {
      if (!this.canAct(seat, rec.localUserId)) {
        return { ok: false, error: "当前不能操作这个席位" };
      }
      this.sendClient(rec, "mod.intent", { seatId, name, payload });
      return { ok: true };
    }
    if (!this.canAct(seat, rec.localUserId)) {
      return { ok: false, error: "当前不能操作这个席位" };
    }
    if (!rec.modHost || !rec.modStarted || rec.modEnded) {
      return { ok: false, error: "玩法未开始" };
    }
    if (rec.modFail) return { ok: false, error: rec.modFail };
    return this.enqueueIntent(rec, () =>
      this.dispatchMod(rec, {
        seatId,
        name,
        payload,
        actorUserId: rec.localUserId,
      }),
    );
  }

  async create(opts: {
    name: string;
    password?: string;
    port?: number;
    requireMods?: boolean;
    autoApprove?: boolean;
    /** Default true; false keeps the legacy plaintext transport. */
    encrypt?: boolean;
    /**
     * Public wss:// endpoint terminated outside this process (T1/T2, e.g.
     * wss://home.example.com:443). Written into the invite's u array;
     * forces encryption on.
     */
    publicWss?: string;
    /** wss:// relay endpoints (T1/T2) — forces encryption on. */
    wss?: string[];
    /**
     * Start a Cloudflare tunnel after bind (T2). The public wss:// URL goes
     * into the invite's u array; forces encryption on. Tunnel failures
     * degrade to a LAN-only room instead of failing create.
     */
    tunnel?: boolean;
    /**
     * Self-hosted relay (ws:// or wss://, scripts/room-relay-server.mjs on a
     * VPS). The host dials out; the public join URL goes into the invite's u
     * array; forces encryption on. Relay failures degrade to a LAN-only room.
     */
    relay?: string;
    /** Optional auth token matching the relay's --token. */
    relayToken?: string;
  }): Promise<{ ok: boolean; room?: RoomSnapshot; error?: string }> {
    const name = opts.name.trim();
    if (!name) return { ok: false, error: "请填写群聊名" };
    const publicWss = (opts.publicWss ?? "").trim();
    if (publicWss && !/^wss:\/\//i.test(publicWss)) {
      return { ok: false, error: "公网地址须以 wss:// 开头" };
    }
    const relay = (opts.relay ?? "").trim();
    if (relay && !/^wss?:\/\//i.test(relay)) {
      return { ok: false, error: "中继地址须以 ws:// 或 wss:// 开头" };
    }
    const relayToken = (opts.relayToken ?? "").trim();
    const port = opts.port && opts.port > 0 ? opts.port : ROOM_DEFAULT_PORT;
    // Relayed (public) rooms must never go plaintext.
    const encrypt =
      opts.encrypt !== false ||
      (opts.wss?.length ?? 0) > 0 ||
      Boolean(publicWss) ||
      Boolean(opts.tunnel) ||
      Boolean(relay);

    // Refuse if we already host an open room on this port
    for (const existing of this.rooms.values()) {
      if (
        existing.status === "open" &&
        existing.localRole === "host" &&
        existing.port === port &&
        existing.server
      ) {
        return {
          ok: false,
          error: `端口 ${port} 上已有群聊「${existing.name}」，请先结束它或换端口`,
        };
      }
    }

    const roomId = randomUUID();
    const hostUserId = randomUUID();
    const hostName = displayName();
    const ips = lanAddresses();

    const rec: RoomRecord = {
      roomId,
      name,
      password: (opts.password ?? "").trim(),
      port,
      requireMods: Boolean(opts.requireMods),
      autoApprove: Boolean(opts.autoApprove),
      encrypt,
      hostFingerprint: this.deviceFp,
      ...(publicWss ? { publicWss } : {}),
      ...(opts.tunnel ? { tunnelWanted: true } : {}),
      deviceKeys: this.deviceKeys,
      connections: new Map(),
      pendingByFp: new Map(),
      blacklist: new Set(),
      knownDevices: new Map(),
      modChecksum: "",
      status: "open",
      hostUserId,
      hostLabel: hostName,
      localUserId: hostUserId,
      localRole: "host",
      members: [
        {
          userId: hostUserId,
          name: hostName,
          role: "host",
          online: true,
          projectPath: this.settings.get().lastProjectPath ?? null,
        },
      ],
      seats: [
        {
          id: randomUUID(),
          kind: "human",
          name: hostName,
          occupantUserId: hostUserId,
          takenOverBy: null,
          sessionId: null,
          running: false,
          agentName: null,
        },
      ],
      items: [
        {
          id: randomUUID(),
          at: Date.now(),
          seatId: "",
          authorUserId: hostUserId,
          authorLabel: "系统",
          kind: "system",
          text: `群聊「${name}」已创建 · 监听 0.0.0.0:${port}`,
        },
      ],
      seq: 1,
      server: null,
      guests: new Set(),
      client: null,
    };

    const bound = await this.bindHostServer(rec);
    if (!bound.ok) return { ok: false, error: bound.error };

    this.append(rec, {
      kind: "system",
      text: `本机已开口 · 客人请连：${ips.map((ip) => `${ip}:${port}`).join(" 或 ")}（防火墙需放行 TCP ${port}）`,
      authorLabel: "系统",
    });

    if (opts.tunnel) {
      // T2: cloudflared quick/named tunnel pointing at the loopback port.
      // Failures degrade to a LAN-only room — create never fails on this.
      const t = await startRoomTunnel({ port, env: this.pathEnv() });
      if (t.ok) {
        rec.tunnel = { wss: t.wss, kill: t.kill };
        this.append(rec, {
          kind: "system",
          text: `Cloudflare 隧道已开启：${t.wss}`,
          authorLabel: "系统",
        });
      } else {
        this.append(rec, {
          kind: "system",
          text: `Cloudflare 隧道不可用：${t.error}（房间仍可通过局域网加入）`,
          authorLabel: "系统",
        });
      }
    }

    if (relay) {
      // Self-hosted relay: the host dials out, guests join via the relay URL.
      // Failures degrade to a LAN-only room — create never fails on this.
      // The relay address/token/roomId persist with the room so a restart
      // re-registers the same id and the old invite URL keeps working.
      const relayRoomId = randomBytes(6).toString("hex");
      rec.relayAddr = relay;
      if (relayToken) rec.relayToken = relayToken;
      rec.relayRoomId = relayRoomId;
      const res = await startRoomRelay({
        relay,
        ...(relayToken ? { token: relayToken } : {}),
        roomId: relayRoomId,
        localPort: port,
      });
      if (res.ok) {
        rec.relay = { url: res.url, kill: res.kill };
        this.append(rec, {
          kind: "system",
          text: `中继服务器已连接：${res.url}`,
          authorLabel: "系统",
        });
      } else {
        this.append(rec, {
          kind: "system",
          text: `中继不可用：${res.error}（房间仍可通过局域网加入）`,
          authorLabel: "系统",
        });
      }
    }

    this.rooms.set(roomId, rec);
    this.persist(rec);
    this.emit(rec);
    return { ok: true, room: this.snapshot(rec) };
  }

  /**
   * Bind the room's WebSocketServer on 0.0.0.0 with the onGuest wiring and a
   * loopback self-check. Shared by create() and resumeHostRoom(); on failure
   * the half-bound server is closed and r.server is left null.
   */
  private async bindHostServer(
    r: RoomRecord,
  ): Promise<{ ok: boolean; error?: string }> {
    const port = r.port;
    let wss: WebSocketServer;
    try {
      wss = new WebSocketServer({ host: "0.0.0.0", port, backlog: 16 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `无法绑定端口 ${port}：${msg}（可能被占用，请换端口）`,
      };
    }

    r.server = wss;
    wss.on("connection", (ws) => this.onGuest(r, ws));
    wss.on("error", (err) => {
      this.pushError(`群聊端口 ${port} 错误：${err.message}`);
    });

    try {
      await waitForListening(wss, port);
    } catch (err) {
      try {
        wss.close();
      } catch {
        // ignore
      }
      r.server = null;
      const msg = err instanceof Error ? err.message : String(err);
      // EADDRINUSE often surfaces here
      if (/EADDRINUSE|in use/i.test(msg)) {
        return {
          ok: false,
          error: `端口 ${port} 已被占用，请换一个端口再创建`,
        };
      }
      return { ok: false, error: `监听失败：${msg}` };
    }

    // Self-check: can we connect to ourselves on 127.0.0.1?
    const loopbackOk = await this.probeLocalPort(port);
    if (!loopbackOk) {
      try {
        wss.close();
      } catch {
        // ignore
      }
      r.server = null;
      return {
        ok: false,
        error: `端口 ${port} 已绑定但本机探测失败，请重启应用后重试`,
      };
    }
    return { ok: true };
  }

  /** Quick WS connect to 127.0.0.1:port to verify the host is reachable locally. */
  private probeLocalPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        resolve(v);
      };
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => done(false), 2000);
      ws.on("open", () => {
        clearTimeout(timer);
        done(true);
      });
      ws.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
    });
  }

  async join(opts: {
    host: string;
    port: number;
    password?: string;
    name?: string;
    modChecksum?: string;
    hosts?: string[];
    /** wss:// relay endpoints from the CDR2 invite (T1/T2). */
    wss?: string[];
    /** Expected host device fingerprint from the CDR2 invite (TOFU pin). */
    hostFingerprint?: string;
    /** Rejoin: reuse the previous member identity so the host keeps seats */
    userId?: string;
  }): Promise<{ ok: boolean; room?: RoomSnapshot; error?: string }> {
    let host = opts.host.trim();
    // Strip accidental scheme / path / brackets
    host = host
      .replace(/^wss?:\/\//i, "")
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/^\[|\]$/g, "");
    // host:port pasted into host field
    if (host.includes(":") && !host.includes("::")) {
      const [h, p] = host.split(":");
      if (h && p && /^\d+$/.test(p)) {
        host = h;
        if (!opts.port || opts.port === ROOM_DEFAULT_PORT) {
          opts = { ...opts, port: Number(p) };
        }
      }
    }
    const port = opts.port;
    if (!host || !port) return { ok: false, error: "请填写地址和端口" };
    if (!/^\d{1,5}$/.test(String(port)) || port < 1 || port > 65535) {
      return { ok: false, error: "端口无效" };
    }

    const userId = opts.userId ?? randomUUID();
    const name = (opts.name ?? displayName()).trim() || displayName();
    const checksum = (opts.modChecksum ?? "").trim();
    // Race every candidate (LAN ws:// + wss://) in parallel; the first
    // socket to open wins and the rest are closed (2s per candidate).
    const candidates = this.joinCandidateUrls(host, opts.hosts, port, opts.wss);

    return new Promise((resolve) => {
      let settled = false;
      let lastErr = "";
      const done = (v: { ok: boolean; room?: RoomSnapshot; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      void this.raceCandidates(candidates).then((winner) => {
        if (settled) return;
        if (!winner) {
          done({
            ok: false,
            error:
              `无法连接主机（已尝试 ${candidates.length} 条路径）\n` +
              `请确认：① 群主已点「创建并打开」且群聊显示「开着」` +
              ` ② 群主 Windows 防火墙放行 TCP ${port} 入站` +
              ` ③ IP 是否正确（群主点「邀请」复制）` +
              ` ④ 本机自测可先填 127.0.0.1`,
          });
          return;
        }
        const ws = winner.ws;
        const winPath = winner.path;
        ws.on("error", (err) => {
          lastErr = err.message;
          // Don't settle immediately on error — wait for close/timeout so we
          // can show a clearer message. Node ws often emits error then close.
        });

        let rec: RoomRecord | null = null;
        // Armed after hs.ok — guards the post-handshake join → welcome phase.
        let timer: ReturnType<typeof setTimeout> | undefined;

        // The socket is already open — from here the handshake owns its own
        // timeout (10s, extended to 60s while the host holds us in approval).
        void this.handshakeAsGuest(ws, {
          password: opts.password ?? "",
          name,
          hostFingerprint: opts.hostFingerprint,
          userId,
        }).then((hs) => {
          if (settled) return;
          if (!hs.ok) {
            if (timer) clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // ignore
            }
            done({ ok: false, error: hs.error });
            return;
          }
          // Guard the post-handshake join → welcome phase.
          timer = setTimeout(() => {
            try {
              ws.close();
            } catch {
              // ignore
            }
            done({ ok: false, error: "加入超时：主机未返回房间快照" });
          }, 12_000);
          const conn = hs.conn;
          conn.onFrame((frame) => {
            if (settled && rec) return;
            if (frame.type === "error") {
              clearTimeout(timer);
              const msg =
                (frame.payload as { message?: string })?.message ?? "加入失败";
              try {
                ws.close();
              } catch {
                // ignore
              }
              done({ ok: false, error: msg });
              return;
            }
            if (frame.type === "welcome" || frame.type === "state.snapshot") {
              if (rec?.closing) return;
              const snap = frame.payload as RoomSnapshot;
              if (!rec) {
                clearTimeout(timer);
                rec = {
                  roomId: snap.roomId,
                  name: snap.name,
                  password: opts.password ?? "",
                  port,
                  requireMods: snap.requireMods,
                  autoApprove: snap.autoApprove,
                  encrypt: hs.encrypt,
                  hostFingerprint: hs.hostFp,
                  deviceKeys: this.deviceKeys,
                  connections: new Map([[ws, conn]]),
                  pendingByFp: new Map(),
                  blacklist: new Set(),
                  knownDevices: new Map(),
                  modChecksum: snap.modChecksum,
                  status: snap.status,
                  hostUserId:
                    snap.members.find((m) => m.role === "host")?.userId ?? "",
                  hostLabel: snap.hostLabel,
                  localUserId: userId,
                  localRole: "member",
                  members: snap.members,
                  seats: snap.seats,
                  items: snap.items,
                  seq: frame.seq,
                  server: null,
                  guests: new Set(),
                  client: ws,
                  kernelProjection: snap.kernel,
                  joinInfo: {
                    host,
                    hosts: [
                      host,
                      ...(opts.hosts ?? []).filter((h) => h && h !== host),
                    ],
                    port,
                    password: opts.password,
                    modChecksum: checksum,
                    hostFingerprint: hs.hostFp,
                    wss: opts.wss,
                    path: winPath,
                  },
                };
                this.rooms.set(snap.roomId, rec);
                this.bindGuestSocket(rec, ws);
                this.persist(rec);
                this.emit(rec);
                done({ ok: true, room: this.snapshot(rec) });
                return;
              }
              // Later snapshots are handled by bindGuestSocket.
            }
            if (frame.type === "room.closed" && rec) {
              this.dismissGuest(
                rec,
                (frame.payload as { message?: string })?.message ??
                  "群主已解散群聊",
              );
            }
          });
          // Password already proven by the handshake — never inside join.
          try {
            conn.sendFrame(
              makeRoomFrame("pending", 1, "join", {
                userId,
                name,
                protocol: ROOM_PROTOCOL_VERSION,
                modChecksum: checksum,
                projectPath: this.settings.get().lastProjectPath ?? null,
              }),
            );
          } catch (err) {
            if (timer) clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // ignore
            }
            const msg = err instanceof Error ? err.message : String(err);
            done({ ok: false, error: `加入失败：无法加密发送（${msg}）` });
          }
        })
        .catch((err: unknown) => {
          if (settled) return;
          if (timer) clearTimeout(timer);
          const msg = err instanceof Error ? err.message : String(err);
          done({ ok: false, error: `加入失败：${msg}` });
        });

        ws.on("close", () => {
          if (!settled) {
            if (timer) clearTimeout(timer);
            done({
              ok: false,
              error: lastErr
                ? `连接被关闭 ${host}:${port}（${lastErr}）\n若是 ECONNREFUSED：群主未监听该端口；若超时：多半是防火墙`
                : `连接被关闭 ${host}:${port}`,
            });
          }
          // After join, bindGuestSocket owns reconnect.
        });
      });
    });
  }

  /**
   * Candidate URLs for join: every LAN host from the invite as ws:// (IPv6
   * literals bracketed), then every relay endpoint — wss://, or ws:// for a
   * self-hosted VPS relay. Raced by raceCandidates.
   */
  private joinCandidateUrls(
    host: string,
    hosts: string[] | undefined,
    port: number,
    wss: string[] | undefined,
  ): string[] {
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const h of [host, ...(hosts ?? [])]) {
      const bare = (h ?? "").trim();
      if (!bare) continue;
      const url = lanWsUrl(bare, port);
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    for (const u of wss ?? []) {
      const url = (u ?? "").trim();
      if (!/^wss?:\/\//i.test(url)) continue;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
    return urls;
  }

  /**
   * Path racing: all candidates connect in parallel with a 2s budget each;
   * Promise.any picks the first socket to open, the rest are closed. Returns
   * null when every candidate fails. wss TLS is verified against the system
   * CA — only tests may bypass that via the wssRejectUnauthorized hook.
   */
  private raceCandidates(
    urls: string[],
    timeoutMs = 2_000,
  ): Promise<{ ws: WebSocket; url: string; path: RoomPath } | null> {
    const sockets = new Set<WebSocket>();
    const attempts = urls.map(
      (url) =>
        new Promise<{ ws: WebSocket; url: string; path: RoomPath }>(
          (resolveAtt, rejectAtt) => {
            const path = pathForCandidateUrl(url);
            // One connect metric per candidate attempt (task 12).
            let recorded = false;
            const recordConnect = (ok: boolean) => {
              if (recorded) return;
              recorded = true;
              this.metrics.record({ type: "connect", path, ok });
            };
            let ws: WebSocket;
            try {
              ws = new WebSocket(url, {
                handshakeTimeout: timeoutMs,
                ...(this.wssRejectUnauthorized === false &&
                url.startsWith("wss://")
                  ? { rejectUnauthorized: false }
                  : {}),
              });
            } catch (err) {
              recordConnect(false);
              rejectAtt(err);
              return;
            }
            sockets.add(ws);
            const timer = setTimeout(() => {
              recordConnect(false);
              try {
                ws.terminate();
              } catch {
                // ignore
              }
              rejectAtt(new Error(`候选路径超时 ${url}`));
            }, timeoutMs);
            ws.on("open", () => {
              clearTimeout(timer);
              recordConnect(true);
              resolveAtt({ ws, url, path });
            });
            ws.on("error", (err) => {
              clearTimeout(timer);
              recordConnect(false);
              rejectAtt(err);
            });
          },
        ),
    );
    const closeLosers = (keep?: WebSocket) => {
      for (const ws of sockets) {
        if (ws === keep) continue;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
    return Promise.any(attempts).then(
      (winner) => {
        closeLosers(winner.ws);
        return winner;
      },
      () => {
        closeLosers();
        return null;
      },
    );
  }

  /**
   * Guest reconnect: 5 attempts, exponential backoff 1s/2s/4s/8s/8s before
   * each attempt. Every attempt re-runs the full join() handshake path
   * (password prove + host fingerprint check via handshakeAsGuest) and pulls
   * a fresh welcome/state.snapshot.
   */
  private async reconnectGuest(r: RoomRecord): Promise<void> {
    if (
      r.reconnecting ||
      r.closing ||
      r.localRole !== "member" ||
      !r.joinInfo ||
      r.status !== "open"
    ) {
      return;
    }
    r.reconnecting = true;
    const gen = r.reconnectGen ?? 0;
    const info = r.joinInfo;
    const candidates = [
      info.host,
      ...(info.hosts ?? []).filter((h) => h && h !== info.host),
    ];

    for (let attempt = 1; attempt <= RECONNECT_BACKOFF_MS.length; attempt++) {
      if (r.closing || (r.reconnectGen ?? 0) !== gen) {
        r.reconnecting = false;
        return;
      }
      await this.reconnectSleep(RECONNECT_BACKOFF_MS[attempt - 1]);
      if (r.closing || (r.reconnectGen ?? 0) !== gen) {
        r.reconnecting = false;
        return;
      }
      this.safeSend(IPC.roomEvent, {
        roomId: r.roomId,
        reconnecting: true,
        reconnectAttempt: attempt,
        message: `与主机断开，正在重连（${attempt}/${RECONNECT_BACKOFF_MS.length}）…`,
        room: this.snapshot(r),
      });

      let ok = false;
      for (const h of candidates) {
        if (r.closing || (r.reconnectGen ?? 0) !== gen) break;
        ok = await this.tryReconnectOnce(
          r,
          h,
          info.port,
          info.password,
          info.modChecksum,
        );
        if (ok) break;
      }
      if (ok) {
        if (r.closing) {
          r.reconnecting = false;
          return;
        }
        if (r.client?.readyState !== WebSocket.OPEN) {
          continue;
        }
        r.reconnecting = false;
        this.append(r, {
          kind: "system",
          text: "已重新连接主机",
          authorLabel: "系统",
        });
        this.persist(r);
        this.emit(r);
        return;
      }
    }

    r.reconnecting = false;
    if (r.closing || (r.reconnectGen ?? 0) !== gen) return;
    this.dismissGuest(
      r,
      `无法连接主机（已重试 ${RECONNECT_BACKOFF_MS.length} 次），连接已断开；聊天记录已保留，可稍后重连`,
      { offline: true },
    );
  }

  private tryReconnectOnce(
    r: RoomRecord,
    host: string,
    port: number,
    password?: string,
    modChecksum?: string,
  ): Promise<boolean> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        // Task 12: one reconnect latency sample per attempt.
        this.metrics.record({
          type: "reconnect",
          ms: Date.now() - startedAt,
          ok: v,
        });
        resolve(v);
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://${host}:${port}`, { handshakeTimeout: 10_000 });
      } catch {
        done(false);
        return;
      }
      // Per-attempt budget 12s: 5 attempts + backoff stays in the same
      // magnitude as the old 3×30s, but the first retry lands ~1s after drop.
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        done(false);
      }, 12_000);

      ws.on("error", () => {
        /* wait for close */
      });
      ws.on("open", () => {
        void this.handshakeAsGuest(ws, {
          password: password ?? "",
          name: displayName(),
          hostFingerprint:
            r.joinInfo?.hostFingerprint || r.hostFingerprint || undefined,
          userId: r.localUserId || undefined,
        }).then((hs) => {
          if (settled) return;
          if (!hs.ok) {
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // ignore
            }
            done(false);
            return;
          }
          const conn = hs.conn;
          conn.onFrame((frame) => {
            if (settled) return;
            if (frame.type === "room.closed") {
              clearTimeout(timer);
              this.dismissGuest(
                r,
                (frame.payload as { message?: string })?.message ??
                  "群主已解散群聊",
              );
              try {
                ws.close();
              } catch {
                // ignore
              }
              done(false);
              return;
            }
            if (frame.type === "error") {
              clearTimeout(timer);
              try {
                ws.close();
              } catch {
                // ignore
              }
              done(false);
              return;
            }
            if (frame.type === "welcome" || frame.type === "state.snapshot") {
              clearTimeout(timer);
              const snap = frame.payload as RoomSnapshot;
              // Fresh handshake ⇒ new kid + session key; the new
              // RoomConnection restarts msg_id at 1. Old envelopes are never
              // replayed — frames missed while offline return via snapshot.
              r.client = ws;
              r.connections.clear();
              r.connections.set(ws, conn);
              r.encrypt = hs.encrypt;
              r.hostFingerprint = hs.hostFp;
              r.seq = frame.seq;
              this.applyGuestSnapshot(r, snap);
              this.bindGuestSocket(r, ws);
              done(true);
            }
          });
          try {
            conn.sendFrame(
              makeRoomFrame(r.roomId, 1, "join", {
                userId: r.localUserId || randomUUID(),
                name: displayName(),
                protocol: ROOM_PROTOCOL_VERSION,
                modChecksum: (modChecksum ?? "").trim(),
                projectPath: this.settings.get().lastProjectPath ?? null,
              }),
            );
          } catch {
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              // ignore
            }
            done(false);
          }
        }).catch(() => {
          if (settled) return;
          clearTimeout(timer);
          done(false);
        });
      });
      ws.on("close", () => {
        if (!settled) {
          clearTimeout(timer);
          done(false);
        }
      });
    });
  }

  leave(roomId: string) {
    const r = this.rooms.get(roomId);
    if (!r) return { ok: false, error: "群聊不存在" };
    // Host leave of a live room = dissolve. Ended/failed host rooms just
    // drop the local archive so they can get it off the list.
    if (r.localRole === "host") {
      if (r.status === "open" && r.server) {
        return this.end(roomId, { delete: true });
      }
      return this.deleteLocal(roomId);
    }
    this.cancelGuestReconnect(r);
    if (r.client && r.client.readyState === WebSocket.OPEN) {
      this.sendClient(r, "leave", { userId: r.localUserId });
    }
    return this.deleteLocal(roomId);
  }

  private cancelGuestReconnect(r: RoomRecord): void {
    r.closing = true;
    r.reconnecting = false;
    r.reconnectGen = (r.reconnectGen ?? 0) + 1;
  }

  /** Guest: host dismissed / reconnect exhausted — drop local copy and notify UI. */
  /** Rejoin a room the guest dropped from (or that ended): reuse joinInfo. */
  async rejoin(
    roomId: string,
  ): Promise<{ ok: boolean; room?: RoomSnapshot; error?: string }> {
    const old = this.rooms.get(roomId);
    if (!old) return { ok: false, error: "群聊不存在或已被删除" };
    if (old.localRole !== "member" || !old.joinInfo) {
      return { ok: false, error: "该群聊没有可重连的信息" };
    }
    if (old.status === "open" && old.client?.readyState === WebSocket.OPEN) {
      return { ok: true, room: this.snapshot(old) };
    }
    const info = old.joinInfo;
    const userId = old.localUserId || undefined;
    // Archive 保留；主机快照会把完整历史带回来
    this.rooms.delete(roomId);
    const res = await this.join({
      host: info.host,
      hosts: info.hosts,
      port: info.port,
      password: info.password,
      modChecksum: info.modChecksum,
      hostFingerprint: info.hostFingerprint,
      wss: info.wss,
      userId,
    });
    if (!res.ok) {
      // 重连失败：恢复旧记录，本地历史不丢
      this.rooms.set(roomId, old);
    }
    return res;
  }

  private dismissGuest(
    r: RoomRecord,
    message: string,
    opts?: { offline?: boolean },
  ): void {
    if (!this.rooms.has(r.roomId)) return;
    this.cancelGuestReconnect(r);
    // 断线不是解散：保持可重连。真正退出走 leave() → deleteLocal。
    if (!opts?.offline) r.status = "ended";
    this.disposeExecTurns(r);
    try {
      r.client?.close();
    } catch {
      // ignore
    }
    r.client = null;
    r.offline = opts?.offline ? true : undefined;
    // 不再删除房间与归档：聊天记录本地保留，可稍后重连
    this.persist(r);
    this.emit(r);
    this.safeSend(IPC.roomEvent, {
      roomId: r.roomId,
      closed: true,
      ...(r.offline ? { offline: true, silent: true } : {}),
      message,
    });
  }

  /** Ongoing guest socket after join / successful reconnect. */
  private bindGuestSocket(r: RoomRecord, ws: WebSocket): void {
    const handle = (frame: RoomFrame) => {
      if (r.closing || r.client !== ws) return;
      if (frame.type === "state.snapshot") {
        if (r.status !== "open") return;
        const snap = frame.payload as RoomSnapshot;
        r.seq = frame.seq;
        this.applyGuestSnapshot(r, snap);
        this.persist(r);
        this.emit(r);
        return;
      }
      if (frame.type === "mod.patch") {
        const p = frame.payload as { seq?: number; publicView?: unknown };
        r.modSeq = p.seq ?? r.modSeq;
        r.modPublicView = p.publicView;
        this.emit(r);
        return;
      }
      if (frame.type === "mod.priv") {
        const p = frame.payload as {
          seq?: number;
          seatId?: string;
          seatView?: unknown;
          actions?: unknown;
        };
        r.modSeq = p.seq ?? r.modSeq;
        if (p.seatId) {
          r.modSeatViews = { ...(r.modSeatViews ?? {}), [p.seatId]: p.seatView };
          if (p.actions !== undefined) {
            r.modActionsBySeat = {
              ...(r.modActionsBySeat ?? {}),
              [p.seatId]: toModActionMap(p.actions),
            };
          }
        }
        this.emit(r);
        return;
      }
      if (frame.type === "mod.fail") {
        r.modFail = (frame.payload as { message?: string })?.message ?? "mod fail";
        this.emit(r);
        return;
      }
      if (frame.type === "mod.offer") {
        r.modOffer = frame.payload as ModOfferPayload;
        this.emit(r);
        return;
      }
      if (frame.type === "room.closed") {
        this.dismissGuest(
          r,
          (frame.payload as { message?: string })?.message ?? "群主已解散群聊",
        );
        return;
      }
      if (frame.type === "kick") {
        // Host kicked us: drop locally, do not reconnect (fp is blacklisted).
        this.dismissGuest(
          r,
          (frame.payload as { message?: string })?.message ??
            "你已被群主移出群聊",
        );
        return;
      }
      if (frame.type === "exec.run") {
        this.onExecRun(r, frame.payload as RoomExecRunPayload);
        return;
      }
      if (frame.type === "exec.abort") {
        this.onExecAbort(r, frame.payload as RoomExecAbortPayload);
        return;
      }
      if (frame.type === "ai.http") {
        this.onAiHttp(r, r.hostUserId, frame.payload as RoomAiHttpPayload);
        return;
      }
      if (frame.type === "error") {
        this.safeSend(IPC.roomEvent, {
          roomId: r.roomId,
          error: true,
          message:
            (frame.payload as { message?: string })?.message ?? "操作失败",
        });
      }
    };
    const conn = r.connections.get(ws);
    if (conn) {
      conn.onFrame(handle);
    } else {
      // Fallback for sockets without a RoomConnection (should not happen
      // post-handshake; kept for safety).
      ws.on("message", (data) => {
        const frame = parseRoomFrame(
          typeof data === "string" ? data : data.toString("utf8"),
        );
        if (frame) handle(frame);
      });
    }
    ws.on("close", () => {
      if (r.client === ws) r.client = null;
      if (
        r.status === "open" &&
        r.localRole === "member" &&
        !r.closing
      ) {
        // 手动重连：断线立刻离线，由用户点「重连」，不再自动打。
        this.dismissGuest(r, "连接已断开，聊天记录已保留，可稍后重连", {
          offline: true,
        });
      }
    });
    // 对账上报：（重）连上后把本机还在跑的远程轮次告诉房主——
    // 房主若没有记录会回 exec.abort，双端收敛。
    if (r.nodeTurns?.size) {
      for (const nt of r.nodeTurns.values()) {
        this.sendClient(r, "exec.event", {
          turnId: nt.turnId,
          seatId: nt.seatId,
          phase: "running",
        } satisfies RoomExecEventPayload);
      }
    }
  }

  /**
   * Host ends the room. With delete:true (default on host leave), remove from
   * disk and notify guests with room.closed.
   */
  end(roomId: string, opts?: { delete?: boolean }) {
    const r = this.rooms.get(roomId);
    if (!r) return { ok: false, error: "群聊不存在" };
    if (r.localRole !== "host") {
      return { ok: false, error: "只有群主可以结束群聊" };
    }
    const shouldDelete = opts?.delete !== false;
    r.status = "ended";
    this.append(r, {
      kind: "system",
      text: shouldDelete ? "群主已解散群聊" : "群聊已结束",
      authorLabel: "系统",
    });
    this.broadcast(r, "room.closed", {
      message: shouldDelete ? "群主已解散群聊" : "群聊已结束",
    });
    for (const g of r.guests) {
      try {
        g.close();
      } catch {
        // ignore
      }
    }
    r.guests.clear();
    this.denyAllPending(r);
    this.disposeModHost(r);
    this.disposeKernel(r, shouldDelete);
    this.disposeExecTurns(r);
    try {
      r.tunnel?.kill();
    } catch {
      // ignore
    }
    r.tunnel = undefined;
    try {
      r.relay?.kill();
    } catch {
      // ignore
    }
    r.relay = undefined;
    try {
      r.server?.close();
    } catch {
      // ignore
    }
    r.server = null;

    if (shouldDelete) {
      this.archive?.removeRoom(roomId);
      this.rooms.delete(roomId);
      this.safeSend(IPC.roomEvent, {
        roomId,
        closed: true,
        silent: true,
        message: "群聊已解散",
      });
    } else {
      this.persist(r);
      this.emit(r);
    }
    return { ok: true };
  }

  /** Remove a room from local list / disk (member cleanup after host left). */
  deleteLocal(roomId: string) {
    const r = this.rooms.get(roomId);
    if (r?.localRole === "host" && r.status === "open" && r.server) {
      return this.end(roomId, { delete: true });
    }
    if (r) this.cancelGuestReconnect(r);
    try {
      r?.client?.close();
    } catch {
      // ignore
    }
    if (r) this.disposeKernel(r, true);
    this.rooms.delete(roomId);
    this.archive?.removeRoom(roomId);
    return { ok: true };
  }

  addSeat(
    roomId: string,
    kind: RoomSeatKind,
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
  ) {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") {
      return { ok: false, error: "群聊不可用" };
    }
    if (r.localRole !== "host") {
      // Member asks host to add their own seat
      this.sendClient(r, "seat.add", {
        kind,
        name: name.trim(),
        agentName: agentName ?? name.trim(),
        userId: r.localUserId,
        ...(kind === "agent" && extra?.agentPrompt?.trim()
          ? { agentPrompt: extra.agentPrompt.trim() }
          : {}),
        ...(kind === "agent" && extra?.skillNames?.length
          ? { skillNames: extra.skillNames }
          : {}),
        ...(kind === "agent" && extra?.model?.trim()
          ? { model: extra.model.trim() }
          : {}),
        ...(kind === "agent"
          ? {
              executorUserId:
                extra?.workspaceUserId ?? extra?.executorUserId ?? r.localUserId,
              workspaceUserId:
                extra?.workspaceUserId ?? extra?.executorUserId ?? r.localUserId,
              aiUserId:
                extra?.aiUserId ??
                extra?.workspaceUserId ??
                extra?.executorUserId ??
                r.localUserId,
            }
          : {}),
      });
      return { ok: true };
    }
    const label = name.trim() || (kind === "agent" ? "Agent" : displayName());
    const seat: RoomSeat = {
      id: randomUUID(),
      kind,
      name: label,
      occupantUserId: kind === "human" ? r.localUserId : null,
      takenOverBy: null,
      sessionId: null,
      running: false,
      agentName: kind === "agent" ? (agentName ?? label) : null,
      ...(kind === "agent" && extra?.agentPrompt?.trim()
        ? { agentPrompt: extra.agentPrompt.trim() }
        : {}),
      ...(kind === "agent" && extra?.skillNames?.length
        ? { skillNames: extra.skillNames }
        : {}),
      ...(kind === "agent" && extra?.model?.trim()
        ? { model: extra.model.trim() }
        : {}),
    };
    if (kind === "agent") {
      this.applySeatAxes(r, seat, extra, r.localUserId);
    }
    r.seats.push(seat);
    this.append(r, {
      kind: "system",
      text: `新席位：${label}`,
      authorLabel: "系统",
    });
    this.pushState(r);
    return { ok: true, room: this.snapshot(r) };
  }

  updateSeat(
    roomId: string,
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
  ) {
    const rec0 = this.rooms.get(roomId);
    if (!rec0 || rec0.status !== "open") {
      return { ok: false, error: "群聊不可用" };
    }
    if (rec0.localRole !== "host") {
      if (!canManageSeats(this.memberRole(rec0, rec0.localUserId))) {
        return { ok: false, error: "没有权限改席位" };
      }
      this.sendClient(rec0, "seat.update", {
        seatId,
        ...patch,
      } satisfies RoomSeatUpdatePayload);
      return { ok: true };
    }
    if (!canManageSeats(this.memberRole(rec0, rec0.localUserId))) {
      return { ok: false, error: "没有权限改席位" };
    }
    const rec = rec0;
    const seat = rec.seats.find((s) => s.id === seatId);
    if (!seat) return { ok: false, error: "席位不存在" };
    if (seat.kind !== "agent") {
      return { ok: false, error: "只能改 Agent 席位的设定" };
    }
    if (typeof patch.name === "string" && patch.name.trim()) {
      seat.name = patch.name.trim();
    }
    if (patch.agentName !== undefined) {
      seat.agentName = patch.agentName.trim() || seat.name;
    }
    if (patch.agentPrompt !== undefined) {
      const p = patch.agentPrompt.trim();
      if (p) seat.agentPrompt = p;
      else delete seat.agentPrompt;
    }
    if (patch.skillNames !== undefined) {
      if (patch.skillNames.length) seat.skillNames = patch.skillNames;
      else delete seat.skillNames;
    }
    if (patch.model !== undefined) {
      const m = patch.model.trim();
      if (m) seat.model = m;
      else delete seat.model;
    }
    if (
      patch.executorUserId !== undefined ||
      patch.workspaceUserId !== undefined ||
      patch.aiUserId !== undefined
    ) {
      this.applySeatAxes(
        rec,
        seat,
        {
          executorUserId: patch.executorUserId,
          workspaceUserId: patch.workspaceUserId ?? patch.executorUserId,
          aiUserId: patch.aiUserId,
        },
        resolveWorkspaceUserId(seat, rec.hostUserId),
      );
    }
    this.pushState(rec);
    return { ok: true, room: this.snapshot(rec) };
  }

  /** Host-side: add a seat for a member (from seat.add frame). */
  private addSeatForMember(
    r: RoomRecord,
    userId: string,
    kind: RoomSeatKind,
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
  ) {
    const member = r.members.find((m) => m.userId === userId);
    if (!member) return;
    const label = name.trim() || (kind === "agent" ? "Agent" : member.name);
    const seat: RoomSeat = {
      id: randomUUID(),
      kind,
      name: label,
      occupantUserId: kind === "human" ? userId : null,
      takenOverBy: null,
      sessionId: null,
      running: false,
      agentName: kind === "agent" ? (agentName ?? label) : null,
      ...(kind === "agent" && extra?.agentPrompt?.trim()
        ? { agentPrompt: extra.agentPrompt.trim() }
        : {}),
      ...(kind === "agent" && extra?.skillNames?.length
        ? { skillNames: extra.skillNames.slice(0, 32).map((s) => String(s)) }
        : {}),
      ...(kind === "agent" && extra?.model?.trim()
        ? { model: extra.model.trim() }
        : {}),
    };
    if (kind === "agent") {
      this.applySeatAxes(r, seat, extra, userId);
    }
    r.seats.push(seat);
    this.append(r, {
      kind: "system",
      text: `${member.name} 加了席位「${label}」`,
      authorLabel: "系统",
    });
    this.pushState(r);
  }

  /** Roll a die (1-6). */
  rollDice(roomId: string, seatId: string) {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    const seat = r.seats.find((s) => s.id === seatId);
    if (!seat) return { ok: false, error: "请先选一个席位" };
    const value = String(Math.floor(Math.random() * 6) + 1);
    const faces = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
    const face = faces[Number(value) - 1] ?? value;
    if (r.localRole !== "host") {
      this.sendClient(r, "game.dice", { seatId, userId: r.localUserId, value });
      return { ok: true };
    }
    this.append(r, {
      kind: "game",
      seatId,
      authorUserId: r.localUserId,
      authorLabel: this.memberName(r, r.localUserId),
      text: `${face} 掷出 ${value} 点`,
      game: { type: "dice", value: face },
    });
    this.pushState(r);
    return { ok: true };
  }

  /** Rock-paper-scissors. */
  playRps(roomId: string, seatId: string, hand: "rock" | "scissors" | "paper") {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    const seat = r.seats.find((s) => s.id === seatId);
    if (!seat) return { ok: false, error: "请先选一个席位" };
    const label =
      hand === "rock" ? "✊ 石头" : hand === "scissors" ? "✌️ 剪刀" : "✋ 布";
    if (r.localRole !== "host") {
      this.sendClient(r, "game.rps", { seatId, userId: r.localUserId, hand });
      return { ok: true };
    }
    this.append(r, {
      kind: "game",
      seatId,
      authorUserId: r.localUserId,
      authorLabel: this.memberName(r, r.localUserId),
      text: `出 ${label}`,
      game: { type: "rps", value: label },
    });
    this.pushState(r);
    return { ok: true };
  }

  takeover(roomId: string, seatId: string) {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    const seat = r.seats.find((s) => s.id === seatId);
    if (!seat) return { ok: false, error: "席位不存在" };
    if (seat.kind !== "agent") return { ok: false, error: "只能接管 Agent 席位" };
    if (r.localRole === "host") {
      seat.takenOverBy = r.localUserId;
      this.abortRemoteTurnsForSeat(r, seat.id, "席位被接管");
      if (seat.sessionId) {
        try {
          this.sessions.abort(seat.sessionId);
        } catch {
          // ignore
        }
        seat.running = false;
      }
      this.append(r, {
        kind: "system",
        seatId,
        text: `${this.memberName(r, r.localUserId)} 接管了「${seat.name}」`,
        authorLabel: "系统",
      });
      this.pushState(r);
      return { ok: true };
    }
    this.sendClient(r, "seat.takeover", { seatId, userId: r.localUserId });
    return { ok: true };
  }

  returnSeat(roomId: string, seatId: string) {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    const seat = r.seats.find((s) => s.id === seatId);
    if (!seat) return { ok: false, error: "席位不存在" };
    if (r.localRole === "host") {
      seat.takenOverBy = null;
      this.append(r, {
        kind: "system",
        seatId,
        text: `「${seat.name}」已交还 Agent`,
        authorLabel: "系统",
      });
      this.pushState(r);
      return { ok: true };
    }
    this.sendClient(r, "seat.return", { seatId, userId: r.localUserId });
    return { ok: true };
  }

  enableKernelMod(
    roomId: string,
    packDir: string,
  ): { ok: boolean; room?: RoomSnapshot; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.localRole !== "host") return { ok: false, error: "只有群主可以启用扩展" };
    if (peekHostApi(packDir) === 1) {
      return { ok: false, error: "这是玩法模组，请用玩法入口启用" };
    }
    try {
      const loaded = this.overlayLiveKernel(r, loadKernelDir(packDir));
      try {
        writeKernelCache(this.pathEnv(), loaded);
      } catch {
        // cache is optional
      }
      kernelLog("load", {
        roomId,
        id: loaded.manifest.id,
        version: loaded.manifest.version,
        checksum: loaded.checksum,
      });
      const pack = toKernelActivatePack(loaded);
      r.kernelLoaded = (r.kernelLoaded ?? []).filter((p) => p.manifest.id !== loaded.manifest.id);
      r.kernelLoaded.push(loaded);
      r.kernelPacks = (r.kernelPacks ?? []).filter((p) => p.manifest.id !== pack.manifest.id);
      r.kernelPacks.push(pack);
      const started = this.startKernel(roomId, r.kernelPacks);
      if (!started.ok) return started;
      this.syncKernelExtras(r);
      this.emit(r);
      return { ok: true, room: this.snapshot(r) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  listKernelMemory(
    roomId: string,
  ): { ok: boolean; entries?: Array<{ key: string; value: string }>; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.localRole !== "host") return { ok: false, error: "只有群主可以查看共享记忆" };
    if (!this.hasMemoryProvide(r) || !r.kernelStore) {
      return { ok: true, entries: [] };
    }
    return { ok: true, entries: r.kernelStore.listEntries("memory") };
  }

  setKernelMemory(
    roomId: string,
    key: string,
    value: string,
  ): { ok: boolean; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.localRole !== "host") return { ok: false, error: "只有群主可以改共享记忆" };
    if (!this.hasMemoryProvide(r) || !r.kernelStore) {
      return { ok: false, error: "未启用共享记忆" };
    }
    const result = r.kernelStore.namespace("memory").set(key.trim(), value);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  deleteKernelMemory(
    roomId: string,
    key: string,
  ): { ok: boolean; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.localRole !== "host") return { ok: false, error: "只有群主可以改共享记忆" };
    if (!this.hasMemoryProvide(r) || !r.kernelStore) {
      return { ok: false, error: "未启用共享记忆" };
    }
    const result = r.kernelStore.remove("memory", key);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  disableKernelMod(
    roomId: string,
    id: string,
  ): { ok: boolean; room?: RoomSnapshot; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.localRole !== "host") return { ok: false, error: "只有群主可以卸载扩展" };
    const packs = (r.kernelPacks ?? []).filter((p) => p.manifest.id !== id);
    if (packs.length === (r.kernelPacks ?? []).length) {
      return { ok: false, error: "未找到该扩展" };
    }
    r.kernelLoaded = (r.kernelLoaded ?? []).filter((p) => p.manifest.id !== id);
    r.kernelPacks = packs;
    if (!packs.length) {
      this.disposeKernel(r, false);
      this.emit(r);
      return { ok: true, room: this.snapshot(r) };
    }
    const started = this.startKernel(roomId, packs);
    if (!started.ok) return started;
    this.syncKernelExtras(r);
    this.emit(r);
    return { ok: true, room: this.snapshot(r) };
  }

  setKernelAutonomy(
    roomId: string,
    level: KernelAutonomy,
  ): { ok: boolean; error?: string } {
    const r = this.hostKernelRoom(roomId);
    if (!r.ok) return r;
    r.store.setAutonomy(level);
    kernelLog("improve.autonomy", { roomId, level });
    return { ok: true };
  }

  getKernelImprove(roomId: string): {
    ok: boolean;
    autonomy?: KernelAutonomy;
    proposals?: ReturnType<KernelImproveStore["snapshot"]>["proposals"];
    canRollback?: string[];
    error?: string;
  } {
    const r = this.hostKernelRoom(roomId);
    if (!r.ok) return r;
    const snap = r.store.snapshot();
    const packs = new Set((r.room.kernelLoaded ?? []).map((p) => p.manifest.id));
    return {
      ok: true,
      autonomy: snap.autonomy,
      proposals: snap.proposals,
      canRollback: [...new Set(snap.revisions.map((x) => x.packId))].filter((id) =>
        packs.has(id),
      ),
    };
  }

  proposeKernelImprove(
    roomId: string,
    packId: string,
    modJs: string,
    note?: string,
  ): { ok: boolean; decision?: string; status?: string; error?: string } {
    const r = this.hostKernelRoom(roomId);
    if (!r.ok) return r;
    const loaded = r.room.kernelLoaded?.find((p) => p.manifest.id === packId);
    if (!loaded) return { ok: false, error: "未启用该扩展" };
    const trial = trialKernelSource(loaded.manifest, modJs, r.room.kernelStore);
    const current =
      r.room.kernel?.snapshot().active.find((p) => p.id === packId)?.provides ??
      loaded.manifest.provides;
    const decision = decideImproveApply({
      autonomy: r.store.autonomy,
      trialOk: trial.ok,
      currentProvides: current,
      nextProvides: trial.ok ? trial.provides : [],
    });
    if (decision === "reject") {
      r.store.addProposal({
        packId,
        modJs,
        note,
        status: "failed",
        decision,
        error: trial.ok ? undefined : trial.error,
      });
      this.auditImprove(r.room, `扩展 ${packId} 提案未通过试用${trial.ok ? "" : `：${trial.error}`}`);
      return { ok: false, decision, error: trial.ok ? "提案被拒绝" : trial.error };
    }
    const prop = r.store.addProposal({
      packId,
      modJs,
      note,
      status: decision === "apply" ? "applied" : "pending",
      decision,
    });
    if (decision === "apply") {
      const applied = this.applyKernelSource(r.room, loaded, modJs, note ?? "auto");
      if (!applied.ok) {
        r.store.updateProposal(prop.id, { status: "failed", error: applied.error });
        return applied;
      }
      this.auditImprove(r.room, `扩展 ${packId} 已自动应用新实现（L${r.store.autonomy}）`);
    } else {
      this.auditImprove(r.room, `扩展 ${packId} 提案待审批（L0/L1 行为有变）`);
    }
    this.emit(r.room);
    return { ok: true, decision, status: prop.status };
  }

  applyKernelProposal(
    roomId: string,
    proposalId: string,
  ): { ok: boolean; error?: string } {
    const r = this.hostKernelRoom(roomId);
    if (!r.ok) return r;
    const prop = r.store.proposals.find((p) => p.id === proposalId);
    if (!prop || prop.status !== "pending") return { ok: false, error: "没有待批提案" };
    const loaded = r.room.kernelLoaded?.find((p) => p.manifest.id === prop.packId);
    if (!loaded) return { ok: false, error: "未启用该扩展" };
    const trial = trialKernelSource(loaded.manifest, prop.modJs, r.room.kernelStore);
    if (!trial.ok) {
      r.store.updateProposal(prop.id, { status: "failed", error: trial.error });
      return { ok: false, error: trial.error };
    }
    const applied = this.applyKernelSource(r.room, loaded, prop.modJs, prop.note ?? "apply");
    if (!applied.ok) return applied;
    r.store.updateProposal(prop.id, { status: "applied" });
    this.auditImprove(r.room, `群主批准扩展 ${prop.packId} 的提案`);
    this.emit(r.room);
    return { ok: true };
  }

  rejectKernelProposal(
    roomId: string,
    proposalId: string,
  ): { ok: boolean; error?: string } {
    const r = this.hostKernelRoom(roomId);
    if (!r.ok) return r;
    const cur = r.store.proposals.find((p) => p.id === proposalId);
    if (!cur || cur.status !== "pending") return { ok: false, error: "没有待批提案" };
    const prop = r.store.updateProposal(proposalId, { status: "rejected" });
    if (!prop) return { ok: false, error: "提案不存在" };
    this.auditImprove(r.room, `群主拒绝扩展 ${prop.packId} 的提案`);
    return { ok: true };
  }

  rollbackKernelImprove(
    roomId: string,
    packId: string,
  ): { ok: boolean; error?: string } {
    const r = this.hostKernelRoom(roomId);
    if (!r.ok) return r;
    const rev = r.store.lastRevision(packId);
    if (!rev) return { ok: false, error: "没有可回滚版本" };
    const loaded = r.room.kernelLoaded?.find((p) => p.manifest.id === packId);
    if (!loaded) return { ok: false, error: "未启用该扩展" };
    const applied = this.applyKernelSource(r.room, loaded, rev.modJs, "rollback", {
      recordRevision: false,
    });
    if (!applied.ok) return applied;
    this.auditImprove(r.room, `扩展 ${packId} 已回滚到上一版`);
    this.emit(r.room);
    return { ok: true };
  }

  private overlayLiveKernel(r: RoomRecord, loaded: LoadedKernelMod): LoadedKernelMod {
    const gate = this.hostKernelRoom(r.roomId);
    if (!gate.ok) return loaded;
    const live = gate.store.liveSource(loaded.manifest.id);
    if (!live || live === loaded.modJsSource) return loaded;
    const trial = trialKernelSource(loaded.manifest, live, r.kernelStore);
    if (!trial.ok) {
      kernelLog("improve.live.skip", {
        roomId: r.roomId,
        id: loaded.manifest.id,
        error: trial.error,
      });
      return loaded;
    }
    return {
      ...loaded,
      modJsSource: live,
      checksum: hashModFiles(loaded.manifestSource, live),
    };
  }

  private hostKernelRoom(
    roomId: string,
  ): { ok: true; room: RoomRecord; store: KernelImproveStore } | { ok: false; error: string } {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== "open") return { ok: false, error: "群聊不可用" };
    if (room.localRole !== "host") return { ok: false, error: "只有群主可以管理扩展改善" };
    if (!room.kernelImprove) {
      room.kernelImprove = new KernelImproveStore(getKernelImprovePath(this.pathEnv(), roomId));
    }
    return { ok: true, room, store: room.kernelImprove };
  }

  private applyKernelSource(
    r: RoomRecord,
    loaded: LoadedKernelMod,
    modJs: string,
    note: string,
    opts?: { recordRevision?: boolean },
  ): { ok: boolean; error?: string } {
    if (opts?.recordRevision !== false && r.kernelImprove) {
      r.kernelImprove.pushRevision({
        packId: loaded.manifest.id,
        checksum: loaded.checksum,
        manifestSource: loaded.manifestSource,
        modJs: loaded.modJsSource,
        at: Date.now(),
      });
    }
    const next: LoadedKernelMod = {
      ...loaded,
      modJsSource: modJs,
      checksum: hashModFiles(loaded.manifestSource, modJs),
    };
    try {
      writeKernelCache(this.pathEnv(), next);
    } catch {
      // cache optional
    }
    r.kernelLoaded = (r.kernelLoaded ?? []).map((p) =>
      p.manifest.id === next.manifest.id ? next : p,
    );
    r.kernelPacks = (r.kernelLoaded ?? []).map(toKernelActivatePack);
    r.kernelImprove?.setLive(next.manifest.id, next.modJsSource);
    const started = this.startKernel(r.roomId, r.kernelPacks);
    if (!started.ok) return started;
    this.syncKernelExtras(r);
    kernelLog("improve.apply", { roomId: r.roomId, id: next.manifest.id, note });
    return { ok: true };
  }

  private auditImprove(r: RoomRecord, text: string): void {
    this.append(r, {
      kind: "system",
      source: "kernel",
      text,
      authorLabel: "系统",
    });
    this.pushState(r);
  }

  startKernel(
    roomId: string,
    packs: KernelActivatePack[],
  ): { ok: boolean; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.localRole !== "host") return { ok: false, error: "只有群主可以启用扩展" };
    if (!r.kernelStore) {
      r.kernelStore = new HostRoomKv(getKernelStorePath(this.pathEnv(), r.roomId));
    }
    if (r.kernel) void r.kernel.dispose();
    r.kernel = new ModKernel(r.kernelStore);
    r.kernel.start(packs, {
      id: r.roomId,
      seats: r.seats.map((s) => ({ id: s.id, kind: s.kind, name: s.name })),
    });
    this.bindKernelSchedule(r);
    return { ok: true };
  }

  async tickKernelSchedule(
    roomId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.localRole !== "host") return { ok: false, error: "只有群主可以触发调度" };
    await this.runKernelScheduleJobs(r);
    return { ok: true };
  }

  async send(
    roomId: string,
    seatId: string,
    text: string,
    quote?: RoomQuoteRef,
    attachments?: Attachment[],
  ) {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    const trimmed = text.trim();
    const atts = attachments?.length ? attachments : undefined;
    if (!trimmed && !atts) return { ok: false, error: "消息为空" };
    // 附件在消息文本里落一份 [Attached: 名字]，所有成员（含远端节点）都能看到；
    // 文件内容只在席位跑在本机时穿进 Agent prompt（路径在别的机器上没意义）。
    const body = atts
      ? `${trimmed ? `${trimmed}\n\n` : ""}[Attached: ${atts.map((a) => a.name).join(", ")}]`
      : trimmed;
    const seat = r.seats.find((s) => s.id === seatId);
    if (!seat) return { ok: false, error: "请先选一个席位" };

    if (r.localRole !== "host") {
      if (!r.client || r.client.readyState !== WebSocket.OPEN) {
        return { ok: false, error: "尚未连上主机，请等重连完成后再发" };
      }
      const canTalk =
        (seat.kind === "human" && seat.occupantUserId === r.localUserId) ||
        (seat.kind === "agent" &&
          (seat.takenOverBy === r.localUserId || !seat.takenOverBy));
      if (!canTalk) {
        return {
          ok: false,
          error: "当前不能在这个席位发言（选自己的人席，或先接管 Agent）",
        };
      }
      this.sendClient(r, "chat.user", {
        seatId,
        userId: r.localUserId,
        text: body,
        ...(quote ? { quote } : {}),
      });
      return { ok: true };
    }

    const canTalk =
      (seat.kind === "human" && seat.occupantUserId === r.localUserId) ||
      (seat.kind === "agent" && seat.takenOverBy === r.localUserId);
    if (!canTalk && seat.kind === "agent" && !seat.takenOverBy) {
      void this.enqueueInbound(r, () =>
        this.ingestUserChat(
          r,
          {
            roomId: r.roomId,
            seatId,
            authorUserId: r.localUserId,
            authorLabel: this.memberName(r, r.localUserId),
            text: body,
            at: Date.now(),
            ...(quote ? { quote } : {}),
          },
          { runAgent: true, attachments: atts },
        ),
      );
      return { ok: true };
    }
    if (!canTalk) {
      return { ok: false, error: "当前不能在这个席位发言（先接管或选自己的人席）" };
    }

    void this.enqueueInbound(r, () =>
      this.ingestUserChat(
        r,
        {
          roomId: r.roomId,
          seatId,
          authorUserId: r.localUserId,
          authorLabel: this.memberName(r, r.localUserId),
          text: body,
          at: Date.now(),
          ...(quote ? { quote } : {}),
        },
        { runAgent: false },
      ),
    );
    return { ok: true };
  }

  disposeAll(): void {
    for (const r of this.rooms.values()) {
      this.cancelGuestReconnect(r);
      this.disposeModHost(r);
      this.disposeKernel(r, false);
      this.disposeExecTurns(r);
      this.denyAllPending(r);
      try {
        r.tunnel?.kill();
      } catch {
        // ignore
      }
      r.tunnel = undefined;
      try {
        r.relay?.kill();
      } catch {
        // ignore
      }
      r.relay = undefined;
      for (const conn of r.connections.values()) {
        try {
          conn.close();
        } catch {
          // ignore
        }
      }
      r.connections.clear();
      try {
        r.client?.close();
        r.server?.close();
      } catch {
        // ignore
      }
    }
    this.rooms.clear();
  }

  private agentSeatPrefix(seat: RoomSeat): string {
    const lines = [`【你是群聊席位「${seat.name}」】`];
    if (seat.agentName) lines.push(`人设：${seat.agentName}`);
    if (seat.agentPrompt?.trim()) lines.push(seat.agentPrompt.trim());
    if (seat.skillNames?.length) {
      lines.push(
        `请优先使用这些 skills：${seat.skillNames.join("、")}。不要主动使用未列出的 skill。`,
      );
    }
    return lines.join("\n");
  }

  /**
   * 路径守卫提示：群聊驱动的会话一律被 hook 圈在 cwd 内，这里先把规则讲清楚，
   * 免得 AI 撞墙后换招绕过（skill 里有完整规则，首条提示点名它）。
   */
  private pathGuardPrefix(cwd: string): string {
    return [
      `路径守卫：你只能读写 ${cwd} 之内的文件；Bash 命令也不允许访问该目录之外的路径（越界会被直接拒绝，被拒绝后不要换工具或拼路径绕过）。`,
      `完整规则见 skill「${BUILTIN_PATH_GUARD_SKILL}」，首轮请先阅读它。`,
    ].join("\n");
  }

  private async runAgentSeat(
    r: RoomRecord,
    seat: RoomSeat,
    text: string,
    requesterUserId?: string | null,
    attachments?: Attachment[],
  ) {
    // 远程执行：席位绑定了其他成员的机器 → 派发过去，不在房主本机跑。
    // 附件是本机路径，远端读不到，只随文本带 [Attached: 名字]。
    if (this.refuseDeniedWorkspace(r, seat, requesterUserId ?? null)) return;
    if (this.seatExecutor(r, seat)) {
      this.dispatchRemoteTurn(r, seat, text, requesterUserId ?? null);
      return;
    }
    const cwd = this.settings.get().lastProjectPath;
    if (!cwd) {
      this.append(r, {
        kind: "system",
        seatId: seat.id,
        text: "群主尚未打开项目，Agent 无法执行",
        authorLabel: "系统",
      });
      this.pushState(r);
      return;
    }
    // 文件策略 ask：别人要在本机项目上跑任务 → 先弹窗问本机用户。
    if (this.needsLocalTurnAsk(r, seat, requesterUserId)) {
      const allowed = await this.askLocalTurnApproval(
        r,
        seat,
        requesterUserId,
        text,
      );
      if (!allowed) {
        this.refuseUnapprovedTurn(r, seat, requesterUserId, "被本机用户拒绝或超时");
        return;
      }
    }
    seat.running = true;
    this.pushState(r);
    const borrowing =
      resolveAiUserId(seat, r.hostUserId) !== r.localUserId;
    const em = borrowing
      ? { model: seat.model }
      : this.effectiveSeatModel(seat);
    if (em.fallbackFrom) {
      this.append(r, {
        kind: "tool",
        seatId: seat.id,
        text: `席位模型「${em.fallbackFrom}」在本机网关未配置，已改用本机默认模型`,
        authorLabel: "系统",
      });
      this.pushState(r);
    }
    const prompt = {
      text: !seat.sessionId
        ? `${this.agentSeatPrefix(seat)}\n${this.pathGuardPrefix(cwd)}\n${text}`
        : text,
      attachments: attachments ?? [],
    };
    const extras: SessionRunOpts = {
      ...this.seatToolOpts(r, seat),
      replaceExtras: true,
      // 席位会话不出现在左侧会话列表（不占“对话格子”），diff 事件照发。
      hiddenFromList: true,
      // 群聊驱动的 AI 圈死在工作区内：文件工具越界直接拒（不管谁发起的）。
      pathJail: cwd,
      ...(em.model ? { model: em.model } : {}),
      ...(this.turnPermissionMode(r, seat, requesterUserId)
        ? { permissionMode: this.turnPermissionMode(r, seat, requesterUserId) }
        : {}),
      // start 一建条目就拿到 id：流式（文本/思考）进 liveExec 快照靠它匹配。
      onSessionId: (id: string) => {
        seat.sessionId = id;
      },
    };
    try {
      Object.assign(extras, await this.borrowAiExtras(r, seat));
      if (!seat.sessionId) {
        const id = await this.sessions.start(prompt, cwd, extras);
        seat.sessionId = id;
      } else {
        await this.sessions.continue(seat.sessionId, prompt, extras);
      }
      const items = this.sessions.getTranscript(seat.sessionId);
      const last = [...items]
        .reverse()
        .find((i) => i.kind === "text" && i.role === "assistant");
      const reply =
        last && last.kind === "text" ? last.text.trim() : "";
      if (reply) {
        this.append(r, {
          kind: "assistant",
          seatId: seat.id,
          authorLabel: seat.name,
          text: reply,
        });
      }
    } catch (err) {
      this.append(r, {
        kind: "system",
        seatId: seat.id,
        text: err instanceof Error ? err.message : String(err),
        authorLabel: "系统",
      });
    } finally {
      seat.running = false;
      // 清掉本机席位的流式气泡（远端席位由 settleRemoteTurn 清）。
      r.liveExec?.delete(`local-${seat.id}`);
      // 每轮结束刷新席位上下文占用（快照广播给全房间）；超阈值就地压缩。
      const cu = this.seatContextUsage(seat.sessionId);
      if (cu !== undefined) seat.contextUsage = cu;
      if (await this.maybeCompactSeatSession(seat.sessionId, cu)) {
        seat.contextUsage = null;
        this.append(r, {
          kind: "system",
          seatId: seat.id,
          text: `席位「${seat.name}」上下文占用 ${Math.round((cu?.ratio ?? 0) * 100)}%，已自动压缩历史`,
          authorLabel: "系统",
        });
      }
      this.pushState(r);
    }
  }

  /* ── 远程执行（docs/room-remote-exec-design.md §4/§5） ─────────────── */

  /** 席位该去哪台机器跑：null = 本机（房主循环或节点自己）。 */
  private seatExecutor(r: RoomRecord, seat: RoomSeat): string | null {
    const e = resolveWorkspaceUserId(seat, r.hostUserId);
    if (!e || e === r.localUserId) return null;
    return e;
  }

  private memberRole(r: RoomRecord, userId: string): RoomRole {
    return r.members.find((m) => m.userId === userId)?.role ?? "member";
  }

  private localModelsList(): string[] {
    const st = this.settings.get();
    if (Array.isArray(st.models) && st.models.length) return [...st.models];
    return st.defaultModel ? [st.defaultModel] : [];
  }

  private applySeatAxes(
    r: RoomRecord,
    seat: RoomSeat,
    extra?: {
      aiUserId?: string;
      workspaceUserId?: string;
      executorUserId?: string;
    },
    fallbackUserId?: string,
  ): void {
    const fallback = fallbackUserId || r.localUserId;
    const wsRaw = extra?.workspaceUserId || extra?.executorUserId;
    const ws =
      wsRaw && r.members.some((m) => m.userId === wsRaw) ? wsRaw : fallback;
    seat.workspaceUserId = ws;
    seat.executorUserId = ws;
    const aiRaw = extra?.aiUserId;
    const ai =
      aiRaw && r.members.some((m) => m.userId === aiRaw) ? aiRaw : ws;
    seat.aiUserId = ai;
    if (ai !== fallback && ai !== r.localUserId) {
      const owner = r.members.find((m) => m.userId === ai);
      if (owner && (owner.aiShare === "off" || !owner.aiShare)) {
        owner.aiShare = "pending";
        owner.aiAskBy = r.localUserId;
      }
    }
  }

  setMemberRole(
    roomId: string,
    userId: string,
    role: "admin" | "member",
  ): { ok: boolean; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.localRole !== "host") {
      return { ok: false, error: "只有群主可以设置管理员" };
    }
    if (!canSetMemberRole(this.memberRole(r, r.localUserId))) {
      return { ok: false, error: "只有群主可以设置管理员" };
    }
    if (userId === r.hostUserId) return { ok: false, error: "不能改群主角色" };
    const m = r.members.find((mm) => mm.userId === userId);
    if (!m) return { ok: false, error: "成员不在房间" };
    m.role = role;
    this.append(r, {
      kind: "system",
      text:
        role === "admin"
          ? `${m.name} 被设为管理员`
          : `${m.name} 被取消管理员`,
      authorLabel: "系统",
    });
    this.pushState(r);
    return { ok: true };
  }

  setFilePolicy(
    roomId: string,
    policy: RoomFilePolicy,
  ): { ok: boolean; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (policy !== "allow" && policy !== "ask" && policy !== "deny") {
      return { ok: false, error: "无效的操作策略" };
    }
    if (r.localRole !== "host") {
      this.sendClient(r, "file.policy", {
        policy,
      } satisfies RoomFilePolicyPayload);
      return { ok: true };
    }
    const m = r.members.find((mm) => mm.userId === r.localUserId);
    if (!m) return { ok: false, error: "成员不存在" };
    m.filePolicy = policy;
    this.pushState(r);
    return { ok: true };
  }

  setAiShare(
    roomId: string,
    on: boolean,
  ): { ok: boolean; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    const models = on ? this.localModelsList() : [];
    if (r.localRole !== "host") {
      this.sendClient(r, "ai.share", {
        on,
        ...(models.length ? { models } : {}),
      } satisfies RoomAiSharePayload);
      return { ok: true };
    }
    this.applyAiShare(r, r.localUserId, on, models);
    this.pushState(r);
    return { ok: true };
  }

  askAiShare(
    roomId: string,
    targetUserId: string,
    seatId?: string,
  ): { ok: boolean; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (!canManageSeats(this.memberRole(r, r.localUserId))) {
      return { ok: false, error: "没有权限请求借用 AI" };
    }
    if (r.localRole !== "host") {
      this.sendClient(r, "ai.ask", {
        targetUserId,
        fromUserId: r.localUserId,
        ...(seatId ? { seatId } : {}),
      } satisfies RoomAiAskPayload);
      return { ok: true };
    }
    return this.applyAiAsk(r, r.localUserId, targetUserId);
  }

  private applyAiAsk(
    r: RoomRecord,
    fromUserId: string,
    targetUserId: string,
  ): { ok: boolean; error?: string } {
    if (targetUserId === fromUserId) return { ok: true };
    const target = r.members.find((m) => m.userId === targetUserId);
    if (!target) return { ok: false, error: "对方不在房间" };
    if (target.aiShare === "on") return { ok: true };
    target.aiShare = "pending";
    target.aiAskBy = fromUserId;
    this.append(r, {
      kind: "system",
      text: `${this.memberName(r, fromUserId)} 想借用「${target.name}」的 AI`,
      authorLabel: "系统",
    });
    this.pushState(r);
    return { ok: true };
  }

  private applyAiShare(
    r: RoomRecord,
    userId: string,
    on: boolean,
    models?: string[],
  ): void {
    const m = r.members.find((mm) => mm.userId === userId);
    if (!m) return;
    m.aiShare = on ? "on" : "off";
    m.aiAskBy = null;
    if (on) {
      m.aiModels = models?.length ? models : this.localModelsList();
      return;
    }
    delete m.aiModels;
    for (const seat of r.seats) {
      if (seat.kind !== "agent") continue;
      if (resolveAiUserId(seat, r.hostUserId) !== userId) continue;
      const ws = resolveWorkspaceUserId(seat, r.hostUserId);
      seat.aiUserId = ws;
    }
  }

  private turnPermissionMode(
    r: RoomRecord,
    seat: RoomSeat,
    requesterUserId: string | null | undefined,
  ): PermissionMode | undefined {
    const ws = resolveWorkspaceUserId(seat, r.hostUserId);
    const policy = effectiveFilePolicy(
      r.members.find((m) => m.userId === ws)?.filePolicy,
      ws,
      requesterUserId,
    );
    if (policy === "deny") return undefined;
    if (policy === "allow") return "auto";
    return undefined;
  }

  private refuseDeniedWorkspace(
    r: RoomRecord,
    seat: RoomSeat,
    requesterUserId: string | null | undefined,
  ): boolean {
    const ws = resolveWorkspaceUserId(seat, r.hostUserId);
    const policy = effectiveFilePolicy(
      r.members.find((m) => m.userId === ws)?.filePolicy,
      ws,
      requesterUserId,
    );
    if (policy !== "deny") return false;
    const name = this.memberName(r, ws);
    this.append(r, {
      kind: "tool",
      seatId: seat.id,
      text: `「${name}」禁止他人操作其项目，任务被拒绝`,
      authorLabel: "系统",
    });
    this.pushState(r);
    return true;
  }

  /**
   * 这一轮要不要先问本机用户：工作区就在本机（ws === localUserId 才轮到本机
   * 执行），且文件策略解析为 ask（请求人 ≠ 工作区主人时默认就是 ask）。
   */
  private needsLocalTurnAsk(
    r: RoomRecord,
    seat: RoomSeat,
    requesterUserId: string | null | undefined,
  ): boolean {
    const ws = resolveWorkspaceUserId(seat, r.hostUserId);
    if (ws !== r.localUserId) return false;
    return (
      effectiveFilePolicy(
        r.members.find((m) => m.userId === ws)?.filePolicy,
        ws,
        requesterUserId,
      ) === "ask"
    );
  }

  /**
   * 向本机 UI 弹审批（所有窗口都推，任一窗口作答即生效，其余窗口的弹窗
   * 由 resolved 广播关掉）。120s 无人响应按拒绝处理。
   */
  private askLocalTurnApproval(
    r: RoomRecord,
    seat: RoomSeat,
    requesterUserId: string | null | undefined,
    text: string,
  ): Promise<boolean> {
    const requestId = randomUUID();
    const payload = {
      roomId: r.roomId,
      requestId,
      roomName: r.name,
      requesterName: requesterUserId
        ? this.memberName(r, requesterUserId)
        : "成员",
      seatName: seat.name,
      projectPath: this.settings.get().lastProjectPath ?? "",
      text: text.slice(0, 300),
    };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.turnAsks.delete(requestId);
        this.safeSend(IPC.roomPermAsk, { roomId: r.roomId, requestId, resolved: true });
        resolve(false);
      }, 120_000);
      this.turnAsks.set(requestId, { roomId: r.roomId, resolve, timer });
      this.safeSend(IPC.roomPermAsk, payload);
    });
  }

  /** IPC：本机用户在审批弹窗里点了 允许/拒绝。 */
  respondTurnAsk(requestId: string, allow: boolean): { ok: boolean } {
    const entry = this.turnAsks.get(requestId);
    if (!entry) return { ok: false };
    this.turnAsks.delete(requestId);
    clearTimeout(entry.timer);
    // 关掉其他窗口上的同款弹窗
    this.safeSend(IPC.roomPermAsk, {
      roomId: entry.roomId,
      requestId,
      resolved: true,
    });
    entry.resolve(allow);
    return { ok: true };
  }

  /** 审批未通过：时间线留审计记录（全员可见），返回 true 表示已拦截。 */
  private refuseUnapprovedTurn(
    r: RoomRecord,
    seat: RoomSeat,
    requesterUserId: string | null | undefined,
    reason: string,
  ): void {
    const name = requesterUserId
      ? this.memberName(r, requesterUserId)
      : "成员";
    this.append(r, {
      kind: "tool",
      seatId: seat.id,
      text: `「${name}」请求在本机项目执行任务，${reason}`,
      authorLabel: "系统",
    });
    this.pushState(r);
  }

  /** 读席位会话当前的上下文占用（无会话/无数据时返回 undefined）。 */
  private seatContextUsage(
    sessionId: string | null | undefined,
  ): { ratio: number; usedTokens: number; limitTokens: number } | undefined {
    if (!sessionId || typeof this.sessions.getSummary !== "function") {
      return undefined;
    }
    const cu = this.sessions.getSummary(sessionId)?.contextUsage;
    if (!cu) return undefined;
    return {
      ratio: cu.ratio,
      usedTokens: cu.usedTokens,
      limitTokens: cu.limitTokens,
    };
  }

  /**
   * 占用超阈值（0.75，同主会话自动压缩）就压缩席位会话。不 autoContinue：
   * 本轮任务已结束，下一轮带压缩后的历史起步即可。返回 true 表示压了。
   */
  private async maybeCompactSeatSession(
    sessionId: string | null | undefined,
    cu: { ratio: number } | undefined,
  ): Promise<boolean> {
    if (!sessionId || !cu || cu.ratio < ROOM_AUTO_COMPACT_RATIO) return false;
    if (typeof this.sessions.compressSession !== "function") return false;
    const res = await this.sessions.compressSession(sessionId, undefined, {
      autoContinue: false,
    });
    return res.ok;
  }

  private async ensureAiProxy(r: RoomRecord): Promise<number> {
    const existing = this.aiProxies.get(r.roomId);
    if (existing) return existing.port;
    const proxy = await startLoopbackProxy((req) => this.proxyAiHttp(r, req));
    this.aiProxies.set(r.roomId, proxy);
    return proxy.port;
  }

  private async borrowAiExtras(
    r: RoomRecord,
    seat: RoomSeat,
  ): Promise<Partial<SessionRunOpts>> {
    const aiId = resolveAiUserId(seat, r.hostUserId);
    if (aiId === r.localUserId) return {};
    const owner = r.members.find((m) => m.userId === aiId);
    if (!owner || owner.aiShare !== "on") {
      throw new Error("对方尚未同意借用 AI");
    }
    const port = await this.ensureAiProxy(r);
    return {
      skipCpa: true,
      extraEnv: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_AUTH_TOKEN: `room-borrow:${aiId}`,
        ANTHROPIC_MODEL: seat.model || "",
      },
    };
  }

  private async proxyAiHttp(
    r: RoomRecord,
    req: { method: string; path: string; body: Buffer; auth?: string },
  ): Promise<{ status: number; body: Buffer }> {
    const targetUserId = parseBorrowToken(req.auth);
    if (!targetUserId) {
      return {
        status: 401,
        body: Buffer.from(JSON.stringify({ error: { message: "missing borrow token" } })),
      };
    }
    const requestId = randomUUID();
    const frames = buildReqFrames({
      requestId,
      targetUserId,
      sourceUserId: r.localUserId,
      method: req.method,
      path: req.path,
      body: req.body,
    });
    const pending = new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.aiHttpWait.delete(requestId);
        reject(new Error("借用 AI 超时"));
      }, 180_000);
      this.aiHttpWait.set(requestId, {
        parts: new Map(),
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
    });
    for (const frame of frames) this.sendAiHttp(r, frame);
    return pending;
  }

  private sendAiHttp(r: RoomRecord, p: RoomAiHttpPayload): void {
    if (r.localRole === "host") {
      this.onAiHttp(r, r.localUserId, p);
      return;
    }
    this.sendClient(r, "ai.http", p);
  }

  private onAiHttp(
    r: RoomRecord,
    fromUserId: string,
    p: RoomAiHttpPayload,
  ): void {
    if (!p || typeof p.requestId !== "string") return;
    if (p.dir === "req") {
      if (p.targetUserId === r.localUserId) {
        this.assembleAiHttpReq(r, p);
        return;
      }
      if (r.localRole === "host") {
        const ws = this.findGuestWsByUserId(r, p.targetUserId);
        if (ws) this.reply(ws, r, "ai.http", p);
        return;
      }
      this.sendClient(r, "ai.http", p);
      return;
    }
    // res
    if (p.sourceUserId === r.localUserId) {
      this.completeAiHttpRes(p);
      return;
    }
    if (r.localRole === "host" && p.sourceUserId) {
      const ws = this.findGuestWsByUserId(r, p.sourceUserId);
      if (ws) this.reply(ws, r, "ai.http", p);
      return;
    }
    if (r.localRole !== "host") this.sendClient(r, "ai.http", p);
    void fromUserId;
  }

  private assembleAiHttpReq(r: RoomRecord, p: RoomAiHttpPayload): void {
    let box = this.aiHttpAssemble.get(p.requestId);
    if (!box) {
      box = {
        targetUserId: p.targetUserId,
        sourceUserId: p.sourceUserId || "",
        parts: new Map(),
      };
      this.aiHttpAssemble.set(p.requestId, box);
    }
    if (p.method) box.method = p.method;
    if (p.path) box.path = p.path;
    if (p.sourceUserId) box.sourceUserId = p.sourceUserId;
    if (p.data) box.parts.set(p.seq, p.data);
    if (!p.last) return;
    const ordered = [...box.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, d]) => d);
    const body = concatChunks(ordered);
    this.aiHttpAssemble.delete(p.requestId);
    void this.serveLocalCpa(r, {
      requestId: p.requestId,
      targetUserId: box.targetUserId,
      sourceUserId: box.sourceUserId,
      method: box.method || "POST",
      path: box.path || "/",
      body,
    });
  }

  private async serveLocalCpa(
    r: RoomRecord,
    req: {
      requestId: string;
      targetUserId: string;
      sourceUserId: string;
      method: string;
      path: string;
      body: Buffer;
    },
  ): Promise<void> {
    const fail = (status: number, message: string) => {
      for (const frame of buildResFrames({
        requestId: req.requestId,
        targetUserId: req.targetUserId,
        sourceUserId: req.sourceUserId,
        status,
        body: Buffer.from(JSON.stringify({ error: { message } })),
      })) {
        this.sendAiHttpRes(r, frame);
      }
    };
    const target = this.cpa?.getProxyTarget();
    if (!target) {
      fail(503, "本机 CPA 未就绪，无法出借 AI");
      return;
    }
    const owner = r.members.find((m) => m.userId === r.localUserId);
    if (owner && owner.aiShare !== "on") {
      fail(403, "未开启 AI 共享");
      return;
    }
    try {
      const url = `${target.origin}${req.path.startsWith("/") ? req.path : `/${req.path}`}`;
      const res = await fetch(url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${target.token}`,
          "content-type": "application/json",
        },
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : new Uint8Array(req.body),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      for (const frame of buildResFrames({
        requestId: req.requestId,
        targetUserId: req.targetUserId,
        sourceUserId: req.sourceUserId,
        status: res.status,
        body: buf,
      })) {
        this.sendAiHttpRes(r, frame);
      }
    } catch (err) {
      fail(502, err instanceof Error ? err.message : String(err));
    }
  }

  private sendAiHttpRes(r: RoomRecord, p: RoomAiHttpPayload): void {
    if (p.sourceUserId === r.localUserId) {
      this.completeAiHttpRes(p);
      return;
    }
    if (r.localRole === "host" && p.sourceUserId) {
      const ws = this.findGuestWsByUserId(r, p.sourceUserId);
      if (ws) this.reply(ws, r, "ai.http", p);
      return;
    }
    this.sendClient(r, "ai.http", p);
  }

  private completeAiHttpRes(p: RoomAiHttpPayload): void {
    const wait = this.aiHttpWait.get(p.requestId);
    if (!wait) return;
    if (typeof p.status === "number") wait.status = p.status;
    if (p.data) wait.parts.set(p.seq, p.data);
    if (!p.last) return;
    const ordered = [...wait.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, d]) => d);
    this.aiHttpWait.delete(p.requestId);
    wait.resolve({
      status: wait.status ?? 200,
      body: concatChunks(ordered),
    });
  }

  /** 本机网关已配置的模型名列表（用于校验席位模型在执行节点上是否存在）。 */
  private localModels(): string[] {
    const st = this.settings.get();
    if (Array.isArray(st.models) && st.models.length) return st.models;
    return st.defaultModel ? [st.defaultModel] : [];
  }

  /**
   * 席位模型只在挑选它的那台机器上保证存在。在执行节点本地校验：
   * 未配置就回落节点默认模型（不覆盖 model），fallbackFrom 用于提示。
   */
  private effectiveSeatModel(seat: RoomSeat): {
    model?: string;
    fallbackFrom?: string;
  } {
    if (!seat.model) return {};
    const known = this.localModels();
    if (!known.length || known.includes(seat.model)) return { model: seat.model };
    return { fallbackFrom: seat.model };
  }

  private findGuestWsByUserId(r: RoomRecord, userId: string): WebSocket | null {
    for (const g of r.guests) {
      if ((g as GuestWs).userId === userId && g.readyState === WebSocket.OPEN) {
        return g;
      }
    }
    return null;
  }

  /**
   * 证据链：每房间一份 exec-log.jsonl（两端同格式、只追加），
   * 落在 userData/rooms/ 下，与房间归档同目录。
   */
  private execLog(
    r: RoomRecord,
    entry: {
      turnId: string;
      dir: "out" | "in";
      type: string;
      seatId?: string;
      state?: string;
      note?: string;
    },
  ): void {
    try {
      const dir = path.join(this.userDataDir, "rooms");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, `${r.roomId}.exec-log.jsonl`),
        `${JSON.stringify({ ts: Date.now(), ...entry })}\n`,
        "utf8",
      );
    } catch {
      // 日志写失败不影响执行
    }
  }

  /** 房主：把一个席位轮次派发给它的执行节点。 */
  private dispatchRemoteTurn(
    r: RoomRecord,
    seat: RoomSeat,
    text: string,
    requesterUserId: string | null,
  ): void {
    const executor = seat.executorUserId!;
    const nodeName = this.memberName(r, executor);
    const ws = this.findGuestWsByUserId(r, executor);
    if (!ws) {
      this.append(r, {
        kind: "system",
        seatId: seat.id,
        text: `「${seat.name}」应在 ${nodeName} 的电脑上运行，但对方不在线`,
        authorLabel: "系统",
      });
      this.pushState(r);
      return;
    }
    const turnId = randomUUID();
    const turn: RemoteTurn = {
      turnId,
      seatId: seat.id,
      requesterUserId,
      executorUserId: executor,
      state: "dispatched",
      dispatchedAt: Date.now(),
      lastEventAt: Date.now(),
      text,
    };
    (r.remoteTurns ??= new Map()).set(turnId, turn);
    seat.running = true;
    this.execLog(r, {
      turnId,
      dir: "out",
      type: "exec.run",
      seatId: seat.id,
      state: "dispatched",
      note: `executor=${nodeName}`,
    });
    this.append(r, {
      kind: "tool",
      seatId: seat.id,
      text: `已派发给「${nodeName}」的电脑执行（任务 ${turnId.slice(0, 8)}）`,
      authorLabel: "系统",
    });
    this.reply(ws, r, "exec.run", {
      turnId,
      seatId: seat.id,
      text,
      requesterUserId,
    } satisfies RoomExecRunPayload);
    turn.ackTimer = setTimeout(
      () => this.onExecAckTimeout(r.roomId, turnId),
      EXEC_ACK_TIMEOUT_MS,
    );
    turn.heartbeatTimer = setInterval(
      () => this.onExecHeartbeatCheck(r.roomId, turnId),
      20_000,
    );
    turn.totalTimer = setTimeout(
      () => this.onExecTotalTimeout(r.roomId, turnId),
      EXEC_TOTAL_TIMEOUT_MS,
    );
    this.pushState(r);
  }

  private clearRemoteTurnTimers(turn: RemoteTurn): void {
    if (turn.ackTimer) clearTimeout(turn.ackTimer);
    if (turn.heartbeatTimer) clearInterval(turn.heartbeatTimer);
    if (turn.totalTimer) clearTimeout(turn.totalTimer);
    turn.ackTimer = undefined;
    turn.heartbeatTimer = undefined;
    turn.totalTimer = undefined;
  }

  private isTurnActive(t: RemoteTurn): boolean {
    return t.state === "dispatched" || t.state === "running";
  }

  /** 收敛到终态：清定时器、写台账、席位 running 复位。 */
  private settleRemoteTurn(
    r: RoomRecord,
    turn: RemoteTurn,
    state: RemoteTurnState,
    error?: string,
  ): void {
    if (!this.isTurnActive(turn)) return;
    turn.state = state;
    turn.doneAt = Date.now();
    if (error) turn.error = error;
    this.clearRemoteTurnTimers(turn);
    r.liveExec?.delete(turn.turnId);
    this.execLog(r, {
      turnId: turn.turnId,
      dir: "in",
      type: "exec.result",
      seatId: turn.seatId,
      state,
      ...(error ? { note: error } : {}),
    });
    const seat = r.seats.find((s) => s.id === turn.seatId);
    const stillActive = [...(r.remoteTurns?.values() ?? [])].some(
      (t) => t !== turn && t.seatId === turn.seatId && this.isTurnActive(t),
    );
    if (seat && !stillActive) seat.running = false;
  }

  private onExecAckTimeout(roomId: string, turnId: string): void {
    const r = this.rooms.get(roomId);
    const turn = r?.remoteTurns?.get(turnId);
    if (!r || !turn || turn.state !== "dispatched") return;
    const ws = this.findGuestWsByUserId(r, turn.executorUserId);
    if (!turn.resent && ws) {
      // ack 超时重发一次（节点幂等：重复的 exec.run 只回 ack）
      turn.resent = true;
      this.execLog(r, { turnId, dir: "out", type: "exec.run", state: "resent" });
      this.reply(ws, r, "exec.run", {
        turnId,
        seatId: turn.seatId,
        text: turn.text,
        requesterUserId: turn.requesterUserId,
      } satisfies RoomExecRunPayload);
      turn.ackTimer = setTimeout(
        () => this.onExecAckTimeout(roomId, turnId),
        EXEC_ACK_TIMEOUT_MS,
      );
      return;
    }
    const seat = r.seats.find((s) => s.id === turn.seatId);
    this.settleRemoteTurn(r, turn, "failed", "节点无响应");
    this.append(r, {
      kind: "tool",
      seatId: turn.seatId,
      text: `「${this.memberName(r, turn.executorUserId)}」的电脑无响应，任务失败（${turnId.slice(0, 8)}）`,
      authorLabel: "系统",
    });
    if (seat) seat.running = false;
    this.pushState(r);
  }

  private onExecHeartbeatCheck(roomId: string, turnId: string): void {
    const r = this.rooms.get(roomId);
    const turn = r?.remoteTurns?.get(turnId);
    if (!r || !turn || !this.isTurnActive(turn)) return;
    if (Date.now() - turn.lastEventAt <= EXEC_HEARTBEAT_TIMEOUT_MS) return;
    this.settleRemoteTurn(r, turn, "failed", "心跳超时（失联）");
    const ws = this.findGuestWsByUserId(r, turn.executorUserId);
    if (ws) {
      this.reply(ws, r, "exec.abort", {
        turnId,
        reason: "心跳超时",
      } satisfies RoomExecAbortPayload);
    }
    this.append(r, {
      kind: "tool",
      seatId: turn.seatId,
      text: `「${this.memberName(r, turn.executorUserId)}」的电脑失联，任务中断（${turnId.slice(0, 8)}）`,
      authorLabel: "系统",
    });
    this.pushState(r);
  }

  private onExecTotalTimeout(roomId: string, turnId: string): void {
    const r = this.rooms.get(roomId);
    const turn = r?.remoteTurns?.get(turnId);
    if (!r || !turn || !this.isTurnActive(turn)) return;
    this.settleRemoteTurn(r, turn, "timeout", "超过单轮时长上限");
    const ws = this.findGuestWsByUserId(r, turn.executorUserId);
    if (ws) {
      this.reply(ws, r, "exec.abort", {
        turnId,
        reason: "超过单轮时长上限",
      } satisfies RoomExecAbortPayload);
    }
    this.append(r, {
      kind: "tool",
      seatId: turn.seatId,
      text: `任务超过 10 分钟未完成，已中止（${turnId.slice(0, 8)}）`,
      authorLabel: "系统",
    });
    this.pushState(r);
  }

  /** 房主收到节点的 exec.event（ack / 心跳 / 阶段提示）。 */
  private onNodeExecEvent(
    r: RoomRecord,
    userId: string,
    p: RoomExecEventPayload,
  ): void {
    if (!p || typeof p.turnId !== "string") return;
    const turn = r.remoteTurns?.get(p.turnId);
    if (!turn || turn.executorUserId !== userId) {
      // 对账：房主没有这轮（重启后丢了/已终态）→ 让节点停
      if (p.phase === "accepted" || p.phase === "running") {
        const ws = this.findGuestWsByUserId(r, userId);
        if (ws) {
          this.reply(ws, r, "exec.abort", {
            turnId: p.turnId,
            reason: "房主侧无此任务",
          } satisfies RoomExecAbortPayload);
        }
        this.execLog(r, {
          turnId: p.turnId,
          dir: "in",
          type: "exec.event",
          state: "unknown-turn",
          note: "对账失败，已回 abort",
        });
      }
      return;
    }
    if (!this.isTurnActive(turn)) return;
    turn.lastEventAt = Date.now();
    if (p.phase === "note") {
      // 二期：流式进度进快照（轻量广播，不落盘）
      (r.liveExec ??= new Map()).set(turn.turnId, {
        turnId: turn.turnId,
        seatId: turn.seatId,
        text: typeof p.text === "string" ? p.text : "",
        ...(typeof p.thinking === "string" && p.thinking
          ? { thinking: p.thinking }
          : {}),
        ...(p.tool ? { tool: p.tool } : {}),
        at: Date.now(),
      });
      this.pushLive(r);
      return;
    }
    if (turn.state === "dispatched") {
      turn.state = "running";
      if (turn.ackTimer) {
        clearTimeout(turn.ackTimer);
        turn.ackTimer = undefined;
      }
      this.execLog(r, {
        turnId: turn.turnId,
        dir: "in",
        type: "exec.event",
        seatId: turn.seatId,
        state: "running",
      });
    }
  }

  /** 房主收到节点的 exec.result（终态）。 */
  private onNodeExecResult(
    r: RoomRecord,
    userId: string,
    p: RoomExecResultPayload,
  ): void {
    if (!p || typeof p.turnId !== "string") return;
    const turn = r.remoteTurns?.get(p.turnId);
    // 结果必须来自该轮的执行节点，否则无法核实，丢弃
    if (!turn || turn.executorUserId !== userId || !this.isTurnActive(turn)) {
      return;
    }
    const seat = r.seats.find((s) => s.id === turn.seatId);
    const nodeName = this.memberName(r, userId);
    if (p.ok && typeof p.text === "string" && p.text.trim()) {
      this.append(r, {
        kind: "assistant",
        seatId: turn.seatId,
        authorLabel: seat?.name ?? "Agent",
        text: p.text.trim(),
      });
    }
    const changes =
      Array.isArray(p.changes) && p.changes.length
        ? `，改动：${p.changes.slice(0, 12).join("、")}`
        : "";
    // 二期：结构化改动进快照，各端变更栏只读查看（回滚只能节点本机）
    if (Array.isArray(p.changesDetail) && p.changesDetail.length) {
      const store = (r.remoteChanges ??= {});
      const prev = store[turn.seatId] ?? [];
      const byPath = new Map(prev.map((c) => [c.path, c]));
      for (const c of p.changesDetail.slice(0, 8)) {
        byPath.set(c.path, c);
      }
      // 每席位最多保留 12 个文件，超出按更新时间淘汰最旧
      store[turn.seatId] = [...byPath.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 12);
    }
    this.append(r, {
      kind: "tool",
      seatId: turn.seatId,
      text: p.ok
        ? `「${nodeName}」的电脑执行完成${changes}（${turn.turnId.slice(0, 8)}）`
        : `「${nodeName}」的电脑执行失败：${p.error ?? "未知错误"}（${turn.turnId.slice(0, 8)}）`,
      authorLabel: "系统",
    });
    // 节点回报的席位上下文占用：更新快照（null = 节点刚压缩过，清零徽标）。
    if (seat && p.contextUsage !== undefined) {
      seat.contextUsage = p.contextUsage;
    }
    if (seat && p.compacted) {
      this.append(r, {
        kind: "system",
        seatId: turn.seatId,
        text: `席位「${seat.name}」上下文占用过高，「${nodeName}」的电脑已自动压缩历史`,
        authorLabel: "系统",
      });
    }
    this.settleRemoteTurn(r, turn, p.ok ? "done" : "failed", p.error);
    this.pushState(r);
  }

  /* ── 节点侧（成员机器）执行循环 ───────────────────────────────────── */

  /** 节点收到房主的 exec.run：幂等接收，本机起会话执行。 */
  private onExecRun(r: RoomRecord, p: RoomExecRunPayload): void {
    if (!p || typeof p.turnId !== "string" || typeof p.seatId !== "string") {
      return;
    }
    if (typeof p.text !== "string" || !p.text.trim()) return;
    const turns = (r.nodeTurns ??= new Map());
    if (turns.has(p.turnId)) {
      // 重发的 exec.run：只重新 ack，不重复执行（turnId 幂等）
      this.sendClient(r, "exec.event", {
        turnId: p.turnId,
        seatId: p.seatId,
        phase: "accepted",
      } satisfies RoomExecEventPayload);
      return;
    }
    const fail = (error: string) => {
      this.execLog(r, {
        turnId: p.turnId,
        dir: "in",
        type: "exec.run",
        seatId: p.seatId,
        state: "failed",
        note: error,
      });
      this.sendClient(r, "exec.result", {
        turnId: p.turnId,
        seatId: p.seatId,
        ok: false,
        error,
      } satisfies RoomExecResultPayload);
    };
    const seat = r.seats.find((s) => s.id === p.seatId);
    if (!seat || seat.kind !== "agent") return fail("席位不存在或不是 Agent");
    const wsId = resolveWorkspaceUserId(seat, r.hostUserId);
    if (wsId !== r.localUserId) {
      return fail("该席位不在本机执行");
    }
    const policy = effectiveFilePolicy(
      r.members.find((m) => m.userId === wsId)?.filePolicy,
      wsId,
      p.requesterUserId,
    );
    if (policy === "deny") {
      return fail("本机禁止他人操作此项目");
    }
    const cwd = this.settings.get().lastProjectPath;
    if (!cwd) return fail("本机尚未打开项目，无法执行");
    const nt: NodeTurn = {
      turnId: p.turnId,
      seatId: p.seatId,
      requesterUserId: p.requesterUserId ?? null,
      heartbeat: null,
      startedAt: Date.now(),
      liveText: "",
      lastLiveSendAt: 0,
    };
    turns.set(p.turnId, nt);
    this.execLog(r, {
      turnId: p.turnId,
      dir: "in",
      type: "exec.run",
      seatId: p.seatId,
      state: "accepted",
    });
    this.sendClient(r, "exec.event", {
      turnId: p.turnId,
      seatId: p.seatId,
      phase: "accepted",
    } satisfies RoomExecEventPayload);
    nt.heartbeat = setInterval(() => {
      this.sendClient(r, "exec.event", {
        turnId: nt.turnId,
        seatId: nt.seatId,
        phase: "running",
      } satisfies RoomExecEventPayload);
    }, EXEC_HEARTBEAT_INTERVAL_MS);
    nt.heartbeat.unref?.();
    // 文件策略 ask：别人要在本机项目上跑 → 先弹窗问本机用户，通过才执行。
    if (policy === "ask") {
      void (async () => {
        const allowed = await this.askLocalTurnApproval(
          r,
          seat,
          p.requesterUserId ?? null,
          p.text,
        );
        if (!allowed) {
          if (nt.heartbeat) clearInterval(nt.heartbeat);
          turns.delete(p.turnId);
          fail("本机用户拒绝了这次远程执行");
          return;
        }
        void this.runNodeTurn(r, nt, seat, p.text, cwd);
      })();
      return;
    }
    void this.runNodeTurn(r, nt, seat, p.text, cwd);
  }

  private async runNodeTurn(
    r: RoomRecord,
    nt: NodeTurn,
    seat: RoomSeat,
    text: string,
    cwd: string,
  ): Promise<void> {
    const seatSessions = (r.nodeSeatSessions ??= new Map());
    const prevSession = seatSessions.get(nt.seatId);
    // 席位模型在节点本机校验：未配置则回落本机默认，回复里注明。
    const borrowing =
      resolveAiUserId(seat, r.hostUserId) !== r.localUserId;
    const em = borrowing
      ? { model: seat.model }
      : this.effectiveSeatModel(seat);
    const modelNote = em.fallbackFrom
      ? `> 席位模型「${em.fallbackFrom}」在本机网关未配置，已改用本机默认模型\n\n`
      : "";
    const prompt = {
      text: prevSession
        ? text
        : `${this.agentSeatPrefix(seat)}\n${this.pathGuardPrefix(cwd)}\n${text}`,
      attachments: [],
    };
    const perm = this.turnPermissionMode(r, seat, nt.requesterUserId);
    const extras: SessionRunOpts = {
      replaceExtras: true,
      hiddenFromList: true,
      // 群聊驱动的 AI 圈死在工作区内：文件工具越界直接拒（不管谁发起的）。
      pathJail: cwd,
      ...(em.model ? { model: em.model } : {}),
      ...(perm ? { permissionMode: perm } : {}),
      // 会话条目一建好就拿到 id：流式事件映射 + 中途 abort 都靠它
      onSessionId: (id: string) => {
        nt.sessionId = id;
      },
    };
    try {
      Object.assign(extras, await this.borrowAiExtras(r, seat));
      let sid = prevSession;
      if (!sid) {
        sid = await this.sessions.start(prompt, cwd, extras);
        seatSessions.set(nt.seatId, sid);
      } else {
        await this.sessions.continue(sid, prompt, extras);
      }
      nt.sessionId = sid;
      this.execLog(r, {
        turnId: nt.turnId,
        dir: "in",
        type: "exec.run",
        seatId: nt.seatId,
        state: "running",
        note: `localSession=${sid}`,
      });
      const items = this.sessions.getTranscript(sid);
      const last = [...items]
        .reverse()
        .find((i) => i.kind === "text" && i.role === "assistant");
      const reply = last && last.kind === "text" ? last.text.trim() : "";
      const changed = this.sessions
        .getChangesForSelect(sid)
        .map((c) => c.path)
        .slice(0, 12);
      const changesDetail = this.turnChangesDetail(sid, nt.startedAt);
      // 上下文占用随结果回报给房主；超阈值先在本机压缩（回报 null 让房主清零徽标）。
      const cu = this.seatContextUsage(sid);
      const compacted = await this.maybeCompactSeatSession(sid, cu);
      this.sendClient(r, "exec.result", {
        turnId: nt.turnId,
        seatId: nt.seatId,
        ok: true,
        text: modelNote ? modelNote + reply : reply,
        ...(changed.length ? { changes: changed } : {}),
        ...(changesDetail.length ? { changesDetail } : {}),
        ...(compacted
          ? { contextUsage: null, compacted: true }
          : cu !== undefined
            ? { contextUsage: cu }
            : {}),
      } satisfies RoomExecResultPayload);
      this.execLog(r, {
        turnId: nt.turnId,
        dir: "out",
        type: "exec.result",
        seatId: nt.seatId,
        state: "done",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cu = this.seatContextUsage(nt.sessionId ?? seatSessions.get(nt.seatId));
      this.sendClient(r, "exec.result", {
        turnId: nt.turnId,
        seatId: nt.seatId,
        ok: false,
        error: msg,
        ...(cu !== undefined ? { contextUsage: cu } : {}),
      } satisfies RoomExecResultPayload);
      this.execLog(r, {
        turnId: nt.turnId,
        dir: "out",
        type: "exec.result",
        seatId: nt.seatId,
        state: "failed",
        note: msg,
      });
    } finally {
      if (nt.heartbeat) clearInterval(nt.heartbeat);
      r.nodeTurns?.delete(nt.turnId);
    }
  }

  /**
   * 本轮改动（since 之后的事件）截断打包：最多 8 个文件、每文件留最新 3 个事件、
   * hunk 文本截到 16k，防止 exec.result 撑爆帧上限。
   */
  private turnChangesDetail(sessionId: string, since: number): FileChange[] {
    const all = this.sessions.getChangesForSelect(sessionId);
    const out: FileChange[] = [];
    for (const c of all) {
      const events = c.events.filter((e) => e.at >= since).slice(-3);
      if (!events.length) continue;
      out.push({
        path: c.path,
        status: c.status,
        hunks: c.hunks.slice(0, 16 * 1024),
        updatedAt: c.updatedAt,
        events: events.map((e) => ({
          ...e,
          hunk: e.hunk.slice(0, 16 * 1024),
          canRestore: false, // 远端记录只读，回滚只能节点本机
        })),
      });
      if (out.length >= 8) break;
    }
    return out;
  }

  /** 节点收到房主的 exec.abort：中止本机这轮。 */
  private onExecAbort(r: RoomRecord, p: RoomExecAbortPayload): void {
    if (!p || typeof p.turnId !== "string") return;
    const nt = r.nodeTurns?.get(p.turnId);
    if (!nt) return;
    this.execLog(r, {
      turnId: p.turnId,
      dir: "in",
      type: "exec.abort",
      seatId: nt.seatId,
      state: "aborted",
      ...(p.reason ? { note: p.reason } : {}),
    });
    if (nt.sessionId) {
      try {
        this.sessions.abort(nt.sessionId);
      } catch {
        // ignore
      }
    }
    // sessions.abort 会让 runNodeTurn 的 await 抛错，
    // 由它的 catch/finally 回 exec.result(ok:false) 并清理心跳。
    if (!nt.sessionId) {
      if (nt.heartbeat) clearInterval(nt.heartbeat);
      r.nodeTurns?.delete(nt.turnId);
    }
  }

  /**
   * 节点：SessionManager 事件流的水龙头（index.ts 的 emit 挂钩调这里）。
   * 命中本机正在跑的远程轮时，把回复文本/工具行动态节流转发给房主。
   * 房主本机席位（local- 前缀键）直接写 liveExec 进快照，不走网络。
   */
  onSessionEvent(event: SdkNormalizedEvent): void {
    if (!("sessionId" in event) || !event.sessionId) return;
    for (const r of this.rooms.values()) {
      if (r.nodeTurns?.size) {
        let matched = false;
        for (const nt of r.nodeTurns.values()) {
          if (nt.sessionId !== event.sessionId) continue;
          if (event.type === "text_delta") {
            nt.liveText += event.text;
          } else if (event.type === "text_done") {
            nt.liveText = event.text;
          } else if (event.type === "thinking_delta") {
            nt.liveThinking = (nt.liveThinking ?? "") + event.text;
          } else if (event.type === "tool_start") {
            const t = event.tool;
            nt.liveTool = `${t.name}${t.summary ? ` ${t.summary.slice(0, 80)}` : ""}`;
          } else {
            continue;
          }
          matched = true;
          // 节流：文本/思考增量 800ms 一帧攒着发；工具切换低频，立即发
          const isTool = event.type === "tool_start";
          const now = Date.now();
          if (!isTool && now - nt.lastLiveSendAt < EXEC_LIVE_INTERVAL_MS) break;
          nt.lastLiveSendAt = now;
          this.sendClient(r, "exec.event", {
            turnId: nt.turnId,
            seatId: nt.seatId,
            phase: "note",
            text: nt.liveText.slice(-EXEC_LIVE_TEXT_TAIL),
            ...(nt.liveThinking
              ? { thinking: nt.liveThinking.slice(-EXEC_LIVE_TEXT_TAIL) }
              : {}),
            ...(nt.liveTool ? { tool: nt.liveTool } : {}),
          } satisfies RoomExecEventPayload);
          break;
        }
        if (matched) return;
      }
      // 房主本机席位：SessionManager 事件直接进 liveExec 快照。
      if (r.localRole !== "host") continue;
      for (const seat of r.seats) {
        if (seat.kind !== "agent" || !seat.running) continue;
        if (!seat.sessionId || seat.sessionId !== event.sessionId) continue;
        const key = `local-${seat.id}`;
        const store = (r.liveExec ??= new Map());
        const entry = store.get(key) ?? {
          turnId: key,
          seatId: seat.id,
          text: "",
          at: 0,
        };
        let isTool = false;
        if (event.type === "text_delta") {
          entry.text += event.text;
        } else if (event.type === "text_done") {
          entry.text = event.text;
        } else if (event.type === "thinking_delta") {
          entry.thinking = (entry.thinking ?? "") + event.text;
        } else if (event.type === "tool_start") {
          const tl = event.tool;
          entry.tool = `${tl.name}${tl.summary ? ` ${tl.summary.slice(0, 80)}` : ""}`;
          isTool = true;
        } else {
          break;
        }
        store.set(key, entry);
        // 同样节流广播；entry 已落 map，跳过广播也不丢内容
        const now = Date.now();
        if (!isTool && now - entry.at < EXEC_LIVE_INTERVAL_MS) return;
        entry.at = now;
        this.pushLive(r);
        return;
      }
    }
  }

  /** 清理所有远程执行定时器（关房 / dispose 时调）。 */
  private disposeExecTurns(r: RoomRecord): void {
    for (const turn of r.remoteTurns?.values() ?? []) {
      this.clearRemoteTurnTimers(turn);
    }
    r.remoteTurns?.clear();
    for (const nt of r.nodeTurns?.values() ?? []) {
      if (nt.heartbeat) clearInterval(nt.heartbeat);
    }
    r.nodeTurns?.clear();
    const proxy = this.aiProxies.get(r.roomId);
    if (proxy) {
      proxy.close();
      this.aiProxies.delete(r.roomId);
    }
    for (const [id, wait] of this.aiHttpWait) {
      clearTimeout(wait.timer);
      wait.reject(new Error("房间已关闭"));
      this.aiHttpWait.delete(id);
    }
  }

  /** 房主：中止某席位名下所有在跑的远程轮（接管/踢人等）。 */
  private abortRemoteTurnsForSeat(
    r: RoomRecord,
    seatId: string,
    reason: string,
  ): void {
    if (!r.remoteTurns?.size) return;
    for (const turn of r.remoteTurns.values()) {
      if (turn.seatId !== seatId || !this.isTurnActive(turn)) continue;
      const ws = this.findGuestWsByUserId(r, turn.executorUserId);
      if (ws) {
        this.reply(ws, r, "exec.abort", {
          turnId: turn.turnId,
          reason,
        } satisfies RoomExecAbortPayload);
      }
      this.settleRemoteTurn(r, turn, "aborted", reason);
    }
  }

  private onGuest(r: RoomRecord, ws: WebSocket) {
    // Per-connection abuse guard (task 14): token bucket + oversized streak.
    const guard: ConnGuard = {
      bucket: new TokenBucket({
        ratePerSec: ROOM_CONN_RATE_PER_SEC,
        burst: ROOM_CONN_BURST,
      }),
      oversized: 0,
      abused: 0,
    };
    (ws as GuestWs).guard = guard;
    const chargeOversized = () => {
      chargeAbuse(guard);
      guard.oversized += 1;
      if (guard.oversized >= ROOM_OVERSIZED_MAX_STREAK) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
    // Half-open watchdog: sockets that never finish the handshake (or never
    // send a legacy plaintext join on skip-encrypt rooms) get an
    // hs.reject { reason: "timeout" } and are closed.
    const watchdog = new HandshakeWatchdog(this.handshakeTimeoutMs, () => {
      this.metrics.record({
        type: "handshake",
        reason: HandshakeReject.timeout,
      });
      try {
        ws.send(
          JSON.stringify(
            makeHandshake("reject", { reason: HandshakeReject.timeout }),
          ),
        );
      } catch {
        // ignore
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
    watchdog.start();
    const hsState: GuestHandshakeState = {};
    const onMsg = (data: RawData) => {
      const raw = String(data);
      const bytes = Buffer.byteLength(raw);
      // Absolute ceiling first (catches unparseable junk without JSON.parse),
      // then the per-kind cap once the PDU shape is known.
      if (bytes > frameLimit("envelope")) {
        chargeOversized();
        return;
      }
      const pdu = parsePdu(raw);
      if (!pdu) return;
      const limitKind =
        pdu.kind === "hs"
          ? "handshake"
          : pdu.kind === "env"
            ? "envelope"
            : pdu.kind === "frame"
              ? pdu.frame.type
              : "default";
      if (bytes > frameLimit(limitKind)) {
        chargeOversized();
        return;
      }
      guard.oversized = 0;
      if (pdu.kind === "hs") {
        this.handleGuestHandshake(r, ws, pdu.hs, hsState, {
          cancelWatchdog: () => watchdog.cancel(),
          upgrade: () => {
            watchdog.cancel();
            ws.off("message", onMsg);
          },
        });
        return;
      }
      if (pdu.kind === "frame") {
        const frame = pdu.frame;
        // Peek stays unauthenticated: hello → mod.offer, same as before.
        if (frame.type === "hello") {
          this.reply(ws, r, "mod.offer", this.buildOffer(r));
          return;
        }
        // mod.fetch is also allowed before hs.ok (task 14): the bundle is
        // gated by its checksum, which is already public via the invite.
        if (frame.type === "mod.fetch") {
          void this.serveModBundle(r, ws as GuestWs, frame);
          return;
        }
        // Skip-encrypt rooms keep the legacy plaintext path. Encrypted rooms
        // ignore everything else until hs.ok (no state.snapshot / seat frames).
        if (!r.encrypt) {
          if (frame.type === "join") watchdog.cancel();
          this.handleGuestFrame(r, ws, frame);
        }
        return;
      }
      // env / ack before the handshake completes: drop.
    };
    ws.on("message", onMsg);
    ws.on("close", () => {
      watchdog.cancel();
      r.guests.delete(ws);
      const conn = r.connections.get(ws);
      if (conn) {
        conn.close();
        r.connections.delete(ws);
      }
      // A pending device that hung up leaves the approval list.
      for (const [fp, entry] of r.pendingByFp) {
        if (entry.ws === ws) {
          clearTimeout(entry.timer);
          r.pendingByFp.delete(fp);
          this.emitPending(r);
        }
      }
      // 远程执行对账：掉线者名下在跑的轮次立即判失联（不等心跳超时）
      const goneUserId = (ws as GuestWs).userId;
      if (goneUserId && r.remoteTurns?.size) {
        for (const turn of r.remoteTurns.values()) {
          if (turn.executorUserId !== goneUserId || !this.isTurnActive(turn)) {
            continue;
          }
          this.settleRemoteTurn(r, turn, "failed", "节点断线");
          this.append(r, {
            kind: "tool",
            seatId: turn.seatId,
            text: `「${this.memberName(r, goneUserId)}」掉线，其电脑上的执行中断（${turn.turnId.slice(0, 8)}）`,
            authorLabel: "系统",
          });
        }
      }
      this.markMemberOffline(r, goneUserId);
    });
  }

  /**
   * Host side of the HMAC handshake. On success the socket is wrapped in a
   * RoomConnection and `ctl.upgrade` retires the pre-handshake listener.
   * New devices (and known users whose fingerprint changed) are held in
   * `r.pendingByFp` until the host approves / denies them (task 8).
   */
  private handleGuestHandshake(
    r: RoomRecord,
    ws: WebSocket,
    hs: Handshake,
    state: GuestHandshakeState,
    ctl: { cancelWatchdog: () => void; upgrade: () => void },
  ): void {
    if (hs.type === "hello") {
      const p = hs.payload as {
        pub?: string;
        fp?: string;
        name?: string;
        userId?: string;
      };
      const fp = String(p.fp ?? "");
      if (fp && r.blacklist.has(fp)) {
        this.metrics.record({
          type: "handshake",
          reason: HandshakeReject.blacklist,
        });
        ws.send(
          JSON.stringify(
            makeHandshake("reject", { reason: HandshakeReject.blacklist }),
          ),
        );
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      let guestPub: Buffer;
      try {
        guestPub = Buffer.from(String(p.pub ?? ""), "base64url");
        if (guestPub.length !== 32) throw new Error("bad pub");
      } catch {
        return; // malformed hello — watchdog will reap the socket
      }
      state.guestFp = fp;
      state.guestName = String(p.name ?? "guest");
      state.guestPub = guestPub;
      state.userId = String(p.userId ?? "") || undefined;
      // TOFU: a known userId showing up with a different fingerprint must be
      // re-approved by the host, even on autoApprove rooms.
      state.fpChanged = false;
      if (state.userId) {
        for (const d of r.knownDevices.values()) {
          if (d.userId === state.userId && d.fp !== fp) {
            state.fpChanged = true;
            break;
          }
        }
      }
      state.key = deriveSessionKey(r.deviceKeys, guestPub);
      state.nonce = randomBytes(16);
      ws.send(
        JSON.stringify(
          makeHandshake("challenge", {
            pub: r.deviceKeys.publicRaw.toString("base64url"),
            fp: r.hostFingerprint,
            nonce: state.nonce.toString("base64url"),
            encrypt: r.encrypt,
          }),
        ),
      );
      return;
    }
    if (hs.type === "prove") {
      if (!state.nonce || !state.key || !state.guestFp || !state.guestPub) {
        return;
      }
      const p = hs.payload as { proof?: string };
      const ok = verifyPassword({
        password: r.password,
        nonce: state.nonce,
        hostFp: r.hostFingerprint,
        guestFp: state.guestFp,
        ecdhSs: state.key,
        proof: String(p.proof ?? ""),
      });
      if (!ok) {
        this.metrics.record({
          type: "handshake",
          reason: HandshakeReject.password,
        });
        ws.send(
          JSON.stringify(
            makeHandshake("reject", { reason: HandshakeReject.password }),
          ),
        );
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      const fp = state.guestFp;
      if (!r.knownDevices.has(fp)) {
        if (!r.autoApprove || state.fpChanged) {
          // New device (or fingerprint change): hold for host approval.
          // The handshake socket stays open until approve / deny / 60s.
          ctl.cancelWatchdog();
          const name = state.guestName ?? "guest";
          const timer = setTimeout(() => {
            if (!r.pendingByFp.delete(fp)) return;
            this.metrics.record({
              type: "handshake",
              reason: HandshakeReject.timeout,
            });
            try {
              ws.send(
                JSON.stringify(
                  makeHandshake("reject", { reason: HandshakeReject.timeout }),
                ),
              );
            } catch {
              // ignore
            }
            try {
              ws.close();
            } catch {
              // ignore
            }
            this.emitPending(r);
          }, 60_000);
          r.pendingByFp.set(fp, {
            ws,
            name,
            nonce: state.nonce,
            guestPub: state.guestPub,
            key: state.key,
            ...(state.userId ? { userId: state.userId } : {}),
            ...(state.fpChanged ? { fpChanged: true } : {}),
            upgrade: ctl.upgrade,
            timer,
          });
          ws.send(JSON.stringify(makeHandshake("pending", { fp })));
          this.append(r, {
            kind: "system",
            text: state.fpChanged
              ? `设备「${name}」指纹已变化，等待重新审批`
              : `新设备「${name}」等待群主审批`,
            authorLabel: "系统",
          });
          this.emitPending(r, state.fpChanged === true);
          return;
        }
        r.knownDevices.set(fp, {
          fp,
          name: state.guestName ?? "guest",
          ...(state.userId ? { userId: state.userId } : {}),
        });
        this.persist(r);
      }
      const kid = randomBytes(8).toString("base64url");
      const conn = new RoomConnection({
        ws,
        kid,
        key: state.key,
        selfFp: r.hostFingerprint,
        peerFp: fp,
        encrypt: r.encrypt,
      });
      r.connections.set(ws, conn);
      conn.onFrame((frame) => this.handleGuestFrame(r, ws, frame));
      this.metrics.record({ type: "handshake", reason: "ok" });
      ws.send(
        JSON.stringify(makeHandshake("ok", { kid, encrypt: r.encrypt })),
      );
      ctl.upgrade();
      return;
    }
  }

  /** Host approves a pending device: completes the handshake on its socket. */
  approveDevice(
    roomId: string,
    fingerprint: string,
  ): { ok: boolean; error?: string } {
    const r = this.hostRoom(roomId);
    if (!r.ok) return r;
    const rec = r.room;
    const entry = rec.pendingByFp.get(fingerprint);
    if (!entry) return { ok: false, error: "该设备不在待审批列表中" };
    clearTimeout(entry.timer);
    rec.pendingByFp.delete(fingerprint);
    if (entry.ws.readyState !== WebSocket.OPEN) {
      this.emitPending(rec);
      return { ok: false, error: "该设备已断开连接" };
    }
    // Fingerprint change: replace the user's previous device record.
    if (entry.userId) {
      for (const [oldFp, d] of rec.knownDevices) {
        if (d.userId === entry.userId && oldFp !== fingerprint) {
          rec.knownDevices.delete(oldFp);
        }
      }
    }
    rec.knownDevices.set(fingerprint, {
      fp: fingerprint,
      name: entry.name,
      ...(entry.userId ? { userId: entry.userId } : {}),
    });
    const kid = randomBytes(8).toString("base64url");
    const conn = new RoomConnection({
      ws: entry.ws,
      kid,
      key: entry.key,
      selfFp: rec.hostFingerprint,
      peerFp: fingerprint,
      encrypt: rec.encrypt,
    });
    rec.connections.set(entry.ws, conn);
    conn.onFrame((frame) => this.handleGuestFrame(rec, entry.ws, frame));
    this.metrics.record({ type: "handshake", reason: "ok" });
    try {
      entry.ws.send(
        JSON.stringify(makeHandshake("ok", { kid, encrypt: rec.encrypt })),
      );
    } catch (err) {
      rec.connections.delete(entry.ws);
      rec.knownDevices.delete(fingerprint);
      try {
        conn.close();
      } catch {
        // ignore
      }
      this.emitPending(rec);
      return {
        ok: false,
        error:
          err instanceof Error
            ? `批准失败：${err.message}`
            : "批准失败：无法通知该设备",
      };
    }
    entry.upgrade();
    this.emitPending(rec);
    this.persist(rec);
    return { ok: true };
  }

  /** Host denies a pending device: hs.reject denied + close. */
  denyDevice(
    roomId: string,
    fingerprint: string,
  ): { ok: boolean; error?: string } {
    const r = this.hostRoom(roomId);
    if (!r.ok) return r;
    const rec = r.room;
    const entry = rec.pendingByFp.get(fingerprint);
    if (!entry) return { ok: false, error: "该设备不在待审批列表中" };
    clearTimeout(entry.timer);
    rec.pendingByFp.delete(fingerprint);
    this.metrics.record({ type: "handshake", reason: HandshakeReject.denied });
    try {
      entry.ws.send(
        JSON.stringify(
          makeHandshake("reject", { reason: HandshakeReject.denied }),
        ),
      );
    } catch {
      // ignore
    }
    try {
      entry.ws.close();
    } catch {
      // ignore
    }
    this.emitPending(rec);
    return { ok: true };
  }

  /**
   * Host kicks a member: send kick frame, drop the connection (session key
   * dies with it), blacklist the device fingerprint. Reconnecting with the
   * old invite gets hs.reject { reason: "blacklist" }.
   */
  kick(roomId: string, userId: string): { ok: boolean; error?: string } {
    const rec0 = this.rooms.get(roomId);
    if (!rec0 || rec0.status !== "open") return { ok: false, error: "群聊不可用" };
    if (rec0.localRole !== "host") {
      if (
        !canKickMember(
          this.memberRole(rec0, rec0.localUserId),
          rec0.members.find((m) => m.userId === userId)?.role,
        )
      ) {
        return { ok: false, error: "没有权限踢人" };
      }
      this.sendClient(rec0, "member.kick", {
        userId,
      } satisfies RoomMemberKickPayload);
      return { ok: true };
    }
    return this.kickOnHost(rec0, rec0.localUserId, userId);
  }

  private kickOnHost(
    rec: RoomRecord,
    actorUserId: string,
    userId: string,
  ): { ok: boolean; error?: string } {
    const actorRole = this.memberRole(rec, actorUserId);
    const targetRole = rec.members.find((m) => m.userId === userId)?.role;
    if (!canKickMember(actorRole, targetRole)) {
      return { ok: false, error: "没有权限踢人" };
    }
    if (userId === rec.hostUserId) {
      return { ok: false, error: "不能踢出群主" };
    }
    let target: WebSocket | null = null;
    for (const g of rec.guests) {
      if ((g as GuestWs).userId === userId) {
        target = g;
        break;
      }
    }
    if (!target) return { ok: false, error: "成员不在线" };
    const conn = rec.connections.get(target);
    const fp = conn?.peerFp;
    if (fp) {
      rec.blacklist.add(fp);
      rec.knownDevices.delete(fp);
      const pending = rec.pendingByFp.get(fp);
      if (pending) {
        clearTimeout(pending.timer);
        rec.pendingByFp.delete(fp);
      }
    }
    rec.guests.delete(target);
    rec.connections.delete(target);
    if (conn) {
      conn.trySendFrame(
        makeRoomFrame(rec.roomId, ++rec.seq, "kick", {
          userId,
          message: "你已被移出群聊",
        }),
      );
      conn.close();
    } else {
      try {
        target.close();
      } catch {
        // ignore
      }
    }
    const name =
      rec.members.find((m) => m.userId === userId)?.name ?? userId;
    rec.members = rec.members.filter((m) => m.userId !== userId);
    rec.seats = rec.seats.filter(
      (s) => !(s.kind === "human" && s.occupantUserId === userId),
    );
    this.unbindMemberFromSeats(rec, userId);
    const by = actorRole === "admin" ? "管理员" : "群主";
    this.append(rec, {
      kind: "system",
      text: `${name} 已被${by}移出并拉黑`,
      authorLabel: "系统",
    });
    this.pushState(rec);
    return { ok: true };
  }

  /** Host renames the room; name rides the snapshot to every member. */
  rename(
    roomId: string,
    name: string,
  ): { ok: boolean; room?: RoomSnapshot; error?: string } {
    const r = this.hostRoom(roomId);
    if (!r.ok) return r;
    const rec = r.room;
    const next = name.trim().slice(0, 40);
    if (!next) return { ok: false, error: "群聊名不能为空" };
    if (next === rec.name) return { ok: true, room: this.snapshot(rec) };
    const old = rec.name;
    rec.name = next;
    this.append(rec, {
      kind: "system",
      text: `群聊名称由「${old}」修改为「${next}」`,
      authorLabel: "系统",
    });
    this.pushState(rec);
    return { ok: true, room: this.snapshot(rec) };
  }

  /**
   * 撤回一条消息：作者本人可撤自己的，房主可撤任何人的。
   * 房主直接本地生效；客人发 chat.recall 帧，由房主校验后广播。
   */
  recall(roomId: string, itemId: string): { ok: boolean; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    const item = r.items.find((i) => i.id === itemId);
    if (!item) return { ok: false, error: "消息不存在" };
    if (item.recalled) return { ok: true };
    if (r.localRole !== "host") {
      if (item.authorUserId !== r.localUserId) {
        return { ok: false, error: "只能撤回自己的消息" };
      }
      if (!r.client || r.client.readyState !== WebSocket.OPEN) {
        return { ok: false, error: "尚未连上主机，请等重连完成后再试" };
      }
      this.sendClient(r, "chat.recall", {
        itemId,
      } satisfies RoomChatRecallPayload);
      return { ok: true };
    }
    this.applyRecall(r, itemId);
    return { ok: true };
  }

  /** 标记撤回：清空正文与引用（不留在存储/快照里），各端渲染占位。 */
  private applyRecall(r: RoomRecord, itemId: string): void {
    const item = r.items.find((i) => i.id === itemId);
    if (!item || item.recalled) return;
    item.recalled = true;
    item.text = "";
    delete item.quote;
    delete item.game;
    this.persist(r);
    this.pushState(r);
  }

  /**
   * 停止某个 Agent 席位正在跑的输出（@agent /stop）。
   * 房主直接本地生效；客人发 seat.stop 帧由房主执行。
   */
  stopSeat(roomId: string, seatId: string): { ok: boolean; error?: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    const seat = r.seats.find((s) => s.id === seatId);
    if (!seat || seat.kind !== "agent") {
      return { ok: false, error: "席位不存在或不是 Agent" };
    }
    if (r.localRole !== "host") {
      if (!r.client || r.client.readyState !== WebSocket.OPEN) {
        return { ok: false, error: "尚未连上主机，请等重连完成后再试" };
      }
      this.sendClient(r, "seat.stop", { seatId } satisfies RoomSeatStopPayload);
      return { ok: true };
    }
    this.applySeatStop(r, seatId, r.localUserId);
    return { ok: true };
  }

  /** 房主侧执行停止：本机席位直接 abort 会话，远程席位中止节点上的轮次。 */
  private applySeatStop(
    r: RoomRecord,
    seatId: string,
    byUserId: string,
  ): void {
    const seat = r.seats.find((s) => s.id === seatId);
    if (!seat || seat.kind !== "agent") return;
    if (!seat.running) return; // 幂等：没在跑就当成功
    const who = this.memberName(r, byUserId);
    if (this.seatExecutor(r, seat)) {
      this.abortRemoteTurnsForSeat(r, seat.id, `「${who}」停止了输出`);
    } else if (seat.sessionId) {
      try {
        this.sessions.abort(seat.sessionId);
      } catch {
        // ignore
      }
    }
    seat.running = false;
    r.liveExec?.delete(`local-${seat.id}`);
    this.append(r, {
      kind: "system",
      seatId: seat.id,
      text: `「${who}」停止了「${seat.name}」的输出`,
      authorLabel: "系统",
    });
    this.pushState(r);
  }

  /** Host: devices waiting for approval. */
  pendingDevices(roomId: string): {
    ok: boolean;
    pending: Array<{ fp: string; name: string }>;
  } {
    const r = this.hostRoom(roomId);
    if (!r.ok) return { ok: false, pending: [] };
    return {
      ok: true,
      pending: [...r.room.pendingByFp.entries()].map(([fp, e]) => ({
        fp,
        name: e.name,
      })),
    };
  }

  /** Push the approval queue to the renderer (host side only). */
  private emitPending(r: RoomRecord, fingerprintChanged?: boolean): void {
    if (r.localRole !== "host") return;
    this.safeSend(IPC.roomEvent, {
      roomId: r.roomId,
      pending: [...r.pendingByFp.entries()].map(([fp, e]) => ({
        fp,
        name: e.name,
      })),
      ...(fingerprintChanged ? { fingerprintChanged: true } : {}),
    });
  }

  /** Reject and close every pending handshake socket (room end / dispose). */
  private denyAllPending(r: RoomRecord): void {
    for (const entry of r.pendingByFp.values()) {
      clearTimeout(entry.timer);
      try {
        entry.ws.send(
          JSON.stringify(
            makeHandshake("reject", { reason: HandshakeReject.denied }),
          ),
        );
      } catch {
        // ignore
      }
      try {
        entry.ws.close();
      } catch {
        // ignore
      }
    }
    r.pendingByFp.clear();
  }

  /**
   * Guest side of the HMAC handshake: hello → challenge → prove → ok.
   * On ok the socket is already wrapped in a RoomConnection (handed back to
   * the caller, which then sends the join frame through it).
   * hs.pending (host approval) extends the wait to 60s (task 8).
   */
  private handshakeAsGuest(
    ws: WebSocket,
    opts: { password: string; name: string; hostFingerprint?: string; userId?: string },
  ): Promise<
    | { ok: true; conn: RoomConnection; hostFp: string; encrypt: boolean }
    | { ok: false; error: string }
  > {
    return new Promise((resolve) => {
      let settled = false;
      let pending: { key: Buffer; hostFp: string } | null = null;
      const stopHeartbeat = startWsHeartbeat(ws);
      const finish = (
        v:
          | { ok: true; conn: RoomConnection; hostFp: string; encrypt: boolean }
          | { ok: false; error: string },
      ) => {
        if (settled) return;
        settled = true;
        stopHeartbeat();
        if (timer) clearTimeout(timer);
        ws.off("message", onMsg);
        ws.off("close", onClose);
        resolve(v);
      };
      const armTimer = (ms: number, error: string) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          this.metrics.record({
            type: "handshake",
            reason: HandshakeReject.timeout,
          });
          finish({ ok: false, error });
        }, ms);
      };
      // First wait is longer than the prove-phase timeout: hello is sent
      // the moment the guest socket opens, but a relay may still be pairing
      // the work channel (up to 10s) before hs.challenge can come back.
      let timer: ReturnType<typeof setTimeout> | undefined;
      armTimer(this.handshakeOpenTimeoutMs, "握手超时");
      const onMsg = (data: RawData) => {
        const pdu = parsePdu(String(data));
        if (!pdu || pdu.kind !== "hs") return;
        const hs = pdu.hs;
        if (hs.type === "challenge") {
          armTimer(this.handshakeTimeoutMs, "握手超时");
          const p = hs.payload as {
            pub?: string;
            fp?: string;
            nonce?: string;
            encrypt?: boolean;
          };
          const hostFp = String(p.fp ?? "");
          if (
            opts.hostFingerprint &&
            hostFp &&
            opts.hostFingerprint !== hostFp
          ) {
            finish({
              ok: false,
              error: "主机指纹与邀请码不匹配，可能连到了错误的主机",
            });
            return;
          }
          let key: Buffer;
          try {
            key = deriveSessionKey(
              this.deviceKeys,
              Buffer.from(String(p.pub ?? ""), "base64url"),
            );
          } catch {
            finish({ ok: false, error: "握手失败：主机公钥无效" });
            return;
          }
          pending = { key, hostFp };
          const proof = provePassword({
            password: opts.password,
            nonce: Buffer.from(String(p.nonce ?? ""), "base64url"),
            hostFp,
            guestFp: this.deviceFp,
            ecdhSs: key,
          });
          try {
            ws.send(JSON.stringify(makeHandshake("prove", { proof })));
          } catch {
            finish({ ok: false, error: "握手失败：无法发送证明" });
          }
          return;
        }
        if (hs.type === "ok") {
          const p = hs.payload as { kid?: string; encrypt?: boolean };
          if (!pending || !p.kid) {
            finish({ ok: false, error: "握手时序错误" });
            return;
          }
          const conn = new RoomConnection({
            ws,
            kid: p.kid,
            key: pending.key,
            selfFp: this.deviceFp,
            peerFp: pending.hostFp,
            encrypt: p.encrypt !== false,
          });
          this.metrics.record({ type: "handshake", reason: "ok" });
          finish({
            ok: true,
            conn,
            hostFp: pending.hostFp,
            encrypt: p.encrypt !== false,
          });
          return;
        }
        if (hs.type === "reject") {
          const reason = (hs.payload as { reason?: string })?.reason;
          if (isHandshakeReason(reason)) {
            this.metrics.record({ type: "handshake", reason });
          }
          finish({ ok: false, error: handshakeRejectMessage(reason) });
          return;
        }
        if (hs.type === "pending") {
          // Host is holding us for approval — wait up to 60s for hs.ok.
          armTimer(60_000, "等待群主审批超时（60 秒），请稍后再试");
          this.safeSend(IPC.roomEvent, {
            roomId: "",
            joining: "pending-approval",
          });
          return;
        }
      };
      const onClose = () => finish({ ok: false, error: "连接被关闭" });
      ws.on("message", onMsg);
      ws.on("close", onClose);
      try {
        ws.send(
          JSON.stringify(
            makeHandshake("hello", {
              pub: this.deviceKeys.publicRaw.toString("base64url"),
              fp: this.deviceFp,
              name: opts.name,
              ...(opts.userId ? { userId: opts.userId } : {}),
            }),
          ),
        );
      } catch (err) {
        finish({
          ok: false,
          error: `握手失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  private handleGuestFrame(r: RoomRecord, ws: WebSocket, frame: RoomFrame) {
    // Task 14 abuse guards, charged to the connection's bucket (spec §9).
    // parseRoomFrame does not validate `type` against the union, so a
    // hand-crafted frame can carry any string here — ignore unknown types
    // without touching room state.
    if (!KNOWN_ROOM_FRAME_TYPES.has(frame.type)) {
      chargeAbuse((ws as GuestWs).guard);
      return;
    }
    // join / hello / mod.fetch legitimately carry roomId "pending" before the
    // guest knows the real id; every other frame must name this room.
    if (
      frame.type !== "join" &&
      frame.type !== "hello" &&
      frame.type !== "mod.fetch" &&
      frame.roomId !== r.roomId
    ) {
      chargeAbuse((ws as GuestWs).guard);
      return;
    }
    if (r.status !== "open") {
      this.reply(ws, r, "error", { message: "群聊已结束" });
      return;
    }
    if (frame.type === "hello") {
      this.reply(ws, r, "mod.offer", this.buildOffer(r));
      return;
    }
    if (frame.type === "mod.fetch") {
      void this.serveModBundle(r, ws as GuestWs, frame);
      return;
    }
    if (frame.type === "join") {
      const p = frame.payload as {
        userId?: string;
        name?: string;
        protocol?: number;
        modChecksum?: string;
        projectPath?: string | null;
      };
      if (p.protocol !== ROOM_PROTOCOL_VERSION) {
        this.reply(ws, r, "error", { message: "协议版本不兼容" });
        ws.close();
        return;
      }
      // The password is proven by the HMAC handshake (hs.prove), never by
      // the join payload.
      if (r.modChecksum && p.modChecksum !== r.modChecksum) {
        this.reply(ws, r, "error", { message: "模组校验码不一致" });
        ws.close();
        return;
      }
      const userId = p.userId || randomUUID();
      const name = (p.name ?? "guest").trim() || "guest";
      const projectPath =
        typeof p.projectPath === "string" && p.projectPath.trim()
          ? p.projectPath
          : null;
      const existing = r.members.find((m) => m.userId === userId);
      const rejoining = Boolean(existing);
      if (existing) {
        existing.projectPath = projectPath;
        existing.name = name || existing.name;
        existing.online = true;
      } else {
        r.members.push({
          userId,
          name,
          role: "member",
          online: true,
          projectPath,
        });
      }
      if (!r.seats.some((s) => s.kind === "human" && s.occupantUserId === userId)) {
        r.seats.push({
          id: randomUUID(),
          kind: "human",
          name,
          occupantUserId: userId,
          takenOverBy: null,
          sessionId: null,
          running: false,
          agentName: null,
        });
      }
      // 同一人重连：关掉旧 socket，避免幽灵在线。
      for (const old of [...r.guests]) {
        if (old !== ws && (old as GuestWs).userId === userId) {
          r.guests.delete(old);
          r.connections.delete(old);
          try {
            old.close();
          } catch {
            // ignore
          }
        }
      }
      r.guests.add(ws);
      (ws as GuestWs).userId = userId;
      this.append(r, {
        kind: "system",
        text: rejoining ? `${name} 已重新连接` : `${name} 加入了群聊`,
        authorLabel: "系统",
      });
      this.reply(ws, r, "welcome", this.snapshot(r));
      this.sendModViewsTo(r, ws, userId);
      this.pushState(r);
      if (r.modHost && r.modStarted && !r.modEnded) {
        void this.publishViews(r);
      }
      return;
    }

    const userId = (ws as GuestWs).userId;
    if (!userId) {
      this.reply(ws, r, "error", { message: "请先加入" });
      return;
    }

    if (frame.type === "leave") {
      this.removeGuestMember(r, userId);
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }

    if (frame.type === "node.info") {
      const p = frame.payload as RoomNodeInfoPayload | undefined;
      const projectPath =
        typeof p?.projectPath === "string" && p.projectPath.trim()
          ? p.projectPath
          : null;
      const m = r.members.find((mm) => mm.userId === userId);
      if (m && m.projectPath !== projectPath) {
        m.projectPath = projectPath;
        this.pushState(r);
      }
      return;
    }

    if (frame.type === "mod.intent") {
      const p = frame.payload as {
        seatId?: string;
        name?: string;
        payload?: unknown;
      };
      const seat = r.seats.find((s) => s.id === p.seatId);
      const intentName = p.name;
      if (!seat || !intentName) {
        this.reply(ws, r, "error", { message: "请先选一个席位" });
        return;
      }
      if (!this.canAct(seat, userId)) {
        this.reply(ws, r, "error", { message: "当前不能操作这个席位" });
        return;
      }
      if (!r.modHost || !r.modStarted || r.modEnded) {
        this.reply(ws, r, "error", { message: "玩法未开始" });
        return;
      }
      if (r.modFail) {
        this.reply(ws, r, "error", { message: r.modFail });
        return;
      }
      void this.enqueueIntent(r, () =>
        this.dispatchMod(r, {
          seatId: seat.id,
          name: intentName,
          payload: p.payload,
          actorUserId: userId,
        }),
      );
      return;
    }

    if (frame.type === "chat.user") {
      const p = frame.payload as {
        seatId?: string;
        text?: string;
        quote?: RoomQuoteRef;
      };
      const seat = r.seats.find((s) => s.id === p.seatId);
      const text = (p.text ?? "").trim();
      if (!seat || !text) {
        this.reply(ws, r, "error", { message: "请先选一个席位" });
        return;
      }
      const taken = seat.takenOverBy === userId;
      const ownHuman = seat.kind === "human" && seat.occupantUserId === userId;
      const toAgent = seat.kind === "agent" && !seat.takenOverBy;
      if (!taken && !ownHuman && !toAgent) {
        this.reply(ws, r, "error", {
          message: "当前不能在这个席位发言（选自己的人席，或先接管 Agent）",
        });
        return;
      }
      void this.enqueueInbound(r, () =>
        this.ingestUserChat(
          r,
          {
            roomId: r.roomId,
            seatId: seat.id,
            authorUserId: userId,
            authorLabel: this.memberName(r, userId),
            text,
            at: Date.now(),
            ...(p.quote ? { quote: p.quote } : {}),
          },
          { runAgent: toAgent },
        ),
      );
      return;
    }

    if (frame.type === "chat.recall") {
      const p = frame.payload as RoomChatRecallPayload | undefined;
      const itemId = typeof p?.itemId === "string" ? p.itemId : "";
      if (!itemId) return;
      // 客人只能撤回自己的消息（房主可撤任何人的，走本地 recall()）
      const item = r.items.find((i) => i.id === itemId);
      if (!item || item.recalled) return;
      if (item.authorUserId !== userId) {
        this.reply(ws, r, "error", { message: "只能撤回自己的消息" });
        return;
      }
      this.applyRecall(r, itemId);
      return;
    }

    if (frame.type === "seat.stop") {
      const p = frame.payload as RoomSeatStopPayload | undefined;
      const seatId = typeof p?.seatId === "string" ? p.seatId : "";
      if (!seatId) return;
      // 群聊里任何成员都可以喊停一个 Agent 席位（停止 ≠ 改配置）。
      this.applySeatStop(r, seatId, userId);
      return;
    }

    if (frame.type === "seat.takeover") {
      const p = frame.payload as { seatId?: string };
      const seat = r.seats.find((s) => s.id === p.seatId);
      if (!seat || seat.kind !== "agent") return;
      seat.takenOverBy = userId;
      this.abortRemoteTurnsForSeat(r, seat.id, "席位被接管");
      if (seat.sessionId) {
        try {
          this.sessions.abort(seat.sessionId);
        } catch {
          // ignore
        }
        seat.running = false;
      }
      this.append(r, {
        kind: "system",
        seatId: seat.id,
        text: `${this.memberName(r, userId)} 接管了「${seat.name}」`,
        authorLabel: "系统",
      });
      this.pushState(r);
      return;
    }

    if (frame.type === "seat.add") {
      const p = frame.payload as {
        kind?: RoomSeatKind;
        name?: string;
        agentName?: string;
        userId?: string;
        agentPrompt?: string;
        skillNames?: string[];
        model?: string;
        executorUserId?: string;
        aiUserId?: string;
        workspaceUserId?: string;
      };
      if (!p.userId) return;
      this.addSeatForMember(
        r,
        p.userId,
        p.kind === "agent" ? "agent" : "human",
        typeof p.name === "string" ? p.name : "",
        typeof p.agentName === "string" ? p.agentName : undefined,
        {
          agentPrompt:
            typeof p.agentPrompt === "string" ? p.agentPrompt : undefined,
          skillNames: Array.isArray(p.skillNames)
            ? p.skillNames.filter((s): s is string => typeof s === "string")
            : undefined,
          model: typeof p.model === "string" ? p.model : undefined,
          executorUserId:
            typeof p.executorUserId === "string" ? p.executorUserId : undefined,
          aiUserId: typeof p.aiUserId === "string" ? p.aiUserId : undefined,
          workspaceUserId:
            typeof p.workspaceUserId === "string" ? p.workspaceUserId : undefined,
        },
      );
      return;
    }

    if (frame.type === "seat.update") {
      if (!canManageSeats(this.memberRole(r, userId))) {
        this.reply(ws, r, "error", { message: "没有权限改席位" });
        return;
      }
      const p = frame.payload as RoomSeatUpdatePayload;
      if (!p?.seatId) return;
      this.updateSeat(r.roomId, p.seatId, p);
      return;
    }

    if (frame.type === "member.kick") {
      const p = frame.payload as RoomMemberKickPayload;
      if (!p?.userId) return;
      const res = this.kickOnHost(r, userId, p.userId);
      if (!res.ok && res.error) {
        this.reply(ws, r, "error", { message: res.error });
      }
      return;
    }

    if (frame.type === "file.policy") {
      const p = frame.payload as RoomFilePolicyPayload;
      if (p?.policy !== "allow" && p?.policy !== "ask" && p?.policy !== "deny") {
        return;
      }
      const m = r.members.find((mm) => mm.userId === userId);
      if (m) {
        m.filePolicy = p.policy;
        this.pushState(r);
      }
      return;
    }

    if (frame.type === "ai.share") {
      const p = frame.payload as RoomAiSharePayload;
      this.applyAiShare(
        r,
        userId,
        Boolean(p?.on),
        Array.isArray(p?.models)
          ? p.models.filter((s): s is string => typeof s === "string").slice(0, 64)
          : undefined,
      );
      this.pushState(r);
      return;
    }

    if (frame.type === "ai.ask") {
      if (!canManageSeats(this.memberRole(r, userId))) {
        this.reply(ws, r, "error", { message: "没有权限请求借用 AI" });
        return;
      }
      const p = frame.payload as RoomAiAskPayload;
      if (!p?.targetUserId) return;
      this.applyAiAsk(r, userId, p.targetUserId);
      return;
    }

    if (frame.type === "ai.http") {
      this.onAiHttp(r, userId, frame.payload as RoomAiHttpPayload);
      return;
    }

    if (frame.type === "exec.event") {
      this.onNodeExecEvent(r, userId, frame.payload as RoomExecEventPayload);
      return;
    }

    if (frame.type === "exec.result") {
      this.onNodeExecResult(r, userId, frame.payload as RoomExecResultPayload);
      return;
    }

    if (frame.type === "game.dice") {
      const p = frame.payload as {
        seatId?: string;
        userId?: string;
        value?: string;
      };
      const seat = r.seats.find((s) => s.id === p.seatId);
      if (!seat || !p.userId) return;
      const value = p.value ?? String(Math.floor(Math.random() * 6) + 1);
      const faces = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
      const face = faces[Number(value) - 1] ?? value;
      this.append(r, {
        kind: "game",
        seatId: seat.id,
        authorUserId: p.userId,
        authorLabel: this.memberName(r, p.userId),
        text: `${face} 掷出 ${value} 点`,
        game: { type: "dice", value: face },
      });
      this.pushState(r);
      return;
    }

    if (frame.type === "game.rps") {
      const p = frame.payload as {
        seatId?: string;
        userId?: string;
        hand?: string;
      };
      const seat = r.seats.find((s) => s.id === p.seatId);
      if (!seat || !p.userId || !p.hand) return;
      const label =
        p.hand === "rock"
          ? "✊ 石头"
          : p.hand === "scissors"
            ? "✌️ 剪刀"
            : "✋ 布";
      this.append(r, {
        kind: "game",
        seatId: seat.id,
        authorUserId: p.userId,
        authorLabel: this.memberName(r, p.userId),
        text: `出 ${label}`,
        game: { type: "rps", value: label },
      });
      this.pushState(r);
      return;
    }

    if (frame.type === "seat.return") {
      const p = frame.payload as { seatId?: string };
      const seat = r.seats.find((s) => s.id === p.seatId);
      if (!seat) return;
      if (seat.takenOverBy !== userId) return;
      seat.takenOverBy = null;
      this.append(r, {
        kind: "system",
        seatId: seat.id,
        text: `${this.memberName(r, userId)} 交还了「${seat.name}」`,
        authorLabel: "系统",
      });
      this.pushState(r);
    }
  }

  private append(
    r: RoomRecord,
    item: Partial<RoomTimelineItem> & { kind: RoomTimelineItem["kind"]; text: string },
  ) {
    r.items.push({
      id: randomUUID(),
      at: Date.now(),
      seatId: item.seatId ?? "",
      authorUserId: item.authorUserId ?? null,
      authorLabel: item.authorLabel ?? "系统",
      kind: item.kind,
      text: item.text,
      ...(item.source ? { source: item.source } : {}),
      ...(item.game ? { game: item.game } : {}),
      ...(item.quote ? { quote: item.quote } : {}),
    });
    if (r.items.length > 400) r.items.splice(0, r.items.length - 400);
    this.persist(r);
  }

  private persist(r: RoomRecord): void {
    if (!this.archive) return;
    try {
      const stored: StoredRoom = {
        roomId: r.roomId,
        name: r.name,
        status: r.status,
        role: r.localRole,
        port: r.port,
        inviteHost: r.joinInfo?.host || lanAddress(),
        memberCount: r.members.length,
        updatedAt: Date.now(),
        items: r.items,
        seats: r.seats,
        members: r.members,
        autoApprove: r.autoApprove,
        hasPassword: Boolean(r.password),
        encrypt: r.encrypt,
        hostFingerprint: r.hostFingerprint || undefined,
        requireMods: r.requireMods,
        modChecksum: r.modChecksum,
        hostLabel: r.hostLabel,
        localUserId: r.localUserId || undefined,
        // Host-side secrets/public paths for resume-hosting after a restart
        // (guest rooms carry their rejoin data under join.* instead).
        ...(r.localRole === "host" && r.password
          ? { password: r.password }
          : {}),
        ...(r.publicWss ? { publicWss: r.publicWss } : {}),
        ...(r.tunnelWanted ? { tunnel: true } : {}),
        ...(r.relayAddr ? { relay: r.relayAddr } : {}),
        ...(r.relayToken ? { relayToken: r.relayToken } : {}),
        ...(r.relayRoomId ? { relayRoomId: r.relayRoomId } : {}),
        ...(r.localRole === "host" && r.knownDevices.size
          ? { knownDevices: [...r.knownDevices.values()] }
          : {}),
        ...(r.localRole === "host" && r.blacklist.size
          ? { blacklist: [...r.blacklist] }
          : {}),
        ...(r.offline ? { offline: true } : {}),
        ...(r.joinInfo
          ? {
              join: {
                host: r.joinInfo.host,
                hosts: r.joinInfo.hosts,
                port: r.joinInfo.port,
                password: r.joinInfo.password,
                modChecksum: r.joinInfo.modChecksum,
                secret: r.joinInfo.secret,
                hostFingerprint: r.joinInfo.hostFingerprint,
                wss: r.joinInfo.wss,
              },
            }
          : {}),
      };
      this.archive.saveRoom(stored);
    } catch {
      // non-fatal
    }
  }

  private memberName(r: RoomRecord, userId: string): string {
    return r.members.find((m) => m.userId === userId)?.name ?? "成员";
  }

  /** 客人 socket 断开：人还在名单里，只标离线。主动退出走 removeGuestMember。 */
  private markMemberOffline(r: RoomRecord, userId?: string): void {
    if (!userId) return;
    const m = r.members.find((mm) => mm.userId === userId);
    if (!m || m.role === "host") return;
    const wasOnline = m.online !== false;
    m.online = false;
    if (wasOnline) {
      this.append(r, {
        kind: "system",
        text: `${m.name} 已离线`,
        authorLabel: "系统",
      });
    }
    this.pushState(r);
  }

  private removeGuestMember(r: RoomRecord, userId: string): void {
    const m = r.members.find((mm) => mm.userId === userId);
    if (!m || m.role === "host") return;
    const name = m.name;
    r.members = r.members.filter((mm) => mm.userId !== userId);
    r.seats = r.seats.filter(
      (s) => !(s.kind === "human" && s.occupantUserId === userId),
    );
    this.unbindMemberFromSeats(r, userId);
    this.append(r, {
      kind: "system",
      text: `${name} 退出了群聊`,
      authorLabel: "系统",
    });
    this.pushState(r);
  }

  /**
   * 成员被移除（踢出/退出）后，清掉席位上挂着他的引用：接管标记直接释放；
   * Agent 席位的 文件/AI/执行 绑定置空，resolveWorkspaceUserId /
   * resolveAiUserId 的缺省链会回落到房主。只清引用，席位本身保留。
   */
  private unbindMemberFromSeats(r: RoomRecord, userId: string): void {
    for (const seat of r.seats) {
      if (seat.takenOverBy === userId) seat.takenOverBy = null;
      if (seat.kind !== "agent") continue;
      if (seat.workspaceUserId === userId) seat.workspaceUserId = null;
      if (seat.executorUserId === userId) seat.executorUserId = null;
      if (seat.aiUserId === userId) seat.aiUserId = null;
    }
  }

  private snapshot(r: RoomRecord): RoomSnapshot {
    return {
      roomId: r.roomId,
      name: r.name,
      status: r.status,
      port: r.port,
      hostLabel: r.hostLabel,
      inviteHost: lanAddress(),
      memberCount: r.members.length,
      onlineCount: countOnlineMembers(r.members),
      requireMods: r.requireMods,
      modChecksum: r.modChecksum,
      autoApprove: r.autoApprove,
      hasPassword: Boolean(r.password),
      encrypt: r.encrypt,
      hostFingerprint: r.hostFingerprint || undefined,
      members: r.members,
      seats: r.seats,
      items: r.items,
      ...(r.liveExec?.size
        ? { liveExec: [...r.liveExec.values()] }
        : {}),
      ...(r.remoteChanges && Object.keys(r.remoteChanges).length
        ? { remoteChanges: r.remoteChanges }
        : {}),
      localUserId: r.localUserId || undefined,
      kernel: r.localRole === "host" ? this.kernelProjection(r) : r.kernelProjection,
    };
  }

  private kernelProjection(r: RoomRecord): RoomSnapshot["kernel"] {
    if (!r.kernel) return undefined;
    const names = new Map((r.kernelPacks ?? []).map((p) => [p.manifest.id, p.manifest.name]));
    const graph = r.kernel.snapshot();
    const mods = [...graph.active, ...graph.pending, ...graph.failed].map((m) => ({
      id: m.id,
      name: names.get(m.id) ?? m.id,
      version: m.version,
      state: m.state,
      ...(m.pendingReason ? { pendingReason: m.pendingReason } : {}),
      ...(m.failedReason ? { failedReason: m.failedReason } : {}),
    }));
    return { mods };
  }

  private pushState(r: RoomRecord) {
    this.persist(r);
    this.broadcast(r, "state.snapshot", this.snapshot(r));
    this.emit(r);
  }

  /** 轻量广播：实时进度这类易失状态的推送不落盘。 */
  private pushLive(r: RoomRecord) {
    this.broadcast(r, "state.snapshot", this.snapshot(r));
    this.emit(r);
  }

  private broadcast(r: RoomRecord, type: RoomFrame["type"], payload: unknown) {
    r.seq += 1;
    const frame = makeRoomFrame(r.roomId, r.seq, type, payload);
    // Fan-out byte counter (task 12): cleartext frame size × recipients; the
    // AEAD envelope overhead per send is not counted.
    const raw = JSON.stringify(frame);
    let sent = 0;
    for (const g of r.guests) {
      const conn = r.connections.get(g);
      if (conn) {
        if (conn.trySendFrame(frame)) sent += 1;
        continue;
      }
      // No connection: only possible for legacy plaintext (skip-encrypt) guests.
      if (g.readyState === WebSocket.OPEN) {
        g.send(raw);
        sent += 1;
      }
    }
    if (sent > 0) {
      this.metrics.record({
        type: "fanout",
        bytes: Buffer.byteLength(raw) * sent,
      });
    }
  }

  private reply(
    ws: WebSocket,
    r: RoomRecord,
    type: RoomFrame["type"],
    payload: unknown,
  ) {
    r.seq += 1;
    const frame = makeRoomFrame(r.roomId, r.seq, type, payload);
    const conn = r.connections.get(ws);
    if (conn) {
      conn.trySendFrame(frame);
      return;
    }
    // No connection (peek / legacy plaintext): answer in cleartext.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  private sendClient(r: RoomRecord, type: RoomFrame["type"], payload: unknown) {
    if (!r.client || r.client.readyState !== WebSocket.OPEN) return;
    r.seq += 1;
    const frame = makeRoomFrame(r.roomId, r.seq, type, payload);
    const conn = r.connections.get(r.client);
    if (conn) {
      conn.trySendFrame(frame);
      return;
    }
    r.client.send(JSON.stringify(frame));
  }

  /**
   * 本机项目路径变化（打开/切换项目）时上报：自己是房主就改自己的成员
   * 记录并广播快照；是客人就发 node.info 给房主，由房主记入成员列表后
   * 随快照流回各端。项目切换是低频用户动作，不做去重以外的节流。
   */
  reportLocalProject(projectPath: string | null): void {
    const normalized =
      typeof projectPath === "string" && projectPath.trim()
        ? projectPath
        : null;
    for (const r of this.rooms.values()) {
      if (r.status !== "open") continue;
      if (r.localRole === "host") {
        const self = r.members.find((m) => m.userId === r.localUserId);
        if (self && self.projectPath !== normalized) {
          self.projectPath = normalized;
          this.pushState(r);
        }
      } else {
        const mirror = r.members.find((m) => m.userId === r.localUserId);
        if (mirror && mirror.projectPath === normalized) continue;
        this.sendClient(r, "node.info", {
          projectPath: normalized,
        } satisfies RoomNodeInfoPayload);
      }
    }
  }

  private emit(r: RoomRecord) {
    const payload: {
      roomId: string;
      room: RoomSnapshot;
      mod?: {
        offer?: ModOfferPayload;
        publicView?: unknown;
        seatView?: unknown;
        seatViews?: Record<string, unknown>;
        seq?: number;
        fail?: string;
        actions?: Record<string, ModActionSchema>;
      };
    } = {
      roomId: r.roomId,
      room: this.snapshot(r),
    };
    const offer = r.modOffer ?? this.buildOffer(r);
    if (
      r.modChecksum ||
      offer.checksum ||
      r.modPublicView !== undefined ||
      r.modFail
    ) {
      const seatViews = this.localSeatViews(r);
      const preferredId = this.preferredSeatId(r, seatViews);
      payload.mod = {
        offer,
        publicView: r.modPublicView,
        seatView: preferredId ? seatViews[preferredId] : undefined,
        seatViews,
        seq: r.modSeq,
        ...(r.modFail ? { fail: r.modFail } : {}),
        ...(preferredId && r.modActionsBySeat?.[preferredId]
          ? { actions: r.modActionsBySeat[preferredId] }
          : {}),
      };
    }
    this.safeSend(IPC.roomEvent, payload);
  }

  private pushError(message: string) {
    this.safeSend(IPC.appError, { message });
  }

  private safeSend(channel: string, payload: unknown): void {
    // 分窗（独立群聊窗口）也要收到 room:event，否则只刷新主窗口。
    if (this.sendToAllWindows) {
      this.sendToAllWindows(channel, payload);
      return;
    }
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.send(channel, payload);
    } catch {
      // Renderer gone (reload/HMR) — ignore.
    }
  }

  private hostRoom(
    roomId: string,
  ): { ok: true; room: RoomRecord } | { ok: false; error: string } {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    if (r.localRole !== "host") return { ok: false, error: "只有群主可以操作" };
    return { ok: true, room: r };
  }

  private buildOffer(r: RoomRecord): ModOfferPayload {
    if (!r.modLoaded || !r.modChecksum) {
      return { id: "", name: "", version: "", checksum: "", size: 0 };
    }
    const size = Buffer.byteLength(
      JSON.stringify({
        manifest: r.modLoaded.manifestSource,
        hostJs: r.modLoaded.hostJsSource,
      }),
      "utf8",
    );
    return {
      id: r.modLoaded.manifest.id,
      name: r.modLoaded.manifest.name,
      version: r.modLoaded.manifest.version,
      checksum: r.modChecksum,
      size,
    };
  }

  private cachedOffer(host: string, port: number): ModOfferPayload | null {
    for (const r of this.rooms.values()) {
      if (r.status !== "open") continue;
      if (r.localRole === "host" && r.server && r.port === port) {
        if (host === "127.0.0.1" || host === "localhost" || host === lanAddress()) {
          return r.modOffer ?? this.buildOffer(r);
        }
      }
      if (r.localRole === "member" && r.modOffer && r.joinInfo?.port === port) {
        const hosts = [r.joinInfo.host, ...(r.joinInfo.hosts ?? [])];
        if (hosts.includes(host)) return r.modOffer;
      }
    }
    return null;
  }

  private normalizeHost(raw: string): string {
    let host = (raw ?? "").trim();
    host = host
      .replace(/^wss?:\/\//i, "")
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/^\[|\]$/g, "");
    if (host.includes(":") && !host.includes("::")) {
      const [h] = host.split(":");
      if (h) host = h;
    }
    return host;
  }

  private sendRaw(
    ws: WebSocket,
    roomId: string,
    seq: number,
    type: RoomFrame["type"],
    payload: unknown,
  ): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(makeRoomFrame(roomId, seq, type, payload)));
    }
  }

  private async withHostSocket<T>(
    urls: string[],
    fn: (ws: WebSocket) => Promise<T>,
  ): Promise<T | { ok: false; error: string }> {
    const winner = await this.raceCandidates(urls, 2_000);
    if (!winner) {
      return { ok: false, error: "无法连接主机" };
    }
    const ws = winner.ws;
    try {
      return await fn(ws);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  private async serveModBundle(
    r: RoomRecord,
    ws: GuestWs,
    frame: RoomFrame,
  ): Promise<void> {
    if (ws.fetching) {
      this.reply(ws, r, "error", { message: "已有下载进行中" });
      return;
    }
    const checksum = String(
      (frame.payload as { checksum?: string })?.checksum ?? "",
    );
    if (!r.modLoaded || !r.modChecksum) {
      this.reply(ws, r, "error", { message: "群聊未启用模组" });
      return;
    }
    if (!MOD_CHECKSUM_RE.test(checksum) || checksum !== r.modChecksum) {
      this.reply(ws, r, "error", { message: "模组校验码不一致" });
      return;
    }
    ws.fetching = true;
    try {
      const bytes = readModBytes(r.modLoaded);
      for (let offset = 0; offset < bytes.length; offset += ROOM_MOD_BUNDLE_CHUNK) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const slice = bytes.subarray(offset, offset + ROOM_MOD_BUNDLE_CHUNK);
        this.reply(ws, r, "mod.bundle", {
          checksum,
          offset,
          chunk: slice.toString("base64"),
        });
      }
    } catch (err) {
      this.reply(ws, r, "error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ws.fetching = false;
    }
  }

  private canAct(seat: RoomSeat, userId: string): boolean {
    if (seat.kind === "human") return seat.occupantUserId === userId;
    return seat.takenOverBy === userId;
  }

  private enqueueIntent<T>(
    r: RoomRecord,
    fn: () => Promise<T>,
  ): Promise<T> {
    const next = (r.intentChain ?? Promise.resolve()).then(fn, fn);
    r.intentChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async dispatchMod(
    r: RoomRecord,
    opts: {
      seatId: string;
      name: string;
      payload: unknown;
      actorUserId: string;
      after?: () => void;
      persist?: boolean;
    },
  ): Promise<{ ok: boolean; error?: string }> {
    const host = r.modHost;
    if (!host) return { ok: false, error: "尚未启用模组" };
    const result = await host.dispatch(
      { seatId: opts.seatId, name: opts.name, payload: opts.payload },
      {
        now: Date.now(),
        seats: toModSeats(r.seats),
        actor: { userId: opts.actorUserId, seatId: opts.seatId },
      },
    );
    if (!result.ok) return { ok: false, error: result.error };
    opts.after?.();
    if (opts.persist !== false) {
      try {
        await host.persist();
      } catch {
        // keep views even if persist fails
      }
    }
    await this.publishViews(r);
    queueMicrotask(() => {
      void this.promptAgents(r);
    });
    return { ok: true };
  }

  private async publishViews(r: RoomRecord): Promise<void> {
    if (!r.modHost) return;
    let views: {
      seq: number;
      publicView: unknown;
      seatViews: Record<string, unknown>;
    };
    try {
      views = await r.modHost.views(toModSeats(r.seats));
    } catch {
      return;
    }
    r.modSeq = views.seq;
    r.modPublicView = views.publicView;
    r.modSeatViews = views.seatViews;
    const actionsBySeat: Record<string, Record<string, ModActionSchema>> = {};
    for (const seat of r.seats) {
      const target = seat.takenOverBy || seat.occupantUserId;
      if (!target) continue;
      try {
        actionsBySeat[seat.id] = toModActionMap(await r.modHost.actions(seat.id));
      } catch {
        // skip
      }
    }
    r.modActionsBySeat = actionsBySeat;
    this.broadcast(r, "mod.patch", {
      seq: views.seq,
      publicView: views.publicView,
    });
    for (const seat of r.seats) {
      const target = seat.takenOverBy || seat.occupantUserId;
      if (!target) continue;
      const seatView = views.seatViews[seat.id];
      if (seatView === undefined) continue;
      this.sendToUser(r, target, "mod.priv", {
        seq: views.seq,
        seatId: seat.id,
        seatView,
        ...(actionsBySeat[seat.id] ? { actions: actionsBySeat[seat.id] } : {}),
      });
    }
    this.emit(r);
  }

  private sendModViewsTo(r: RoomRecord, ws: WebSocket, userId: string): void {
    if (!r.modStarted || r.modPublicView === undefined) return;
    this.reply(ws, r, "mod.patch", {
      seq: r.modSeq ?? 0,
      publicView: r.modPublicView,
    });
    for (const seat of r.seats) {
      const owns = seat.occupantUserId === userId || seat.takenOverBy === userId;
      if (!owns) continue;
      const seatView = r.modSeatViews?.[seat.id];
      if (seatView === undefined) continue;
      this.reply(ws, r, "mod.priv", {
        seq: r.modSeq ?? 0,
        seatId: seat.id,
        seatView,
        ...(r.modActionsBySeat?.[seat.id]
          ? { actions: r.modActionsBySeat[seat.id] }
          : {}),
      });
    }
  }

  private sendToUser(
    r: RoomRecord,
    userId: string,
    type: RoomFrame["type"],
    payload: unknown,
  ): void {
    if (userId === r.localUserId) return;
    for (const g of r.guests) {
      if ((g as GuestWs).userId === userId && g.readyState === WebSocket.OPEN) {
        this.reply(g, r, type, payload);
      }
    }
  }

  private localSeatViews(r: RoomRecord): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!r.modSeatViews) return out;
    for (const seat of r.seats) {
      const owns =
        seat.occupantUserId === r.localUserId ||
        seat.takenOverBy === r.localUserId;
      if (owns && r.modSeatViews[seat.id] !== undefined) {
        out[seat.id] = r.modSeatViews[seat.id];
      }
    }
    return out;
  }

  private preferredSeatId(
    r: RoomRecord,
    views: Record<string, unknown>,
  ): string | undefined {
    const taken = r.seats.find((s) => s.takenOverBy === r.localUserId);
    if (taken && views[taken.id] !== undefined) return taken.id;
    const ids = Object.keys(views);
    return ids[0];
  }

  private applyGuestSnapshot(r: RoomRecord, snap: RoomSnapshot): void {
    r.name = snap.name;
    r.members = snap.members;
    r.seats = snap.seats;
    r.items = snap.items;
    r.status = snap.status;
    r.modChecksum = snap.modChecksum;
    r.requireMods = snap.requireMods;
    // 二期：实时进度与远端改动随快照覆盖
    r.liveExec = snap.liveExec?.length
      ? new Map(snap.liveExec.map((e) => [e.turnId, e]))
      : undefined;
    r.remoteChanges = snap.remoteChanges;
    if (r.joinInfo) r.joinInfo.modChecksum = snap.modChecksum;
    if (!snap.modChecksum) {
      r.modPublicView = undefined;
      r.modSeatViews = undefined;
      r.modActionsBySeat = undefined;
      r.modFail = undefined;
      r.modSeq = 0;
      r.modOffer = undefined;
    }
    r.kernelProjection = snap.kernel;
  }

  private onModFail(r: RoomRecord, message: string): void {
    if (r.modEnded) return;
    r.modFail = message;
    this.broadcast(r, "mod.fail", { message });
    this.emit(r);
  }

  private clearMod(r: RoomRecord): void {
    this.disposeModHost(r);
    r.modLoaded = undefined;
    r.modStarted = false;
    r.modEnded = true;
    r.modChecksum = "";
    r.requireMods = false;
    r.modFail = undefined;
    r.modPublicView = undefined;
    r.modSeatViews = undefined;
    r.modActionsBySeat = undefined;
    r.modSeq = 0;
    r.modOffer = this.buildOffer(r);
  }

  private disposeModHost(r: RoomRecord): void {
    if (!r.modHost) return;
    try {
      r.modHost.dispose();
    } catch {
      // ignore
    }
    r.modHost = undefined;
  }

  private enqueueInbound(r: RoomRecord, fn: () => Promise<void>): Promise<void> {
    const run = (r.inboundChain ?? Promise.resolve()).then(fn, fn);
    r.inboundChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ingestUserChat(
    r: RoomRecord,
    env: ChatInEnvelope,
    next: { runAgent: boolean; attachments?: Attachment[] },
  ): Promise<void> {
    let current = env;
    if (r.kernel) {
      const result = await r.kernel.runChatIn(env);
      if (result.action === "drop") {
        kernelLog("hook", {
          name: "room.chat.in",
          action: "drop",
          roomId: r.roomId,
        });
        this.append(r, {
          kind: "system",
          source: "kernel",
          text: result.reason
            ? `消息被模组丢弃：${result.reason}`
            : "消息被模组丢弃",
          authorLabel: "系统",
        });
        this.pushState(r);
        return;
      }
      if (result.value) current = result.value;
    }
    this.append(r, {
      kind: "user",
      seatId: current.seatId,
      authorUserId: current.authorUserId,
      authorLabel: current.authorLabel,
      text: current.text,
      ...(current.quote ? { quote: current.quote } : {}),
    });
    this.pushState(r);
    if (!next.runAgent) return;
    const seat = r.seats.find((s) => s.id === current.seatId);
    if (seat) {
      void this.runAgentSeat(
        r,
        seat,
        current.text,
        current.authorUserId,
        next.attachments,
      );
    }
  }

  private disposeKernel(r: RoomRecord, deleteStore: boolean): void {
    const leftover = this.roomModToolOpts(r, {
      id: "",
      kind: "agent",
      name: "",
      occupantUserId: null,
      takenOverBy: null,
      sessionId: null,
      running: false,
      agentName: null,
    });
    for (const seat of r.seats) {
      if (seat.sessionId) this.sessions.syncExtras(seat.sessionId, leftover);
    }
    this.stopKernelSchedule(r);
    const kernel = r.kernel;
    r.kernel = undefined;
    if (kernel) void kernel.dispose();
    if (deleteStore) r.kernelStore?.deleteFile();
    else r.kernelStore?.seal();
    r.kernelStore = undefined;
  }

  private async promptAgents(r: RoomRecord): Promise<void> {
    if (!r.modHost || r.modFail || r.modEnded || !r.modStarted) return;
    for (const seat of r.seats) {
      if (seat.kind !== "agent" || seat.takenOverBy || seat.running) continue;
      let turn;
      try {
        turn = await r.modHost.agentTurn(seat.id);
      } catch {
        continue;
      }
      if (!turn) continue;
      if (seat.takenOverBy) continue;
      await this.injectAgentTurn(r, seat, turn);
    }
  }

  private hasMemoryProvide(r: RoomRecord): boolean {
    return Boolean(
      r.kernel?.snapshot().active.some((p) => p.provides.includes("memory")),
    );
  }

  private syncKernelExtras(r: RoomRecord): void {
    for (const seat of r.seats) {
      if (seat.sessionId) this.sessions.syncExtras(seat.sessionId, this.seatToolOpts(r, seat));
    }
  }

  private bindKernelSchedule(r: RoomRecord): void {
    this.stopKernelSchedule(r);
    const jobs = r.kernel?.listScheduleJobs() ?? [];
    r.kernelTimers = jobs.map((job) =>
      setInterval(() => {
        void this.runKernelScheduleJobs(r);
      }, job.ms),
    );
    if (jobs.length) {
      kernelLog("schedule.bind", { roomId: r.roomId, jobs: jobs.length });
    }
  }

  private stopKernelSchedule(r: RoomRecord): void {
    for (const timer of r.kernelTimers ?? []) clearInterval(timer);
    r.kernelTimers = undefined;
  }

  private async runKernelScheduleJobs(r: RoomRecord): Promise<void> {
    const jobs = r.kernel?.listScheduleJobs() ?? [];
    let wrote = false;
    for (const job of jobs) {
      if (
        job.packId &&
        r.kernel &&
        !r.kernel.consumeSchedule(
          job.packId,
          job.budget?.schedulePerMin ?? KERNEL_BUDGET_DEFAULT.schedulePerMin,
        )
      ) {
        continue;
      }
      let tick: { text?: string; toAgent?: boolean } | void;
      try {
        tick = await Promise.race([
          Promise.resolve(job.run()),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("schedule timeout")), 200);
          }),
        ]);
      } catch {
        kernelLog("schedule.tick", { roomId: r.roomId, action: "error" });
        continue;
      }
      const text =
        tick && typeof tick.text === "string" ? tick.text.trim() : "";
      if (!text) continue;
      kernelLog("schedule.tick", { roomId: r.roomId, action: "announce" });
      this.append(r, {
        kind: "system",
        source: "kernel",
        text,
        authorLabel: "系统",
      });
      wrote = true;
      if (tick && tick.toAgent) {
        const seat = r.seats.find((s) => s.kind === "agent" && !s.takenOverBy);
        if (seat) void this.runAgentSeat(r, seat, text);
      }
    }
    if (wrote) this.pushState(r);
  }

  private kernelToolOpts(r: RoomRecord): SessionRunOpts {
    if (!r.kernel) return {};
    const memory =
      r.kernelStore && this.hasMemoryProvide(r)
        ? (tryCreateMemoryMcp(r.kernelStore) ?? {})
        : {};
    const improve = tryCreateImproveMcp(this.improveHost(r)) ?? {};
    return mergeSessionRunOpts(memory, improve);
  }

  private improveHost(r: RoomRecord): KernelImproveHost {
    return {
      list: () => {
        const graph = r.kernel?.snapshot();
        const stateOf = (id: string) => {
          const active = graph?.active.find((p) => p.id === id);
          if (active) return { state: "active" as const };
          const pending = graph?.pending.find((p) => p.id === id);
          if (pending) {
            return { state: "pending" as const, pendingReason: pending.pendingReason };
          }
          const failed = graph?.failed.find((p) => p.id === id);
          if (failed) {
            return { state: "failed" as const, failedReason: failed.failedReason };
          }
          return { state: "unknown" as const };
        };
        return (r.kernelLoaded ?? []).map((p) => {
          const st = stateOf(p.manifest.id);
          return {
            id: p.manifest.id,
            name: p.manifest.name,
            version: p.manifest.version,
            inject: [...p.manifest.inject],
            provides: [...p.manifest.provides],
            permissions: [...p.manifest.permissions],
            hooks: [...p.manifest.hooks],
            state: st.state,
            ...(st.pendingReason ? { pendingReason: st.pendingReason } : {}),
            ...(st.failedReason ? { failedReason: st.failedReason } : {}),
          };
        });
      },
      getSource: (packId) =>
        r.kernelLoaded?.find((p) => p.manifest.id === packId)?.modJsSource ?? null,
      propose: (packId, modJs, note) =>
        this.proposeKernelImprove(r.roomId, packId, modJs, note),
      status: () => {
        const snap = this.getKernelImprove(r.roomId);
        return {
          autonomy: snap.autonomy ?? 0,
          proposals: (snap.proposals ?? []).map((p) => ({
            id: p.id,
            packId: p.packId,
            status: p.status,
            decision: p.decision,
            at: p.at,
            ...(p.note ? { note: p.note } : {}),
            ...(p.error ? { error: p.error } : {}),
          })),
          canRollback: snap.canRollback ?? [],
        };
      },
      rollback: (packId) => this.rollbackKernelImprove(r.roomId, packId),
    };
  }

  private seatToolOpts(
    r: RoomRecord,
    seat: RoomSeat,
    fallbackActions?: unknown,
  ): SessionRunOpts {
    return mergeSessionRunOpts(
      this.roomModToolOpts(r, seat, fallbackActions),
      this.kernelToolOpts(r),
    );
  }

  private roomModToolOpts(
    r: RoomRecord,
    seat: RoomSeat,
    fallbackActions?: unknown,
  ): SessionRunOpts {
    if (!r.modHost || !r.modStarted || r.modEnded) return {};
    const mcp = tryCreateRoomModMcp((act) =>
      this.dispatchAgentAct(r, seat, act, fallbackActions),
    );
    return mcp?.opts ?? {};
  }

  private roomModInjectOpts(
    r: RoomRecord,
    seat: RoomSeat,
    fallbackActions?: unknown,
  ): SessionRunOpts {
    return {
      hiddenFromList: true,
      title: `${ROOM_MOD_PREFIX} ${seat.name}`,
      persistText: `${ROOM_MOD_PREFIX} ${r.roomId} ${seat.id}`,
      ...this.seatToolOpts(r, seat, fallbackActions),
    };
  }

  private async dispatchAgentAct(
    r: RoomRecord,
    seat: RoomSeat,
    act: { action: string; payload: unknown },
    fallbackActions?: unknown,
  ): Promise<string> {
    if (seat.takenOverBy) return "席位已被接管";
    const names =
      (await r.modHost?.actions(seat.id).catch(() => fallbackActions)) ??
      fallbackActions;
    const legal = new Set(actionNames(names));
    if (!legal.has(act.action)) return illegalActionMessage(names);
    const result = await this.enqueueIntent(r, () =>
      this.dispatchMod(r, {
        seatId: seat.id,
        name: act.action,
        payload: act.payload,
        actorUserId: seat.occupantUserId || "agent",
      }),
    );
    return result.ok ? "ok" : result.error || "操作失败";
  }

  private async injectAgentTurn(
    r: RoomRecord,
    seat: RoomSeat,
    turn: { should: boolean; view: unknown; prompt: string; actions: unknown },
  ): Promise<void> {
    if (seat.takenOverBy) return;
    const cwd = this.settings.get().lastProjectPath;
    if (!cwd) return;
    const text = formatRoomModPrompt(turn);
    const extras = {
      ...this.roomModInjectOpts(r, seat, turn.actions),
      replaceExtras: true,
    };
    const mcpAttached = Boolean(extras.extraMcpServers);
    seat.running = true;
    try {
      if (seat.takenOverBy) return;
      const prompt = { text, attachments: [] as never[] };
      if (!seat.sessionId) {
        const id = await this.sessions.start(prompt, cwd, extras);
        seat.sessionId = id;
      } else {
        await this.sessions.continue(seat.sessionId, prompt, extras);
      }
      if (seat.takenOverBy) return;
      if (!mcpAttached && seat.sessionId) {
        const items = this.sessions.getTranscript(seat.sessionId);
        const last = [...items]
          .reverse()
          .find((i) => i.kind === "text" && i.role === "assistant");
        const reply = last && last.kind === "text" ? last.text : "";
        const act = parseRoomModAct(reply);
        if (act) {
          if (seat.takenOverBy) return;
          await this.dispatchAgentAct(r, seat, act, turn.actions);
        }
      }
    } catch {
      // injection is best-effort; play loop stays up
    } finally {
      seat.running = false;
    }
  }
}

function handshakeRejectMessage(reason: string | undefined): string {
  switch (reason) {
    case HandshakeReject.password:
      return "密码错误";
    case HandshakeReject.blacklist:
      return "该设备已被群主拉黑";
    case HandshakeReject.fingerprint:
      return "设备指纹验证失败";
    case HandshakeReject.denied:
      return "群主拒绝了加入请求";
    case HandshakeReject.timeout:
      return "握手超时";
    default:
      return "握手被拒绝";
  }
}

function toModSeats(seats: RoomSeat[]): ModSeat[] {
  return seats.map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    occupantUserId: s.occupantUserId,
    takenOverBy: s.takenOverBy,
    sessionId: s.sessionId,
  }));
}

function assembledSize(chunks: Map<number, Buffer>): number {
  let n = 0;
  for (const buf of chunks.values()) n += buf.length;
  return n;
}

function assembleChunks(chunks: Map<number, Buffer>): Buffer {
  const ordered = [...chunks.entries()].sort((a, b) => a[0] - b[0]);
  return Buffer.concat(ordered.map(([, b]) => b));
}

function collectBundles(
  ws: WebSocket,
  conn: RoomConnection | null,
  checksum: string,
  size: number,
  timeoutMs: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks = new Map<number, Buffer>();
    let settled = false;
    const finish = (
      result: { ok: true; bytes: Buffer } | { ok: false; error: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off("close", onClose);
      ws.off("message", onMsg);
      resolve(result);
    };
    const onFrame = (frame: RoomFrame) => {
      if (frame.type === "error") {
        finish({
          ok: false,
          error: (frame.payload as { message?: string })?.message ?? "下载失败",
        });
        return;
      }
      if (frame.type !== "mod.bundle") return;
      const p = frame.payload as {
        checksum?: string;
        offset?: number;
        chunk?: string;
      };
      if (p.checksum !== checksum || typeof p.chunk !== "string") return;
      chunks.set(
        typeof p.offset === "number" ? p.offset : 0,
        Buffer.from(p.chunk, "base64"),
      );
      if (assembledSize(chunks) >= size) {
        finish({ ok: true, bytes: assembleChunks(chunks) });
      }
    };
    const onMsg = (data: RawData) => {
      const frame = parseRoomFrame(String(data));
      if (frame) onFrame(frame);
    };
    if (conn) conn.onFrame(onFrame);
    else ws.on("message", onMsg);
    const onClose = () => finish({ ok: false, error: "模组下载不完整" });
    const timer = setTimeout(
      () => finish({ ok: false, error: "模组下载不完整" }),
      timeoutMs,
    );
    ws.on("close", onClose);
  });
}

function waitOpen(ws: WebSocket, timeoutMs: number): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("连接超时"));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onErr);
    };
    ws.on("open", onOpen);
    ws.on("error", onErr);
  });
}

function waitFrame(
  ws: WebSocket,
  type: RoomFrame["type"] | RoomFrame["type"][],
  timeoutMs: number,
): Promise<RoomFrame | null> {
  const types = new Set(Array.isArray(type) ? type : [type, "error"]);
  if (!Array.isArray(type)) types.add("error");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, Math.max(1, timeoutMs));
    const onMsg = (data: RawData) => {
      const frame = parseRoomFrame(String(data));
      if (!frame || !types.has(frame.type)) return;
      cleanup();
      resolve(frame);
    };
    const onClose = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMsg);
      ws.off("close", onClose);
    };
    ws.on("message", onMsg);
    ws.on("close", onClose);
  });
}
