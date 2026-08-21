import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  IPC,
  ROOM_PROTOCOL_VERSION,
  deriveSessionKey,
  fingerprintPublic,
  generateDeviceKeys,
  makeHandshake,
  makeRoomFrame,
  openEnvelope,
  parsePdu,
  parseRoomFrame,
  provePassword,
  sealEnvelope,
  type Handshake,
  type RoomSnapshot,
} from "@claude-desktop/shared";
import { RoomService } from "./room-service";
import { RoomMetrics } from "./room-metrics";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

const dirs: string[] = [];
const services: RoomService[] = [];

afterEach(() => {
  for (const s of [...services].reverse()) {
    try {
      s.disposeAll();
    } catch {
      // ignore
    }
  }
  services.length = 0;
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dirs.length = 0;
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-transport-"));
  dirs.push(d);
  return d;
}

function mockWindow(onSend?: (channel: string, payload: unknown) => void) {
  return () =>
    ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => onSend?.(channel, payload),
      },
    }) as never;
}

function mockSessions() {
  return {
    start: vi.fn().mockResolvedValue("sess-agent"),
    continue: vi.fn().mockResolvedValue(undefined),
    getTranscript: vi.fn().mockReturnValue([]),
    abort: vi.fn(),
    syncExtras: vi.fn(),
  } as unknown as SessionManager;
}

function mockSettings(project: string) {
  return {
    get: vi.fn().mockReturnValue({ lastProjectPath: project }),
  } as unknown as SettingsStore;
}

function makeRooms(
  onSend?: (channel: string, payload: unknown) => void,
): RoomService {
  const userDataDir = tmp();
  const rooms = new RoomService({
    getWindow: mockWindow(onSend),
    sessions: mockSessions(),
    settings: mockSettings(userDataDir),
    userDataDir,
    archive: null,
    // Keep the [room-metrics] console.info lines out of the test output.
    metrics: new RoomMetrics(() => {}),
  });
  services.push(rooms);
  return rooms;
}

async function createHost(
  rooms: RoomService,
  opts?: {
    name?: string;
    password?: string;
    encrypt?: boolean;
    autoApprove?: boolean;
  },
): Promise<{ room: RoomSnapshot; port: number }> {
  let last = "";
  for (let i = 0; i < 10; i++) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const res = await rooms.create({
      name: opts?.name ?? "t",
      port,
      password: opts?.password,
      encrypt: opts?.encrypt,
      autoApprove: opts?.autoApprove ?? true,
    });
    if (res.ok && res.room) return { room: res.room, port };
    last = res.error ?? "create failed";
  }
  throw new Error(last);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitOpen(ws: WebSocket, ms = 5000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), ms);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

/** Resolve with the first handshake message of the given type. */
function waitHs(ws: WebSocket, type: string, ms = 5000): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting hs.${type}`)), ms);
    const onMsg = (data: RawData) => {
      const pdu = parsePdu(String(data));
      if (pdu?.kind !== "hs" || pdu.hs.type !== type) return;
      clearTimeout(t);
      ws.off("message", onMsg);
      resolve(pdu.hs);
    };
    ws.on("message", onMsg);
  });
}

/** Resolve with the raw text of the first non-handshake message. */
function waitNonHs(ws: WebSocket, ms = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting non-hs message")), ms);
    const onMsg = (data: RawData) => {
      const raw = String(data);
      const pdu = parsePdu(raw);
      if (!pdu || pdu.kind === "hs") return;
      clearTimeout(t);
      ws.off("message", onMsg);
      resolve(raw);
    };
    ws.on("message", onMsg);
  });
}

function waitClose(ws: WebSocket, ms = 2000): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    ws.once("close", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Raw-socket handshake: hello → challenge → prove → ok. Returns session context. */
async function rawHandshake(
  ws: WebSocket,
  password: string,
): Promise<{
  key: Buffer;
  kid: string;
  guestFp: string;
  hostFp: string;
  encrypt: boolean;
}> {
  const keys = generateDeviceKeys();
  const guestFp = fingerprintPublic(keys.publicRaw);
  ws.send(
    JSON.stringify(
      makeHandshake("hello", {
        pub: keys.publicRaw.toString("base64url"),
        fp: guestFp,
        name: "raw",
      }),
    ),
  );
  const challenge = await waitHs(ws, "challenge");
  const cp = challenge.payload as {
    pub: string;
    fp: string;
    nonce: string;
    encrypt: boolean;
  };
  const key = deriveSessionKey(keys, Buffer.from(cp.pub, "base64url"));
  const proof = provePassword({
    password,
    nonce: Buffer.from(cp.nonce, "base64url"),
    hostFp: cp.fp,
    guestFp,
    ecdhSs: key,
  });
  ws.send(JSON.stringify(makeHandshake("prove", { proof })));
  const ok = await waitHs(ws, "ok");
  const op = ok.payload as { kid: string; encrypt: boolean };
  return { key, kid: op.kid, guestFp, hostFp: cp.fp, encrypt: op.encrypt };
}

describe("room transport: handshake + encrypted frames", () => {
  it("encrypted join succeeds; welcome travels inside an AEAD envelope", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });
    expect(room.encrypt).toBe(true);
    const hostFp = room.hostFingerprint ?? "";
    expect(hostFp).toMatch(/^[0-9a-f]{64}$/);

    // Service-level guest join (handshake + encrypted join).
    const guest = makeRooms();
    const res = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: hostFp,
    });
    expect(res.ok).toBe(true);
    expect(res.room?.encrypt).toBe(true);

    // Raw-socket guest: verify the wire format directly.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    const hs = await rawHandshake(ws, "pw");
    expect(hs.encrypt).toBe(true);
    expect(hs.hostFp).toBe(hostFp);

    const joinFrame = makeRoomFrame("pending", 1, "join", {
      userId: "raw-user-1",
      name: "raw",
      protocol: ROOM_PROTOCOL_VERSION,
      modChecksum: "",
    });
    const env = sealEnvelope({
      key: hs.key,
      kid: hs.kid,
      sendSeq: 1n,
      fromFp: hs.guestFp,
      plain: Buffer.from(JSON.stringify(joinFrame), "utf8"),
    });
    ws.send(JSON.stringify(env));

    // First non-handshake message must be an AEAD envelope decrypting to welcome.
    const first = parsePdu(await waitNonHs(ws));
    expect(first?.kind).toBe("env");
    if (first?.kind !== "env") throw new Error("unreachable");
    const opened = openEnvelope({
      key: hs.key,
      env: first.env,
      expectKid: hs.kid,
      seenNonces: new Set(),
    });
    const welcome = parseRoomFrame(opened.plain.toString("utf8"));
    expect(welcome?.type).toBe("welcome");
    ws.close();
  });

  it("wrong password is rejected with reason=password and no snapshot follows", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });

    const guest = makeRooms();
    const res = await guest.join({
      host: "127.0.0.1",
      port,
      password: "nope",
      hostFingerprint: room.hostFingerprint,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/密码/);

    // Raw socket: bad proof → hs.reject { reason: "password" } then close.
    const keys = generateDeviceKeys();
    const guestFp = fingerprintPublic(keys.publicRaw);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    ws.send(
      JSON.stringify(
        makeHandshake("hello", {
          pub: keys.publicRaw.toString("base64url"),
          fp: guestFp,
          name: "raw",
        }),
      ),
    );
    const challenge = await waitHs(ws, "challenge");
    const cp = challenge.payload as { pub: string; fp: string; nonce: string };
    const key = deriveSessionKey(keys, Buffer.from(cp.pub, "base64url"));
    const badProof = provePassword({
      password: "nope",
      nonce: Buffer.from(cp.nonce, "base64url"),
      hostFp: cp.fp,
      guestFp,
      ecdhSs: key,
    });
    ws.send(JSON.stringify(makeHandshake("prove", { proof: badProof })));
    const reject = await waitHs(ws, "reject");
    expect((reject.payload as { reason: string }).reason).toBe("password");

    const later: string[] = [];
    ws.on("message", (d) => later.push(String(d)));
    await waitClose(ws);
    expect(
      later.some((m) => parseRoomFrame(m)?.type === "state.snapshot"),
    ).toBe(false);
  });

  it("skip-encrypt room still accepts today's plaintext join frame", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { encrypt: false });
    expect(room.encrypt).toBe(false);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    const welcomePending = new Promise<ReturnType<typeof parseRoomFrame>>(
      (resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout waiting welcome")), 5000);
        const onMsg = (data: RawData) => {
          const frame = parseRoomFrame(String(data));
          if (frame?.type === "welcome" || frame?.type === "error") {
            clearTimeout(t);
            ws.off("message", onMsg);
            resolve(frame);
          }
        };
        ws.on("message", onMsg);
      },
    );
    ws.send(
      JSON.stringify(
        makeRoomFrame("pending", 1, "join", {
          userId: "plain-1",
          name: "plain",
          password: "",
          protocol: ROOM_PROTOCOL_VERSION,
          modChecksum: "",
        }),
      ),
    );
    const welcome = await welcomePending;
    expect(welcome?.type).toBe("welcome");
    ws.close();
  });

  it("slots a T0 connect ok and a password handshake failure separately (task 12)", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });

    // Wrong password: host counts a password handshake failure; the guest
    // counts its T0 connect ok plus the same reject from its own side.
    const badGuest = makeRooms();
    const bad = await badGuest.join({
      host: "127.0.0.1",
      port,
      password: "nope",
      hostFingerprint: room.hostFingerprint,
    });
    expect(bad.ok).toBe(false);
    expect(host.metrics.snapshot().handshake.password).toBe(1);
    expect(host.metrics.snapshot().handshake.ok).toBe(0);
    expect(badGuest.metrics.snapshot().connect.T0).toEqual({ ok: 1, fail: 0 });
    expect(badGuest.metrics.snapshot().handshake.password).toBe(1);

    // Right password: both sides count handshake ok; host fan-out flows.
    const guest = makeRooms();
    const ok = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(ok.ok).toBe(true);
    expect(guest.metrics.snapshot().connect.T0).toEqual({ ok: 1, fail: 0 });
    expect(guest.metrics.snapshot().handshake.ok).toBe(1);
    const hostSnap = host.metrics.snapshot();
    expect(hostSnap.handshake.ok).toBe(1);
    expect(hostSnap.fanoutBytes).toBeGreaterThan(0);
  });
});

describe("room transport: reconnect", () => {
  it("reconnects via handshake and receives a fresh snapshot within 3s", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });
    const events: Array<{
      roomId?: string;
      reconnecting?: boolean;
      reconnectAttempt?: number;
      room?: RoomSnapshot;
    }> = [];
    const guest = makeRooms((ch, p) => {
      if (ch === IPC.roomEvent) events.push(p as (typeof events)[number]);
    });
    const res = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(res.ok).toBe(true);

    // Simulate a network drop: kill the guest's underlying socket while the
    // host process stays up.
    const guestRecs = guest as unknown as {
      rooms: Map<string, { client?: WebSocket | null }>;
    };
    const grec = guestRecs.rooms.get(room.roomId);
    expect(grec?.client).toBeTruthy();
    grec!.client!.terminate();

    // Within 3s: a reconnect is announced, then a fresh open snapshot lands.
    const deadline = Date.now() + 3000;
    let sawReconnecting = false;
    let reopened: RoomSnapshot | undefined;
    while (Date.now() < deadline && !reopened) {
      for (const e of events) {
        if (e.roomId !== room.roomId) continue;
        if (e.reconnecting) {
          sawReconnecting = true;
          continue;
        }
        if (sawReconnecting && e.room?.status === "open") reopened = e.room;
      }
      if (!reopened) await sleep(50);
    }
    expect(sawReconnecting).toBe(true);
    expect(reopened).toBeTruthy();
    expect(
      reopened!.items.some((i) => i.text.includes("已重新连接")),
    ).toBe(true);
    expect(guest.get(room.roomId)?.status).toBe("open");
  });

  it("does not reconnect after the host ends the room", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });
    const events: Array<{
      roomId?: string;
      reconnecting?: boolean;
      closed?: boolean;
    }> = [];
    const guest = makeRooms((ch, p) => {
      if (ch === IPC.roomEvent) events.push(p as (typeof events)[number]);
    });
    const res = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(res.ok).toBe(true);

    expect(host.end(room.roomId).ok).toBe(true);

    // Wait past the first reconnect backoff (1s): any reconnect attempt
    // would have shown up in the event log by then.
    await sleep(1500);
    const forRoom = events.filter((e) => e.roomId === room.roomId);
    expect(forRoom.some((e) => e.closed)).toBe(true);
    expect(forRoom.some((e) => e.reconnecting)).toBe(false);
    expect(guest.get(room.roomId)?.status).toBe("ended");
  });

  it("gives up after 5 backoff attempts and keeps the room offline", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });
    const events: Array<{
      roomId?: string;
      reconnecting?: boolean;
      reconnectAttempt?: number;
      closed?: boolean;
      offline?: boolean;
    }> = [];
    const guest = makeRooms((ch, p) => {
      if (ch === IPC.roomEvent) events.push(p as (typeof events)[number]);
    });
    const res = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(res.ok).toBe(true);

    // Injectable backoff: make the 1s/2s/4s/8s/8s waits instant.
    const guestSvc = guest as unknown as {
      rooms: Map<string, { client?: WebSocket | null }>;
      reconnectSleep: (ms: number) => Promise<void>;
    };
    guestSvc.reconnectSleep = () => Promise.resolve();

    // Host dies without room.closed (crash): close server + cut sockets.
    const hostSvc = host as unknown as {
      rooms: Map<string, {
        server?: { close(): void } | null;
        guests: Set<WebSocket>;
      }>;
    };
    const hrec = hostSvc.rooms.get(room.roomId)!;
    for (const g of hrec.guests) g.terminate();
    hrec.server?.close();

    const deadline = Date.now() + 5000;
    let offlineEv: (typeof events)[number] | undefined;
    while (Date.now() < deadline && !offlineEv) {
      offlineEv = events.find(
        (e) => e.roomId === room.roomId && e.closed && e.offline,
      );
      if (!offlineEv) await sleep(50);
    }
    expect(offlineEv).toBeTruthy();
    const attempts = events.filter(
      (e) => e.roomId === room.roomId && e.reconnecting,
    );
    expect(attempts.map((a) => a.reconnectAttempt)).toEqual([1, 2, 3, 4, 5]);
    expect(guest.get(room.roomId)?.status).toBe("ended");
    expect(guest.list().find((l) => l.roomId === room.roomId)?.offline).toBe(
      true,
    );
  });
});

describe("room transport: approval, TOFU, kick", () => {
  it("pending device does not receive snapshot until approved", async () => {
    const events: Array<{ pending?: Array<{ fp: string; name: string }> }> = [];
    const host = makeRooms((ch, p) => {
      if (ch === IPC.roomEvent) {
        events.push(p as (typeof events)[number]);
      }
    });
    const { room, port } = await createHost(host, {
      password: "pw",
      autoApprove: false,
    });
    const guest = makeRooms();

    const joinP = guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });

    // 待审批期间：join() 阻塞、本地不建 RoomRecord 席位、收不到快照
    await sleep(150);
    const pend = host.pendingDevices(room.roomId);
    expect(pend.ok).toBe(true);
    expect(pend.pending).toHaveLength(1);
    expect(guest.list()).toHaveLength(0);
    expect(events.some((e) => (e.pending?.length ?? 0) > 0)).toBe(true);

    // 房主 100ms 后批准 → 客人完成加入
    const fp = pend.pending[0].fp;
    setTimeout(() => {
      host.approveDevice(room.roomId, fp);
    }, 100);
    const res = await joinP;
    expect(res.ok).toBe(true);
    expect(res.room?.roomId).toBe(room.roomId);
    expect(host.pendingDevices(room.roomId).pending).toHaveLength(0);
  });

  it("blacklisted fingerprint is rejected after kick", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });
    const guest = makeRooms();
    const res = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(res.ok).toBe(true);

    const member = host
      .get(room.roomId)
      ?.members.find((m) => m.role === "member");
    expect(member).toBeTruthy();
    expect(host.kick(room.roomId, member!.userId).ok).toBe(true);

    // 客人被踢：连接断，本地解散（不自动重连）
    await sleep(300);
    expect(guest.get(room.roomId)?.status).toBe("ended");

    // 同一设备指纹持旧邀请码重连 → hs.reject { reason: "blacklist" }
    const re = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(re.ok).toBe(false);
    expect(re.error).toMatch(/拉黑/);
  });

  it("fingerprint change requires re-approval", async () => {
    const events: Array<{
      fingerprintChanged?: boolean;
      pending?: Array<{ fp: string; name: string }>;
    }> = [];
    const host = makeRooms((ch, p) => {
      if (ch === IPC.roomEvent) {
        events.push(p as (typeof events)[number]);
      }
    });
    // autoApprove 开着：新设备本来会放行
    const { room, port } = await createHost(host, { password: "pw" });
    const guest1 = makeRooms();
    const res1 = await guest1.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
      userId: "user-x",
    });
    expect(res1.ok).toBe(true);

    // 同一 userId 换设备钥（新指纹）再来：告警 + 重新审批，不自动 ok
    const guest2 = makeRooms();
    let settled = false;
    const join2 = guest2
      .join({
        host: "127.0.0.1",
        port,
        password: "pw",
        hostFingerprint: room.hostFingerprint,
        userId: "user-x",
      })
      .then((r) => {
        settled = true;
        return r;
      });
    await sleep(150);
    expect(settled).toBe(false);
    const pend = host.pendingDevices(room.roomId);
    expect(pend.pending).toHaveLength(1);
    expect(events.some((e) => e.fingerprintChanged)).toBe(true);

    expect(host.approveDevice(room.roomId, pend.pending[0].fp).ok).toBe(true);
    const res2 = await join2;
    expect(res2.ok).toBe(true);
  });
});
