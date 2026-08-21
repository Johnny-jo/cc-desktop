import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { BrowserWindow } from "electron";
import { IPC, MOD_BUNDLE_MAX_BYTES } from "@claude-desktop/shared";
import type {
  DeviceKeys,
  Handshake,
  ModOfferPayload,
  RoomListItem,
  RoomMember,
  RoomPath,
  RoomQuoteRef,
  RoomSeat,
  RoomSeatKind,
  RoomSnapshot,
  RoomTimelineItem,
  RoomFrame,
} from "@claude-desktop/shared";
import {
  HandshakeReject,
  ROOM_DEFAULT_PORT,
  ROOM_HANDSHAKE_TIMEOUT_MS,
  ROOM_PROTOCOL_VERSION,
  deriveSessionKey,
  encodeRoomInvite,
  fingerprintPublic,
  makeHandshake,
  makeRoomFrame,
  parsePdu,
  parseRoomFrame,
  provePassword,
  verifyPassword,
} from "@claude-desktop/shared";
import type { SessionManager, SessionRunOpts } from "./session-manager";
import type { SettingsStore } from "./settings-store";
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
import { HandshakeWatchdog } from "./room-limits";
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

type GuestWs = WebSocket & { userId?: string; fetching?: boolean };

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

/** T0 = LAN ws; T2 = wss through a Cloudflare tunnel; T1 = any other wss. */
function pathForCandidateUrl(url: string): RoomPath {
  if (!/^wss:\/\//i.test(url)) return "T0";
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("trycloudflare") || hostname.includes("cfargotunnel")) {
      return "T2";
    }
  } catch {
    // fall through
  }
  return "T1";
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
  private readonly sessions: SessionManager;
  private readonly settings: SettingsStore;
  private readonly archive: RoomArchive | null;
  private readonly userDataDir: string;
  private readonly isPackaged: boolean;
  private readonly resourcesPath?: string;
  /** Process-level room device identity (persisted under userData). */
  private readonly deviceKeys: DeviceKeys;
  private readonly deviceFp: string;
  /** Injectable backoff sleep for guest reconnect (tests make it instant). */
  private reconnectSleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /**
   * Test-only hook: when false, wss:// join candidates skip TLS CA checks so
   * self-signed local test certs pass. Never set outside tests — production
   * guests always verify the relay certificate against the system CA.
   */
  private wssRejectUnauthorized?: boolean;

  constructor(opts: {
    getWindow: () => BrowserWindow | null;
    sessions: SessionManager;
    settings: SettingsStore;
    archive?: RoomArchive | null;
    userDataDir?: string;
    isPackaged?: boolean;
    resourcesPath?: string;
  }) {
    this.getWindow = opts.getWindow;
    this.sessions = opts.sessions;
    this.settings = opts.settings;
    this.archive = opts.archive ?? null;
    this.userDataDir = opts.userDataDir ?? os.tmpdir();
    this.isPackaged = opts.isPackaged ?? false;
    this.resourcesPath = opts.resourcesPath;
    this.deviceKeys = loadOrCreateDeviceKeys(this.userDataDir);
    this.deviceFp = fingerprintPublic(this.deviceKeys.publicRaw);
    this.hydrateFromArchive();
  }

  private pathEnv(): RuntimePathEnv {
    return {
      isPackaged: this.isPackaged,
      userDataDir: this.userDataDir,
      ...(this.resourcesPath ? { resourcesPath: this.resourcesPath } : {}),
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
      // No live socket after restart — never show a stale「开着」.
      const status = stored.status === "open" ? "ended" : stored.status;
      const rec: RoomRecord = {
        roomId: stored.roomId,
        name: stored.name,
        password: stored.join?.password ?? "",
        port: stored.port,
        requireMods: Boolean(stored.requireMods),
        autoApprove: Boolean(stored.autoApprove),
        encrypt: stored.encrypt ?? true,
        hostFingerprint:
          stored.hostFingerprint ?? stored.join?.hostFingerprint ?? "",
        deviceKeys: this.deviceKeys,
        connections: new Map(),
        pendingByFp: new Map(),
        blacklist: new Set(),
        knownDevices: new Map(),
        modChecksum: stored.modChecksum ?? "",
        status,
        hostUserId: "",
        hostLabel: stored.hostLabel ?? "",
        localUserId: stored.localUserId ?? "",
        localRole: stored.role,
        members: stored.members ?? [],
        seats: stored.seats ?? [],
        items: stored.items ?? [],
        seq: 1,
        server: null,
        guests: new Set(),
        client: null,
        ...(stored.offline ? { offline: true } : {}),
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
      this.rooms.set(rec.roomId, rec);
      if (status !== stored.status) this.persist(rec);
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

  invite(roomId: string) {
    const r = this.rooms.get(roomId);
    if (!r || r.localRole !== "host") {
      return { ok: false as const, error: "只有群主可以邀请" };
    }
    const hosts = lanAddresses();
    const host = hosts[0] ?? "127.0.0.1";
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
        ...(r.publicWss ? { wss: [r.publicWss] } : {}),
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
  }): Promise<{ ok: boolean; offer?: ModOfferPayload; error?: string }> {
    const host = this.normalizeHost(opts.host);
    const port = opts.port;
    if (!host || !port) return { ok: false, error: "请填写地址和端口" };
    const cached = this.cachedOffer(host, port);
    if (cached) return { ok: true, offer: cached };
    return this.withHostSocket(host, port, async (ws) => {
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
    return this.withHostSocket(host, port, async (ws) => {
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
      // mod.fetch is gated behind hs.ok — run the handshake on this short
      // connection first, then pull the bundle over the RoomConnection.
      const hs = await this.handshakeAsGuest(ws, {
        password: opts.password ?? "",
        name: displayName(),
        hostFingerprint: opts.hostFingerprint,
      });
      if (!hs.ok) {
        return { ok: false, error: hs.error, offer };
      }
      const collecting = collectBundles(ws, hs.conn, checksum, offer.size, 30_000);
      hs.conn.sendFrame(makeRoomFrame("pending", 2, "mod.fetch", { checksum }));
      const collected = await collecting;
      hs.conn.close();
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
  }): Promise<{ ok: boolean; room?: RoomSnapshot; error?: string }> {
    const name = opts.name.trim();
    if (!name) return { ok: false, error: "请填写群聊名" };
    const publicWss = (opts.publicWss ?? "").trim();
    if (publicWss && !/^wss:\/\//i.test(publicWss)) {
      return { ok: false, error: "公网地址须以 wss:// 开头" };
    }
    const port = opts.port && opts.port > 0 ? opts.port : ROOM_DEFAULT_PORT;
    // Relayed (public) rooms must never go plaintext.
    const encrypt =
      opts.encrypt !== false || (opts.wss?.length ?? 0) > 0 || Boolean(publicWss);

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
      members: [{ userId: hostUserId, name: hostName, role: "host" }],
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

    rec.server = wss;
    wss.on("connection", (ws) => this.onGuest(rec, ws));
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
      return {
        ok: false,
        error: `端口 ${port} 已绑定但本机探测失败，请重启应用后重试`,
      };
    }

    this.append(rec, {
      kind: "system",
      text: `本机已开口 · 客人请连：${ips.map((ip) => `${ip}:${port}`).join(" 或 ")}（防火墙需放行 TCP ${port}）`,
      authorLabel: "系统",
    });

    this.rooms.set(roomId, rec);
    this.persist(rec);
    this.emit(rec);
    return { ok: true, room: this.snapshot(rec) };
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
          conn.sendFrame(
            makeRoomFrame("pending", 1, "join", {
              userId,
              name,
              protocol: ROOM_PROTOCOL_VERSION,
              modChecksum: checksum,
            }),
          );
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
   * literals bracketed), then every wss:// relay. Raced by raceCandidates.
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
      if (!/^wss:\/\//i.test(url)) continue;
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
              rejectAtt(err);
              return;
            }
            sockets.add(ws);
            const timer = setTimeout(() => {
              try {
                ws.terminate();
              } catch {
                // ignore
              }
              rejectAtt(new Error(`候选路径超时 ${url}`));
            }, timeoutMs);
            ws.on("open", () => {
              clearTimeout(timer);
              resolveAtt({ ws, url, path: pathForCandidateUrl(url) });
            });
            ws.on("error", (err) => {
              clearTimeout(timer);
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
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
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
          conn.sendFrame(
            makeRoomFrame(r.roomId, 1, "join", {
              userId: r.localUserId || randomUUID(),
              name: displayName(),
              protocol: ROOM_PROTOCOL_VERSION,
              modChecksum: (modChecksum ?? "").trim(),
            }),
          );
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
    // Host leave = delete room for everyone
    if (r.localRole === "host") {
      return this.end(roomId, { delete: true });
    }
    this.cancelGuestReconnect(r);
    try {
      r.client?.close();
    } catch {
      // ignore
    }
    r.client = null;
    r.status = "ended";
    this.persist(r);
    this.emit(r);
    return { ok: true };
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
    r.status = "ended";
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
      ...(r.offline ? { offline: true } : {}),
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
        !r.closing &&
        !r.reconnecting
      ) {
        void this.reconnectGuest(r);
      }
    });
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
    };
    r.seats.push(seat);
    this.append(r, {
      kind: "system",
      text: `新席位：${label}`,
      authorLabel: "系统",
    });
    this.pushState(r);
    return { ok: true, room: this.snapshot(r) };
  }

  /** Host-side: add a seat for a member (from seat.add frame). */
  private addSeatForMember(
    r: RoomRecord,
    userId: string,
    kind: RoomSeatKind,
    name: string,
    agentName?: string,
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
    };
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
  ) {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "群聊不可用" };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "消息为空" };
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
        text: trimmed,
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
            text: trimmed,
            at: Date.now(),
            ...(quote ? { quote } : {}),
          },
          { runAgent: true },
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
          text: trimmed,
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
      this.denyAllPending(r);
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

  private async runAgentSeat(r: RoomRecord, seat: RoomSeat, text: string) {
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
    seat.running = true;
    this.pushState(r);
    const prompt = {
      text:
        seat.agentName && !seat.sessionId
          ? `【你是群聊席位「${seat.name}」，人设：${seat.agentName}】\n${text}`
          : text,
      attachments: [],
    };
    const extras = {
      ...this.seatToolOpts(r, seat),
      replaceExtras: true,
    };
    try {
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
      this.pushState(r);
    }
  }

  private onGuest(r: RoomRecord, ws: WebSocket) {
    // Half-open watchdog: sockets that never finish the handshake (or never
    // send a legacy plaintext join on skip-encrypt rooms) get closed.
    const watchdog = new HandshakeWatchdog(ROOM_HANDSHAKE_TIMEOUT_MS, () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
    watchdog.start();
    const hsState: GuestHandshakeState = {};
    const onMsg = (data: RawData) => {
      const pdu = parsePdu(String(data));
      if (!pdu) return;
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
        // Skip-encrypt rooms keep the legacy plaintext path. Encrypted rooms
        // accept only hs frames until hs.ok (mod.fetch included).
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
    entry.ws.send(
      JSON.stringify(makeHandshake("ok", { kid, encrypt: rec.encrypt })),
    );
    entry.upgrade();
    this.emitPending(rec);
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
    const r = this.hostRoom(roomId);
    if (!r.ok) return r;
    const rec = r.room;
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
      conn.sendFrame(
        makeRoomFrame(rec.roomId, ++rec.seq, "kick", {
          userId,
          message: "你已被群主移出群聊",
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
    this.append(rec, {
      kind: "system",
      text: `${name} 已被群主移出并拉黑`,
      authorLabel: "系统",
    });
    this.pushState(rec);
    return { ok: true };
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
      const finish = (
        v:
          | { ok: true; conn: RoomConnection; hostFp: string; encrypt: boolean }
          | { ok: false; error: string },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.off("message", onMsg);
        ws.off("close", onClose);
        resolve(v);
      };
      let timer = setTimeout(
        () => finish({ ok: false, error: "握手超时" }),
        ROOM_HANDSHAKE_TIMEOUT_MS,
      );
      const onMsg = (data: RawData) => {
        const pdu = parsePdu(String(data));
        if (!pdu || pdu.kind !== "hs") return;
        const hs = pdu.hs;
        if (hs.type === "challenge") {
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
          finish({ ok: false, error: handshakeRejectMessage(reason) });
          return;
        }
        if (hs.type === "pending") {
          // Host is holding us for approval — wait up to 60s for hs.ok.
          clearTimeout(timer);
          timer = setTimeout(
            () =>
              finish({
                ok: false,
                error: "等待群主审批超时（60 秒），请稍后再试",
              }),
            60_000,
          );
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
      if (!r.members.some((m) => m.userId === userId)) {
        r.members.push({ userId, name, role: "member" });
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
      r.guests.add(ws);
      (ws as GuestWs).userId = userId;
      this.append(r, {
        kind: "system",
        text: `${name} 加入了群聊`,
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

    if (frame.type === "seat.takeover") {
      const p = frame.payload as { seatId?: string };
      const seat = r.seats.find((s) => s.id === p.seatId);
      if (!seat || seat.kind !== "agent") return;
      seat.takenOverBy = userId;
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
      };
      if (!p.userId) return;
      this.addSeatForMember(
        r,
        p.userId,
        p.kind === "agent" ? "agent" : "human",
        p.name ?? "",
        p.agentName,
      );
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

  private snapshot(r: RoomRecord): RoomSnapshot {
    return {
      roomId: r.roomId,
      name: r.name,
      status: r.status,
      port: r.port,
      hostLabel: r.hostLabel,
      inviteHost: lanAddress(),
      memberCount: r.members.length,
      requireMods: r.requireMods,
      modChecksum: r.modChecksum,
      autoApprove: r.autoApprove,
      hasPassword: Boolean(r.password),
      encrypt: r.encrypt,
      hostFingerprint: r.hostFingerprint || undefined,
      members: r.members,
      seats: r.seats,
      items: r.items,
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

  private broadcast(r: RoomRecord, type: RoomFrame["type"], payload: unknown) {
    r.seq += 1;
    const frame = makeRoomFrame(r.roomId, r.seq, type, payload);
    for (const g of r.guests) {
      const conn = r.connections.get(g);
      if (conn) {
        conn.sendFrame(frame);
        continue;
      }
      // No connection: only possible for legacy plaintext (skip-encrypt) guests.
      if (g.readyState === WebSocket.OPEN) g.send(JSON.stringify(frame));
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
      conn.sendFrame(frame);
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
      conn.sendFrame(frame);
      return;
    }
    r.client.send(JSON.stringify(frame));
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
    host: string,
    port: number,
    fn: (ws: WebSocket) => Promise<T>,
  ): Promise<T | { ok: false; error: string }> {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${host}:${port}`, { handshakeTimeout: 10_000 });
    } catch (err) {
      return {
        ok: false,
        error: `无法创建连接：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      await waitOpen(ws, 10_000);
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
    r.members = snap.members;
    r.seats = snap.seats;
    r.items = snap.items;
    r.status = snap.status;
    r.modChecksum = snap.modChecksum;
    r.requireMods = snap.requireMods;
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
    next: { runAgent: boolean },
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
    if (seat) void this.runAgentSeat(r, seat, current.text);
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
  conn: RoomConnection,
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
    conn.onFrame(onFrame);
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
