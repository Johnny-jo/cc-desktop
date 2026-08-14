import { randomUUID } from "node:crypto";
import os from "node:os";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { BrowserWindow } from "electron";
import { IPC } from "@claude-desktop/shared";
import type {
  RoomListItem,
  RoomMember,
  RoomSeat,
  RoomSeatKind,
  RoomSnapshot,
  RoomTimelineItem,
  RoomFrame,
} from "@claude-desktop/shared";
import {
  ROOM_DEFAULT_PORT,
  ROOM_PROTOCOL_VERSION,
  encodeRoomInvite,
  makeRoomFrame,
  parseRoomFrame,
} from "@claude-desktop/shared";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";
import type { RoomArchive, StoredRoom } from "./room-archive";

type RoomRecord = {
  roomId: string;
  name: string;
  password: string;
  port: number;
  requireMods: boolean;
  autoApprove: boolean;
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
  };
  reconnecting?: boolean;
  /** Guest is leaving on purpose — do not reconnect. */
  closing?: boolean;
  /** Bumped to cancel an in-flight reconnect loop. */
  reconnectGen?: number;
};

function lanAddresses(): string[] {
  const ifs = os.networkInterfaces();
  const out: string[] = [];
  for (const list of Object.values(ifs)) {
    for (const n of list ?? []) {
      // Node may report family as 4 or "IPv4" depending on version
      const fam = n.family as string | number;
      if (n.internal) continue;
      if (fam !== "IPv4" && fam !== 4) continue;
      if (n.address.startsWith("127.")) continue;
      if (!out.includes(n.address)) out.push(n.address);
    }
  }
  // Prefer non-APIPA (169.254.x) and non-virtual-looking first
  out.sort((a, b) => {
    const score = (ip: string) => {
      if (ip.startsWith("169.254.")) return 3;
      if (ip.startsWith("192.168.") || ip.startsWith("10.")) return 0;
      if (ip.startsWith("172.")) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
  return out.length ? out : ["127.0.0.1"];
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

  constructor(opts: {
    getWindow: () => BrowserWindow | null;
    sessions: SessionManager;
    settings: SettingsStore;
    archive?: RoomArchive | null;
  }) {
    this.getWindow = opts.getWindow;
    this.sessions = opts.sessions;
    this.settings = opts.settings;
    this.archive = opts.archive ?? null;
    this.hydrateFromArchive();
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
        modChecksum: stored.modChecksum ?? "",
        status,
        hostUserId: "",
        hostLabel: stored.hostLabel ?? "",
        localUserId: "",
        localRole: stored.role,
        members: stored.members ?? [],
        seats: stored.seats ?? [],
        items: stored.items ?? [],
        seq: 1,
        server: null,
        guests: new Set(),
        client: null,
        ...(stored.join
          ? {
              joinInfo: {
                host: stored.join.host,
                hosts: stored.join.hosts ?? [stored.join.host],
                port: stored.join.port,
                password: stored.join.password,
                modChecksum: stored.join.modChecksum,
                secret: stored.join.secret,
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
      members: stored.members ?? [],
      seats: stored.seats ?? [],
      items: stored.items ?? [],
    };
  }

  invite(roomId: string) {
    const r = this.rooms.get(roomId);
    if (!r || r.localRole !== "host") {
      return { ok: false as const, error: "只有房主可以邀请" };
    }
    const hosts = lanAddresses();
    const host = hosts[0] ?? "127.0.0.1";
    let secret: string | undefined;
    try {
      secret = encodeRoomInvite({
        host,
        hosts,
        port: r.port,
        password: r.password || undefined,
        modChecksum: r.modChecksum || undefined,
        roomName: r.name,
      });
    } catch {
      secret = undefined;
    }
    return {
      ok: true as const,
      host,
      hosts,
      port: r.port,
      password: r.password || undefined,
      modChecksum: r.modChecksum || undefined,
      listening: Boolean(r.server),
      secret,
    };
  }

  async create(opts: {
    name: string;
    password?: string;
    port?: number;
    requireMods?: boolean;
    autoApprove?: boolean;
  }): Promise<{ ok: boolean; room?: RoomSnapshot; error?: string }> {
    const name = opts.name.trim();
    if (!name) return { ok: false, error: "请填写房间名" };
    const port = opts.port && opts.port > 0 ? opts.port : ROOM_DEFAULT_PORT;

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
          error: `端口 ${port} 上已有房间「${existing.name}」，请先结束它或换端口`,
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
          text: `房间「${name}」已创建 · 监听 0.0.0.0:${port}`,
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
      this.pushError(`房间端口 ${port} 错误：${err.message}`);
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

    const userId = randomUUID();
    const name = (opts.name ?? displayName()).trim() || displayName();

    return new Promise((resolve) => {
      let settled = false;
      let lastErr = "";
      const done = (v: { ok: boolean; room?: RoomSnapshot; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://${host}:${port}`, {
          handshakeTimeout: 10_000,
        });
      } catch (err) {
        done({
          ok: false,
          error: `无法创建连接：${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        done({
          ok: false,
          error:
            `连接超时 ${host}:${port}\n` +
            `请确认：① 房主已点「创建并开口」且房间显示「开着」` +
            ` ② 房主 Windows 防火墙放行 TCP ${port} 入站` +
            ` ③ IP 是否正确（房主点「邀请」复制）` +
            ` ④ 本机自测可先填 127.0.0.1` +
            (lastErr ? `\n底层：${lastErr}` : ""),
        });
      }, 12_000);

      ws.on("error", (err) => {
        lastErr = err.message;
        // Don't settle immediately on error — wait for close/timeout so we
        // can show a clearer message. Node ws often emits error then close.
      });

      ws.on("open", () => {
        const frame = makeRoomFrame("pending", 1, "join", {
          userId,
          name,
          password: opts.password ?? "",
          protocol: ROOM_PROTOCOL_VERSION,
          modChecksum: opts.modChecksum ?? "",
        });
        try {
          ws.send(JSON.stringify(frame));
        } catch (err) {
          clearTimeout(timer);
          done({
            ok: false,
            error: `已连接但发送失败：${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });

      let rec: RoomRecord | null = null;
      ws.on("message", (data) => {
        if (settled && rec) return;
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const frame = parseRoomFrame(raw);
        if (!frame) return;

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
              joinInfo: {
                host,
                hosts: [
                  host,
                  ...(opts.hosts ?? []).filter((h) => h && h !== host),
                ],
                port,
                password: opts.password,
                modChecksum: opts.modChecksum,
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
              "房主已解散房间",
          );
        }
      });

      ws.on("close", () => {
        if (!settled) {
          clearTimeout(timer);
          done({
            ok: false,
            error: lastErr
              ? `连接被关闭 ${host}:${port}（${lastErr}）\n若是 ECONNREFUSED：房主未监听该端口；若超时：多半是防火墙`
              : `连接被关闭 ${host}:${port}`,
          });
        }
        // After join, bindGuestSocket owns reconnect.
      });
    });
  }

  /**
   * Guest reconnect: up to 3 attempts, each waits up to 30s for TCP+handshake.
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

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (r.closing || (r.reconnectGen ?? 0) !== gen) {
        r.reconnecting = false;
        return;
      }
      this.safeSend(IPC.roomEvent, {
        roomId: r.roomId,
        reconnecting: true,
        reconnectAttempt: attempt,
        message: `与主机断开，正在重连（${attempt}/3，最长 30 秒）…`,
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
    this.dismissGuest(r, "无法连接主机（已重试 3 次），已退出房间");
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
        ws = new WebSocket(`ws://${host}:${port}`, { handshakeTimeout: 25_000 });
      } catch {
        done(false);
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        done(false);
      }, 30_000);

      ws.on("error", () => {
        /* wait for close */
      });
      ws.on("open", () => {
        const frame = makeRoomFrame(r.roomId, 1, "join", {
          userId: r.localUserId || randomUUID(),
          name: displayName(),
          password: password ?? "",
          protocol: ROOM_PROTOCOL_VERSION,
          modChecksum: modChecksum ?? "",
        });
        try {
          ws.send(JSON.stringify(frame));
        } catch {
          clearTimeout(timer);
          done(false);
        }
      });
      ws.on("message", (data) => {
        if (settled) return;
        const frame = parseRoomFrame(
          typeof data === "string" ? data : data.toString("utf8"),
        );
        if (!frame) return;
        if (frame.type === "room.closed") {
          clearTimeout(timer);
          this.dismissGuest(
            r,
            (frame.payload as { message?: string })?.message ??
              "房主已解散房间",
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
          r.client = ws;
          r.status = "open";
          r.members = snap.members;
          r.seats = snap.seats;
          r.items = snap.items;
          r.seq = frame.seq;
          this.bindGuestSocket(r, ws);
          done(true);
        }
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
    if (!r) return { ok: false, error: "房间不存在" };
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
  private dismissGuest(r: RoomRecord, message: string): void {
    if (r.closing && !this.rooms.has(r.roomId)) return;
    this.cancelGuestReconnect(r);
    r.status = "ended";
    try {
      r.client?.close();
    } catch {
      // ignore
    }
    r.client = null;
    this.archive?.removeRoom(r.roomId);
    this.rooms.delete(r.roomId);
    this.safeSend(IPC.roomEvent, {
      roomId: r.roomId,
      closed: true,
      message,
    });
  }

  /** Ongoing guest socket after join / successful reconnect. */
  private bindGuestSocket(r: RoomRecord, ws: WebSocket): void {
    ws.on("message", (data) => {
      if (r.closing || r.client !== ws) return;
      const frame = parseRoomFrame(
        typeof data === "string" ? data : data.toString("utf8"),
      );
      if (!frame) return;
      if (frame.type === "state.snapshot") {
        if (r.status !== "open") return;
        const snap = frame.payload as RoomSnapshot;
        r.members = snap.members;
        r.seats = snap.seats;
        r.items = snap.items;
        r.status = snap.status;
        r.seq = frame.seq;
        this.persist(r);
        this.emit(r);
        return;
      }
      if (frame.type === "room.closed") {
        this.dismissGuest(
          r,
          (frame.payload as { message?: string })?.message ?? "房主已解散房间",
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
    });
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
    if (!r) return { ok: false, error: "房间不存在" };
    if (r.localRole !== "host") {
      return { ok: false, error: "只有房主可以结束房间" };
    }
    const shouldDelete = opts?.delete !== false;
    r.status = "ended";
    this.append(r, {
      kind: "system",
      text: shouldDelete ? "房主已解散房间" : "房间已结束",
      authorLabel: "系统",
    });
    this.broadcast(r, "room.closed", {
      message: shouldDelete ? "房主已解散房间" : "房间已结束",
    });
    for (const g of r.guests) {
      try {
        g.close();
      } catch {
        // ignore
      }
    }
    r.guests.clear();
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
        message: "房间已解散",
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
      return { ok: false, error: "房间不可用" };
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
    if (!r || r.status !== "open") return { ok: false, error: "房间不可用" };
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
    if (!r || r.status !== "open") return { ok: false, error: "房间不可用" };
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
    if (!r || r.status !== "open") return { ok: false, error: "房间不可用" };
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
    if (!r || r.status !== "open") return { ok: false, error: "房间不可用" };
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

  async send(roomId: string, seatId: string, text: string) {
    const r = this.rooms.get(roomId);
    if (!r || r.status !== "open") return { ok: false, error: "房间不可用" };
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
      });
      return { ok: true };
    }

    const canTalk =
      (seat.kind === "human" && seat.occupantUserId === r.localUserId) ||
      (seat.kind === "agent" && seat.takenOverBy === r.localUserId);
    if (!canTalk && seat.kind === "agent" && !seat.takenOverBy) {
      // Host speaking *to* the agent seat → start/continue agent
      this.append(r, {
        kind: "user",
        seatId,
        authorUserId: r.localUserId,
        authorLabel: this.memberName(r, r.localUserId),
        text: trimmed,
      });
      this.pushState(r);
      void this.runAgentSeat(r, seat, trimmed);
      return { ok: true };
    }
    if (!canTalk) {
      return { ok: false, error: "当前不能在这个席位发言（先接管或选自己的人席）" };
    }

    this.append(r, {
      kind: "user",
      seatId,
      authorUserId: r.localUserId,
      authorLabel: this.memberName(r, r.localUserId),
      text: trimmed,
    });
    this.pushState(r);
    return { ok: true };
  }

  disposeAll(): void {
    for (const r of this.rooms.values()) {
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
        text: "房主尚未打开项目，Agent 无法执行",
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
          ? `【你是房间席位「${seat.name}」，人设：${seat.agentName}】\n${text}`
          : text,
      attachments: [],
    };
    try {
      if (!seat.sessionId) {
        const id = await this.sessions.start(prompt, cwd);
        seat.sessionId = id;
      } else {
        await this.sessions.continue(seat.sessionId, prompt);
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
    ws.on("message", (data: RawData) => {
      const frame = parseRoomFrame(String(data));
      if (!frame) return;
      this.handleGuestFrame(r, ws, frame);
    });
    ws.on("close", () => {
      r.guests.delete(ws);
    });
  }

  private handleGuestFrame(r: RoomRecord, ws: WebSocket, frame: RoomFrame) {
    if (r.status !== "open") {
      this.reply(ws, r, "error", { message: "房间已结束" });
      return;
    }
    if (frame.type === "join") {
      const p = frame.payload as {
        userId?: string;
        name?: string;
        password?: string;
        protocol?: number;
        modChecksum?: string;
      };
      if (p.protocol !== ROOM_PROTOCOL_VERSION) {
        this.reply(ws, r, "error", { message: "协议版本不兼容" });
        ws.close();
        return;
      }
      if (r.password && p.password !== r.password) {
        this.reply(ws, r, "error", { message: "密码错误" });
        ws.close();
        return;
      }
      if (r.requireMods && r.modChecksum && p.modChecksum !== r.modChecksum) {
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
      (ws as WebSocket & { userId?: string }).userId = userId;
      this.append(r, {
        kind: "system",
        text: `${name} 加入了房间`,
        authorLabel: "系统",
      });
      this.reply(ws, r, "welcome", this.snapshot(r));
      this.pushState(r);
      return;
    }

    const userId = (ws as WebSocket & { userId?: string }).userId;
    if (!userId) {
      this.reply(ws, r, "error", { message: "请先加入" });
      return;
    }

    if (frame.type === "chat.user") {
      const p = frame.payload as { seatId?: string; text?: string };
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
      this.append(r, {
        kind: "user",
        seatId: seat.id,
        authorUserId: userId,
        authorLabel: this.memberName(r, userId),
        text,
      });
      this.pushState(r);
      if (toAgent) void this.runAgentSeat(r, seat, text);
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
        requireMods: r.requireMods,
        modChecksum: r.modChecksum,
        hostLabel: r.hostLabel,
        ...(r.joinInfo
          ? {
              join: {
                host: r.joinInfo.host,
                hosts: r.joinInfo.hosts,
                port: r.joinInfo.port,
                password: r.joinInfo.password,
                modChecksum: r.joinInfo.modChecksum,
                secret: r.joinInfo.secret,
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
      members: r.members,
      seats: r.seats,
      items: r.items,
      localUserId: r.localUserId || undefined,
    };
  }

  private pushState(r: RoomRecord) {
    this.persist(r);
    this.broadcast(r, "state.snapshot", this.snapshot(r));
    this.emit(r);
  }

  private broadcast(r: RoomRecord, type: RoomFrame["type"], payload: unknown) {
    r.seq += 1;
    const raw = JSON.stringify(makeRoomFrame(r.roomId, r.seq, type, payload));
    for (const g of r.guests) {
      if (g.readyState === WebSocket.OPEN) g.send(raw);
    }
  }

  private reply(
    ws: WebSocket,
    r: RoomRecord,
    type: RoomFrame["type"],
    payload: unknown,
  ) {
    r.seq += 1;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(makeRoomFrame(r.roomId, r.seq, type, payload)));
    }
  }

  private sendClient(r: RoomRecord, type: RoomFrame["type"], payload: unknown) {
    if (!r.client || r.client.readyState !== WebSocket.OPEN) return;
    r.seq += 1;
    r.client.send(JSON.stringify(makeRoomFrame(r.roomId, r.seq, type, payload)));
  }

  private emit(r: RoomRecord) {
    this.safeSend(IPC.roomEvent, {
      roomId: r.roomId,
      room: this.snapshot(r),
    });
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
}
