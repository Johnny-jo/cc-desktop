import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeRoomInvite, type RoomSnapshot } from "@claude-desktop/shared";
import { startRoomRelay, type RoomRelayResult } from "./room-relay";
import { RoomService } from "./room-service";
import { RoomMetrics } from "./room-metrics";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

// The real relay script runs as a child process via the current Node — the
// same file users deploy to a VPS (`node room-relay-server.mjs --port …`).
const RELAY_SCRIPT = path.resolve(
  __dirname,
  "../../../../scripts/room-relay-server.mjs",
);

const dirs: string[] = [];
const relays: ChildProcess[] = [];
const kills: Array<() => void> = [];
const services: RoomService[] = [];
const silentServers: net.Server[] = [];
const silentSockets = new Set<net.Socket>();

afterEach(() => {
  for (const kill of kills.splice(0)) {
    try {
      kill();
    } catch {
      // ignore
    }
  }
  for (const s of services.splice(0)) {
    try {
      s.disposeAll();
    } catch {
      // ignore
    }
  }
  for (const p of relays.splice(0)) {
    try {
      p.kill();
    } catch {
      // ignore
    }
  }
  for (const sock of [...silentSockets]) {
    try {
      sock.destroy();
    } catch {
      // ignore
    }
  }
  for (const s of silentServers.splice(0)) {
    try {
      s.close();
    } catch {
      // ignore
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-relay-"));
  dirs.push(d);
  return d;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn the real relay script and wait for its "listening" stdout line. */
async function spawnRelay(
  port: number,
  token?: string,
): Promise<{ port: number; url: string; out: () => string }> {
  const args = [RELAY_SCRIPT, "--port", String(port)];
  if (token) args.push("--token", token);
  const proc = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  relays.push(proc);
  let buf = "";
  proc.stdout!.on("data", (c: Buffer) => {
    buf += String(c);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`relay start timeout: ${buf}`)),
      10_000,
    );
    const onData = () => {
      if (/listening/.test(buf)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout!.on("data", onData);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited (${code}): ${buf}`));
    });
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { port, url: `ws://127.0.0.1:${port}`, out: () => buf };
}

async function startRelay(opts?: {
  token?: string;
}): Promise<{ port: number; url: string; out: () => string }> {
  return spawnRelay(await freePort(), opts?.token);
}

/** Rebind a relay on a port whose previous process was just killed. */
async function respawnRelay(
  port: number,
): Promise<{ port: number; url: string; out: () => string }> {
  let lastErr: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      return await spawnRelay(port);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

function keep(res: RoomRelayResult): RoomRelayResult {
  if (res.ok) kills.push(res.kill);
  return res;
}

describe("startRoomRelay (client)", () => {
  it("registers a room id and reports the public join url", async () => {
    const relay = await startRelay();
    const res = keep(
      await startRoomRelay({
        relay: relay.url,
        roomId: "0123456789ab",
        localPort: 1,
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.url).toBe(`${relay.url}/r/0123456789ab`);
    // kill is idempotent
    if (res.ok) {
      res.kill();
      res.kill();
    }
  });

  it("reports 中继服务器不可达 when nothing listens on the relay address", async () => {
    const port = await freePort();
    const res = await startRoomRelay({
      relay: `ws://127.0.0.1:${port}`,
      roomId: "0123456789ab",
      localPort: 1,
      timeoutMs: 3000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("中继服务器不可达");
  });

  it("reports 中继 token 错误 when the token mismatches", async () => {
    const relay = await startRelay({ token: "secret-token" });
    const res = await startRoomRelay({
      relay: relay.url,
      token: "nope",
      roomId: "0123456789ab",
      localPort: 1,
      timeoutMs: 5000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("中继 token 错误");
  });

  it("accepts the matching token", async () => {
    const relay = await startRelay({ token: "secret-token" });
    const res = keep(
      await startRoomRelay({
        relay: relay.url,
        token: "secret-token",
        roomId: "0123456789ab",
        localPort: 1,
      }),
    );
    expect(res.ok).toBe(true);
  });

  it("rejects a second ctl with the same room id (4409 → 中继 id 被占用)", async () => {
    const relay = await startRelay();
    const first = keep(
      await startRoomRelay({
        relay: relay.url,
        roomId: "aabbccddeeff",
        localPort: 1,
      }),
    );
    expect(first.ok).toBe(true);
    const second = await startRoomRelay({
      relay: relay.url,
      roomId: "aabbccddeeff",
      localPort: 1,
      timeoutMs: 5000,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("中继 id 被占用");
  });

  it("times out with 中继握手超时 when the server never answers", async () => {
    // Accepts TCP but never completes the ws upgrade.
    const silent = net.createServer((sock) => {
      silentSockets.add(sock);
      sock.on("close", () => silentSockets.delete(sock));
      sock.on("error", () => {});
    });
    silentServers.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as net.AddressInfo).port;
    const res = await startRoomRelay({
      relay: `ws://127.0.0.1:${port}`,
      roomId: "0123456789ab",
      localPort: 1,
      timeoutMs: 300,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("中继握手超时");
  });

  it("rejects a relay address without a ws/wss scheme", async () => {
    const res = await startRoomRelay({
      relay: "http://example.com",
      roomId: "0123456789ab",
      localPort: 1,
      timeoutMs: 300,
    });
    expect(res.ok).toBe(false);
  });

  it(
    "re-registers the same room id after the relay restarts",
    async () => {
      const first = await startRelay();
      const roomId = "ff0011223344";
      const res = keep(
        await startRoomRelay({ relay: first.url, roomId, localPort: 1 }),
      );
      expect(res.ok).toBe(true);

      // Bounce the relay; the client's 3s ctl reconnect must re-register the
      // same room id on the fresh process (visible in its stdout log).
      const dead = relays[relays.length - 1]!;
      dead.kill();
      const second = await respawnRelay(first.port);

      await vi.waitFor(
        () => {
          expect(second.out()).toContain(`ctl registered id=${roomId}`);
        },
        { timeout: 15_000, interval: 250 },
      );
    },
    30_000,
  );
});

// --- RoomService integration -------------------------------------------------

function mockWindow() {
  return () =>
    ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: () => {} },
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

function makeRooms(): RoomService {
  const userDataDir = tmp();
  const rooms = new RoomService({
    getWindow: mockWindow(),
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

async function createRelayHost(
  rooms: RoomService,
  relay: string,
  password = "pw",
): Promise<RoomSnapshot> {
  let last = "create failed";
  for (let i = 0; i < 10; i++) {
    const res = await rooms.create({
      name: "t",
      port: 21000 + Math.floor(Math.random() * 20000),
      password,
      autoApprove: true,
      relay,
    });
    if (res.ok && res.room) return res.room;
    last = res.error ?? last;
  }
  throw new Error(last);
}

describe("RoomService relay option", () => {
  it(
    "guest joins through the relay and the host receives its chat (relay + AEAD)",
    async () => {
      const relay = await startRelay();
      const host = makeRooms();
      const room = await createRelayHost(host, relay.url);
      // A relayed room is forced onto the encrypted transport.
      expect(room.encrypt).toBe(true);

      const inv = host.invite(room.roomId);
      expect(inv.ok).toBe(true);
      const decoded = decodeRoomInvite(inv.secret!);
      const relayUrl = (decoded.wss ?? []).find((u) =>
        u.includes(`:${relay.port}/`),
      );
      expect(relayUrl).toMatch(
        new RegExp(`^ws://127\\.0\\.0\\.1:${relay.port}/r/[0-9a-f]{12}$`),
      );

      const guest = makeRooms();
      const joined = await guest.join({
        // TEST-NET-1 + port 1: the LAN candidate can never win, so the join
        // must go through the relay candidate.
        host: "192.0.0.1",
        port: 1,
        password: "pw",
        wss: [relayUrl!],
        hostFingerprint: room.hostFingerprint,
      });
      expect(joined.ok).toBe(true);

      const gSnap = guest.get(joined.room!.roomId)!;
      const gSeat = gSnap.seats.find(
        (s) => s.occupantUserId === gSnap.localUserId,
      );
      expect(gSeat).toBeTruthy();
      const sent = await guest.send(
        joined.room!.roomId,
        gSeat!.id,
        "hello via relay",
      );
      expect(sent.ok).toBe(true);

      await vi.waitFor(
        () => {
          const items = host.get(room.roomId)!.items;
          expect(
            items.some(
              (i) => i.kind === "user" && i.text === "hello via relay",
            ),
          ).toBe(true);
        },
        { timeout: 10_000 },
      );
    },
    30_000,
  );

  it(
    "relay outage degrades create to a LAN-only room without failing",
    async () => {
      const deadPort = await freePort();
      const rooms = makeRooms();
      const room = await createRelayHost(rooms, `ws://127.0.0.1:${deadPort}`);
      // relay forces encryption even when the relay itself is down.
      expect(room.encrypt).toBe(true);
      const inv = rooms.invite(room.roomId);
      expect(inv.ok).toBe(true);
      const decoded = decodeRoomInvite(inv.secret ?? "");
      expect(decoded.wss ?? []).toEqual([]);
      const items = rooms.get(room.roomId)!.items;
      expect(items.some((i) => i.text.includes("中继不可用"))).toBe(true);
    },
    30_000,
  );
});
