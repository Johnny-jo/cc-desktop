import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeRoomInvite, type RoomSnapshot } from "@claude-desktop/shared";
import { RoomArchive } from "./room-archive";
import { RoomMetrics } from "./room-metrics";
import { RoomService } from "./room-service";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

// Resume-hosting tests: a "restart" is a second RoomService instance on the
// SAME userDataDir (same device keys → same fingerprint; same archive). The
// old instance is stopped with disposeAll(), which closes servers / tunnels /
// relay channels WITHOUT touching the archive — exactly what a process exit
// (crash or clean quit) leaves behind: the room stays "open" on disk.

const RELAY_SCRIPT = path.resolve(
  __dirname,
  "../../../../scripts/room-relay-server.mjs",
);

// Same trick as room-tunnel.test.ts: a fake cloudflared is a node script.
const QUICK_FAKE = `// fake cloudflared quick tunnel: print the URL, then stay alive
console.log("INF |  https://abc-def-123.trycloudflare.com  |");
setInterval(() => {}, 1000);
`;

const dirs: string[] = [];
const services: RoomService[] = [];
const relays: ChildProcess[] = [];
const blockers: net.Server[] = [];
const blockerSockets = new Set<net.Socket>();

afterEach(() => {
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
  for (const sock of [...blockerSockets]) {
    try {
      sock.destroy();
    } catch {
      // ignore
    }
  }
  for (const b of blockers.splice(0)) {
    try {
      b.close();
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-resume-"));
  dirs.push(d);
  return d;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * A closed ws server releases its port asynchronously (client sockets drain
 * first). A same-process "restart" must wait for that before rebinding.
 */
async function waitPortFree(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "0.0.0.0", () => srv.close(() => resolve(true)));
    });
    if (free) return;
    if (Date.now() > deadline) throw new Error(`port ${port} still busy`);
    await sleep(100);
  }
}

/** Occupy 0.0.0.0:port with a foreign listener (the port-in-use failure). */
function blockPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      blockerSockets.add(sock);
      sock.on("close", () => blockerSockets.delete(sock));
      sock.on("error", () => {});
    });
    blockers.push(srv);
    srv.once("error", reject);
    srv.listen(port, "0.0.0.0", () => resolve());
  });
}

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

/** A RoomService backed by a real RoomArchive under the given userDataDir. */
function makeService(
  userDataDir: string,
  extra?: { cloudflaredPath?: string },
): RoomService {
  const rooms = new RoomService({
    getWindow: mockWindow(),
    sessions: mockSessions(),
    settings: mockSettings(userDataDir),
    userDataDir,
    archive: new RoomArchive(userDataDir),
    ...(extra?.cloudflaredPath
      ? { cloudflaredPath: extra.cloudflaredPath }
      : {}),
    // Keep the [room-metrics] console.info lines out of the test output.
    metrics: new RoomMetrics(() => {}),
  });
  services.push(rooms);
  return rooms;
}

async function createHostRoom(
  svc: RoomService,
  opts: {
    name?: string;
    port: number;
    password?: string;
    relay?: string;
    tunnel?: boolean;
    autoApprove?: boolean;
  },
): Promise<RoomSnapshot> {
  const res = await svc.create({
    name: opts.name ?? "t",
    port: opts.port,
    autoApprove: opts.autoApprove !== false,
    ...(opts.password ? { password: opts.password } : {}),
    ...(opts.relay ? { relay: opts.relay } : {}),
    ...(opts.tunnel ? { tunnel: true } : {}),
  });
  if (!res.ok || !res.room) throw new Error(res.error ?? "create failed");
  return res.room;
}

/** Wait until the resumed room reports open on the new instance. */
async function waitResumed(svc: RoomService, roomId: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(svc.get(roomId)?.status).toBe("open");
    },
    { timeout: 10_000, interval: 50 },
  );
}

// --- real relay process (same spawn pattern as room-relay.test.ts) ----------

async function spawnRelay(
  port: number,
): Promise<{ port: number; url: string; out: () => string }> {
  const proc = spawn(process.execPath, [RELAY_SCRIPT, "--port", String(port)], {
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

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// --- tests -------------------------------------------------------------------

describe("RoomService resume hosting", () => {
  it(
    "resumes an archived open host room on restart; the original invite still works",
    async () => {
      const hostDir = tmp();
      const host1 = makeService(hostDir);
      const port = await freePort();
      const room = await createHostRoom(host1, {
        name: "resumable",
        port,
        password: "pw",
      });
      expect(room.encrypt).toBe(true);
      const inv1 = host1.invite(room.roomId);
      expect(inv1.ok).toBe(true);
      const decoded1 = decodeRoomInvite(inv1.secret!);
      const fingerprint = inv1.hostFingerprint!;
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

      // Guest A joins and posts two messages before the "crash".
      const guestADir = tmp();
      const guestA1 = makeService(guestADir);
      const joinedA = await guestA1.join({
        host: "127.0.0.1",
        port,
        password: "pw",
        hostFingerprint: fingerprint,
      });
      expect(joinedA.ok).toBe(true);
      const aSnap = guestA1.get(room.roomId)!;
      const aSeat = aSnap.seats.find(
        (s) => s.occupantUserId === aSnap.localUserId,
      )!;
      await guestA1.send(room.roomId, aSeat.id, "before-restart-1");
      await guestA1.send(room.roomId, aSeat.id, "before-restart-2");
      await vi.waitFor(
        () => {
          const items = host1.get(room.roomId)!.items;
          expect(items.some((i) => i.text === "before-restart-1")).toBe(true);
          expect(items.some((i) => i.text === "before-restart-2")).toBe(true);
        },
        { timeout: 10_000 },
      );

      // 模拟进程退出：disposeAll 只关 socket/中继/隧道，不改归档状态——
      // 归档里房间仍是 open，与真实崩溃/退出留下的现场一致。
      // 客人先 dispose，避免触发客人侧的自动重连退避定时器。
      guestA1.disposeAll();
      host1.disposeAll();
      await waitPortFree(port);

      // Restart: same userDataDir → same device fingerprint, same archive.
      const host2 = makeService(hostDir);
      await waitResumed(host2, room.roomId);

      // Invite is unchanged: same port, same fingerprint, same password.
      const inv2 = host2.invite(room.roomId);
      expect(inv2.ok).toBe(true);
      expect(inv2.port).toBe(port);
      expect(inv2.hostFingerprint).toBe(fingerprint);
      expect(inv2.password).toBe("pw");
      expect(inv2.listening).toBe(true);
      const decoded2 = decodeRoomInvite(inv2.secret!);
      expect(decoded2.port).toBe(decoded1.port);
      expect(decoded2.hostFingerprint).toBe(decoded1.hostFingerprint);

      // Timeline / members survived the restart.
      const resumed = host2.get(room.roomId)!;
      expect(resumed.items.some((i) => i.text === "before-restart-1")).toBe(
        true,
      );
      expect(resumed.items.some((i) => i.text === "before-restart-2")).toBe(
        true,
      );
      expect(
        resumed.members.some((m) => m.userId === aSnap.localUserId),
      ).toBe(true);

      // Guest B joins with the ORIGINAL invite (same port/fingerprint/password).
      const guestB = makeService(tmp());
      const joinedB = await guestB.join({
        host: "127.0.0.1",
        port: decoded1.port,
        password: "pw",
        hostFingerprint: decoded1.hostFingerprint,
      });
      expect(joinedB.ok).toBe(true);
      const bSnap = guestB.get(room.roomId)!;
      expect(bSnap.items.some((i) => i.text === "before-restart-1")).toBe(true);
      expect(bSnap.items.some((i) => i.text === "before-restart-2")).toBe(true);

      // Guest A restarts its own app (same userDataDir) and rejoins with the
      // archived identity — the host kept its seat.
      const guestA2 = makeService(guestADir);
      expect(guestA2.get(room.roomId)?.status).toBe("ended"); // member rooms never resume
      const rejoined = await guestA2.rejoin(room.roomId);
      expect(rejoined.ok).toBe(true);
      expect(rejoined.room?.localUserId).toBe(aSnap.localUserId);
      expect(
        rejoined.room!.items.some((i) => i.text === "before-restart-1"),
      ).toBe(true);
    },
    40_000,
  );

  it(
    "restores approved devices so a known guest does not wait for approval after host restart",
    async () => {
      const hostDir = tmp();
      const host1 = makeService(hostDir);
      const port = await freePort();
      const room = await createHostRoom(host1, {
        port,
        password: "pw",
        autoApprove: false,
      });
      const guestDir = tmp();
      const guest1 = makeService(guestDir);
      const joinP = guest1.join({
        host: "127.0.0.1",
        port,
        password: "pw",
        hostFingerprint: room.hostFingerprint,
      });
      await vi.waitFor(
        () => {
          expect(host1.pendingDevices(room.roomId).pending.length).toBe(1);
        },
        { timeout: 8_000 },
      );
      const fp = host1.pendingDevices(room.roomId).pending[0].fp;
      expect(host1.approveDevice(room.roomId, fp).ok).toBe(true);
      const joined = await joinP;
      expect(joined.ok).toBe(true);

      host1.disposeAll();
      await waitPortFree(port);
      const host2 = makeService(hostDir);
      await waitResumed(host2, room.roomId);

      const guest2 = makeService(guestDir);
      const rejoin = await guest2.join({
        host: "127.0.0.1",
        port,
        password: "pw",
        hostFingerprint: room.hostFingerprint,
      });
      expect(rejoin.ok).toBe(true);
      expect(host2.pendingDevices(room.roomId).pending).toHaveLength(0);
    },
    40_000,
  );

  it(
    "re-registers the same relay room id after restart, so the relay invite URL is stable",
    async () => {
      const relay = await spawnRelay(await freePort());
      const hostDir = tmp();
      const host1 = makeService(hostDir);
      const port = await freePort();
      const room = await createHostRoom(host1, {
        port,
        password: "pw",
        relay: relay.url,
      });
      expect(room.encrypt).toBe(true);
      const inv1 = host1.invite(room.roomId);
      const relayUrl1 = (decodeRoomInvite(inv1.secret!).wss ?? []).find((u) =>
        u.includes(`:${relay.port}/`),
      )!;
      expect(relayUrl1).toMatch(
        new RegExp(`^ws://127\\.0\\.0\\.1:${relay.port}/r/[0-9a-f]{12}$`),
      );
      const relayRoomId = relayUrl1.split("/r/")[1]!;

      // "Exit": the relay ctl channel closes and the relay frees the room id.
      host1.disposeAll();
      await vi.waitFor(
        () => {
          expect(relay.out()).toContain(`ctl closed id=${relayRoomId}`);
        },
        { timeout: 10_000, interval: 100 },
      );
      await waitPortFree(port);

      const host2 = makeService(hostDir);
      await waitResumed(host2, room.roomId);
      // Resume re-registers the SAME room id → the old invite URL is back.
      await vi.waitFor(
        () => {
          const wss =
            decodeRoomInvite(host2.invite(room.roomId).secret!).wss ?? [];
          expect(wss).toContain(relayUrl1);
        },
        { timeout: 15_000, interval: 200 },
      );
      expect(
        countOccurrences(relay.out(), `ctl registered id=${relayRoomId}`),
      ).toBeGreaterThanOrEqual(2);

      // A guest can still join through the ORIGINAL relay URL.
      const guest = makeService(tmp());
      const joined = await guest.join({
        // Dead LAN candidate forces the relay path (see room-relay.test.ts).
        host: "192.0.0.1",
        port: 1,
        password: "pw",
        wss: [relayUrl1],
        hostFingerprint: inv1.hostFingerprint,
      });
      expect(joined.ok).toBe(true);
    },
    40_000,
  );

  it(
    "restarts a quick tunnel with a new URL and notes the stale tunnel entry in the timeline",
    async () => {
      const fakeDir = tmp();
      const fake = path.join(fakeDir, "fake-cloudflared.js");
      fs.writeFileSync(fake, QUICK_FAKE, "utf8");
      const hostDir = tmp();
      const host1 = makeService(hostDir, { cloudflaredPath: fake });
      const port = await freePort();
      const room = await createHostRoom(host1, { port, tunnel: true });
      expect(
        decodeRoomInvite(host1.invite(room.roomId).secret!).wss ?? [],
      ).toContain("wss://abc-def-123.trycloudflare.com");

      host1.disposeAll();
      await waitPortFree(port);

      const host2 = makeService(hostDir, { cloudflaredPath: fake });
      await vi.waitFor(
        () => {
          expect(host2.get(room.roomId)?.status).toBe("open");
          const wss =
            decodeRoomInvite(host2.invite(room.roomId).secret!).wss ?? [];
          // The fake always prints the same URL; a real quick tunnel would
          // return a fresh random one. Either way it lands in the invite.
          expect(wss).toContain("wss://abc-def-123.trycloudflare.com");
        },
        { timeout: 15_000, interval: 200 },
      );
      const items = host2.get(room.roomId)!.items;
      expect(
        items.some((i) => i.kind === "system" && i.text.includes("隧道地址已更新")),
      ).toBe(true);
    },
    40_000,
  );

  it(
    "marks the room ended with a system message when the old port is taken; other rooms still resume",
    async () => {
      const hostDir = tmp();
      const host1 = makeService(hostDir);
      const portA = await freePort();
      const portB = await freePort();
      const roomA = await createHostRoom(host1, { name: "a", port: portA });
      const roomB = await createHostRoom(host1, { name: "b", port: portB });
      host1.disposeAll();
      await waitPortFree(portA);
      await waitPortFree(portB);

      // A foreign process now holds A's old port.
      await blockPort(portA);

      // Restart must not throw: A fails closed, B comes back.
      const host2 = makeService(hostDir);
      await vi.waitFor(
        () => {
          const snap = host2.get(roomA.roomId);
          expect(snap?.status).toBe("ended");
          expect(
            snap!.items.some(
              (i) =>
                i.kind === "system" && i.text.includes("自动恢复开房失败"),
            ),
          ).toBe(true);
        },
        { timeout: 10_000, interval: 100 },
      );
      await waitResumed(host2, roomB.roomId);
      // The failed room stays in the list for browsing; the archive matches.
      expect(host2.list().some((l) => l.roomId === roomA.roomId)).toBe(true);
      expect(
        new RoomArchive(hostDir).loadRoom(roomA.roomId)?.status,
      ).toBe("ended");
    },
    40_000,
  );

  it("never resumes member (guest) rooms — they stay ended for manual rejoin", async () => {
    const hostDir = tmp();
    const host1 = makeService(hostDir);
    const port = await freePort();
    const room = await createHostRoom(host1, { port, password: "pw" });

    const guestDir = tmp();
    const guest1 = makeService(guestDir);
    const joined = await guest1.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(joined.ok).toBe(true);

    guest1.disposeAll();
    host1.disposeAll();
    await waitPortFree(port);

    // Guest restart: hydrate is synchronous in the constructor; a member
    // room must come back ended and must NOT dial out by itself.
    const guest2 = makeService(guestDir);
    expect(guest2.get(room.roomId)?.status).toBe("ended");
    await sleep(300);
    expect(guest2.get(room.roomId)?.status).toBe("ended");

    // Manual rejoin still works once the host resumed.
    const host2 = makeService(hostDir);
    await waitResumed(host2, room.roomId);
    const rejoined = await guest2.rejoin(room.roomId);
    expect(rejoined.ok).toBe(true);
  }, 40_000);
});
