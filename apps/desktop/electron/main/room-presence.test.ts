import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-presence-"));
  dirs.push(d);
  return d;
}

function mockWindow() {
  return () =>
    ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: () => undefined },
    }) as never;
}

function mockSessions() {
  return {
    start: vi.fn().mockResolvedValue("sess-local"),
    continue: vi.fn().mockResolvedValue(undefined),
    getTranscript: vi.fn().mockReturnValue([]),
    getChangesForSelect: vi.fn().mockReturnValue([]),
    abort: vi.fn(),
    syncExtras: vi.fn(),
  } as unknown as SessionManager;
}

function makeService(): RoomService {
  const userDataDir = tmp();
  const svc = new RoomService({
    getWindow: mockWindow(),
    sessions: mockSessions(),
    settings: {
      get: vi.fn(() => ({ lastProjectPath: userDataDir })),
    } as unknown as SettingsStore,
    userDataDir,
    archive: null,
    metrics: new RoomMetrics(() => {}),
  });
  services.push(svc);
  return svc;
}

async function createHost(svc: RoomService): Promise<{ roomId: string; port: number }> {
  let last = "";
  for (let i = 0; i < 10; i++) {
    const port = 23000 + Math.floor(Math.random() * 20000);
    const res = await svc.create({
      name: "presence",
      port,
      password: "pw",
      autoApprove: true,
    });
    if (res.ok && res.room) return { roomId: res.room.roomId, port };
    last = res.error ?? "create failed";
  }
  throw new Error(last);
}

describe("room presence", () => {
  it("rejects the retired takeover action and keeps Agent seats autonomous", async () => {
    const host = makeService();
    const { roomId } = await createHost(host);
    const added = host.addSeat(roomId, "agent", "Agent");
    expect(added.ok).toBe(true);
    const seat = host.get(roomId)!.seats.find((item) => item.kind === "agent")!;

    expect(host.takeover(roomId, seat.id)).toEqual({
      ok: false,
      error: "接管功能已取消，请直接 @ 对应成员或 Agent",
    });
    expect(host.returnSeat(roomId, seat.id)).toEqual({
      ok: false,
      error: "接管功能已取消，请直接 @ 对应成员或 Agent",
    });
    expect(host.get(roomId)!.seats.find((item) => item.id === seat.id)?.takenOverBy).toBeNull();
  });

  it("counts only connected members as online", async () => {
    const host = makeService();
    const { roomId, port } = await createHost(host);
    expect(host.get(roomId)!.onlineCount ?? host.get(roomId)!.memberCount).toBe(1);

    const guest = makeService();
    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: host.get(roomId)!.hostFingerprint!,
    });
    expect(joined.ok).toBe(true);
    const guestId = joined.room!.localUserId!;

    await vi.waitFor(() => {
      const snap = host.get(roomId)!;
      expect(snap.members.some((m) => m.userId === guestId)).toBe(true);
      expect(snap.onlineCount).toBe(2);
      expect(snap.members.find((m) => m.userId === guestId)?.online).not.toBe(
        false,
      );
    });
  });

  it("marks a dropped guest offline without removing them, and does not auto-reconnect", async () => {
    const host = makeService();
    const { roomId, port } = await createHost(host);
    const guest = makeService();
    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: host.get(roomId)!.hostFingerprint!,
    });
    expect(joined.ok).toBe(true);
    const guestId = joined.room!.localUserId!;

    const grec = (
      guest as unknown as {
        rooms: Map<string, { client?: { terminate(): void } | null }>;
      }
    ).rooms.get(roomId);
    grec!.client!.terminate();

    await vi.waitFor(() => {
      const snap = host.get(roomId)!;
      expect(snap.members.some((m) => m.userId === guestId)).toBe(true);
      expect(snap.members.find((m) => m.userId === guestId)?.online).toBe(false);
      expect(snap.onlineCount).toBe(1);
    });
    await vi.waitFor(() => {
      expect(guest.list().find((l) => l.roomId === roomId)?.offline).toBe(true);
    });
    // 手动重连：不会自己连回去
    await new Promise((r) => setTimeout(r, 400));
    expect(host.get(roomId)!.onlineCount).toBe(1);
    expect(guest.get(roomId)?.status).toBe("open");
    expect(guest.list().find((l) => l.roomId === roomId)?.offline).toBe(true);
  });

  it("manual rejoin brings the guest back online without duplicating the member", async () => {
    const host = makeService();
    const { roomId, port } = await createHost(host);
    const guest = makeService();
    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: host.get(roomId)!.hostFingerprint!,
    });
    expect(joined.ok).toBe(true);
    const guestId = joined.room!.localUserId!;

    const grec = (
      guest as unknown as {
        rooms: Map<string, { client?: { terminate(): void } | null }>;
      }
    ).rooms.get(roomId);
    grec!.client!.terminate();
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.find((m) => m.userId === guestId)?.online,
      ).toBe(false);
    });
    await vi.waitFor(() => {
      expect(guest.list().find((l) => l.roomId === roomId)?.offline).toBe(true);
    });

    const again = await guest.rejoin(roomId);
    expect(again.ok).toBe(true);

    await vi.waitFor(() => {
      const snap = host.get(roomId)!;
      expect(snap.members.filter((m) => m.userId === guestId)).toHaveLength(1);
      expect(snap.members.find((m) => m.userId === guestId)?.online).not.toBe(
        false,
      );
      expect(snap.onlineCount).toBe(2);
      const joins = snap.items.filter((i) => i.text.includes("加入了群聊"));
      expect(joins).toHaveLength(1);
      expect(
        snap.items.some((i) => i.text.includes("重新连接") || i.text.includes("已重连")),
      ).toBe(true);
    });
  });

  it("guest leave removes them from the host roster", async () => {
    const host = makeService();
    const { roomId, port } = await createHost(host);
    const guest = makeService();
    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: host.get(roomId)!.hostFingerprint!,
    });
    expect(joined.ok).toBe(true);
    const guestId = joined.room!.localUserId!;
    await vi.waitFor(() => {
      expect(host.get(roomId)!.members.some((m) => m.userId === guestId)).toBe(
        true,
      );
    });

    expect(guest.leave(roomId).ok).toBe(true);

    await vi.waitFor(() => {
      const snap = host.get(roomId)!;
      expect(snap.members.some((m) => m.userId === guestId)).toBe(false);
      expect(snap.onlineCount).toBe(1);
      expect(snap.items.some((i) => i.text.includes("退出了群聊"))).toBe(true);
    });
    expect(guest.list().some((l) => l.roomId === roomId)).toBe(false);
  });

  it("guest can leave after the room is already ended locally", async () => {
    const host = makeService();
    const { roomId, port } = await createHost(host);
    const guest = makeService();
    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: host.get(roomId)!.hostFingerprint!,
    });
    expect(joined.ok).toBe(true);

    const grec = (
      guest as unknown as {
        rooms: Map<string, { client?: { terminate(): void } | null }>;
      }
    ).rooms.get(roomId);
    grec!.client!.terminate();
    await vi.waitFor(() => {
      expect(guest.list().find((l) => l.roomId === roomId)?.offline).toBe(true);
    });

    expect(guest.leave(roomId).ok).toBe(true);
    expect(guest.list().some((l) => l.roomId === roomId)).toBe(false);
    expect(guest.get(roomId)).toBeNull();
  });
});
