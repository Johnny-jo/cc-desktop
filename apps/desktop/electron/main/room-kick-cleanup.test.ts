import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomService } from "./room-service";
import { RoomMetrics } from "./room-metrics";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";
import type { RoomSnapshot } from "@claude-desktop/shared";

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-kick-"));
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
    metrics: new RoomMetrics(() => {}),
  });
  services.push(rooms);
  return rooms;
}

async function createHost(
  rooms: RoomService,
  opts?: { name?: string; password?: string },
): Promise<{ room: RoomSnapshot; port: number }> {
  let last = "";
  for (let i = 0; i < 10; i++) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const res = await rooms.create({
      name: opts?.name ?? "t",
      port,
      password: opts?.password,
      autoApprove: true,
    });
    if (res.ok && res.room) return { room: res.room, port };
    last = res.error ?? "create failed";
  }
  throw new Error(last);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("kick cleanup", () => {
  it("host members/seats no longer contain the kicked user", async () => {
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
    await sleep(300);

    const after = host.get(room.roomId);
    expect(after?.members.some((m) => m.userId === member!.userId)).toBe(false);
    expect(
      after?.seats.some(
        (s) => s.kind === "human" && s.occupantUserId === member!.userId,
      ),
    ).toBe(false);
  });

  it("other guests see the kicked member removed", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });
    const guestA = makeRooms();
    const guestB = makeRooms();
    const joinA = await guestA.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(joinA.ok).toBe(true);
    const joinB = await guestB.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: room.hostFingerprint,
    });
    expect(joinB.ok).toBe(true);
    await sleep(200);

    const memberA = host
      .get(room.roomId)
      ?.members.find((m) => m.role === "member");
    expect(memberA).toBeTruthy();
    expect(host.kick(room.roomId, memberA!.userId).ok).toBe(true);
    await sleep(400);

    const bView = guestB.get(room.roomId);
    expect(bView?.members.some((m) => m.userId === memberA!.userId)).toBe(false);
    expect(
      bView?.seats.some(
        (s) => s.kind === "human" && s.occupantUserId === memberA!.userId,
      ),
    ).toBe(false);
  });

  it("agent seat bound to kicked user is unbound and falls back to host", async () => {
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

    // Host adds an agent seat borrowing the guest's workspace + AI.
    const add = host.addSeat(room.roomId, "agent", "bot", "claude", {
      workspaceUserId: member!.userId,
      aiUserId: member!.userId,
    });
    expect(add.ok).toBe(true);

    expect(host.kick(room.roomId, member!.userId).ok).toBe(true);
    await sleep(300);

    const after = host.get(room.roomId);
    const dangling = after?.seats.filter(
      (s) =>
        s.workspaceUserId === member!.userId ||
        s.aiUserId === member!.userId ||
        s.executorUserId === member!.userId ||
        s.takenOverBy === member!.userId,
    );
    expect(dangling ?? []).toHaveLength(0);
    // 席位保留，绑定回落到房主（缺省链）
    const seat = after?.seats.find((s) => s.kind === "agent");
    expect(seat).toBeTruthy();
    expect(seat?.workspaceUserId ?? null).toBeNull();
    expect(seat?.aiUserId ?? null).toBeNull();
  });
});
