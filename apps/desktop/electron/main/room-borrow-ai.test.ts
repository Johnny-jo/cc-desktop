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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-borrow-"));
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

function mockSessions(overrides?: {
  start?: ReturnType<typeof vi.fn>;
  getTranscript?: ReturnType<typeof vi.fn>;
}) {
  return {
    start: overrides?.start ?? vi.fn().mockResolvedValue("sess-local"),
    continue: vi.fn().mockResolvedValue(undefined),
    getTranscript: overrides?.getTranscript ?? vi.fn().mockReturnValue([]),
    getChangesForSelect: vi.fn().mockReturnValue([]),
    abort: vi.fn(),
    syncExtras: vi.fn(),
  } as unknown as SessionManager;
}

function makeService(opts: {
  sessions: SessionManager;
  userDataDir?: string;
  settingsValue?: {
    lastProjectPath: string | null;
    models?: string[];
    defaultModel?: string;
  };
}): RoomService {
  const userDataDir = opts.userDataDir ?? tmp();
  const settingsValue = opts.settingsValue ?? {
    lastProjectPath: userDataDir,
    models: ["local-model"],
    defaultModel: "local-model",
  };
  const svc = new RoomService({
    getWindow: mockWindow(),
    sessions: opts.sessions,
    settings: {
      get: vi.fn(() => settingsValue),
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
    const port = 22000 + Math.floor(Math.random() * 20000);
    const res = await svc.create({
      name: "borrow-test",
      port,
      password: "pw",
      autoApprove: true,
    });
    if (res.ok && res.room) return { roomId: res.room.roomId, port };
    last = res.error ?? "create failed";
  }
  throw new Error(last);
}

async function joinGuest(
  host: RoomService,
  roomId: string,
  port: number,
  guest: RoomService,
) {
  const joined = await guest.join({
    host: "127.0.0.1",
    port,
    password: "pw",
    hostFingerprint: host.get(roomId)!.hostFingerprint!,
  });
  expect(joined.ok).toBe(true);
  return joined.room!.localUserId!;
}

describe("room borrow AI — admin + kick", () => {
  it("lets the host promote an admin who can kick members but not the host", async () => {
    const host = makeService({ sessions: mockSessions() });
    const { roomId, port } = await createHost(host);
    const admin = makeService({ sessions: mockSessions() });
    const member = makeService({ sessions: mockSessions() });
    const adminId = await joinGuest(host, roomId, port, admin);
    const memberId = await joinGuest(host, roomId, port, member);

    const promoted = host.setMemberRole(roomId, adminId, "admin");
    expect(promoted.ok).toBe(true);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.find((m) => m.userId === adminId)?.role,
      ).toBe("admin");
    });
    await vi.waitFor(() => {
      expect(
        admin.get(roomId)!.members.find((m) => m.userId === adminId)?.role,
      ).toBe("admin");
    });

    const asMember = member.kick(roomId, adminId);
    expect(asMember.ok).toBe(false);

    const kickHost = admin.kick(roomId, host.get(roomId)!.members.find((m) => m.role === "host")!.userId);
    expect(kickHost.ok).toBe(false);

    const kicked = admin.kick(roomId, memberId);
    expect(kicked.ok).toBe(true);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.some((m) => m.userId === memberId),
      ).toBe(false);
    });
  });
});

describe("room borrow AI — seat axes + file policy", () => {
  it("routes the loop to workspaceUserId and refuses when filePolicy is deny", async () => {
    const hostSessions = mockSessions();
    const host = makeService({ sessions: hostSessions });
    const { roomId, port } = await createHost(host);

    const guestStart = vi.fn().mockResolvedValue("sess-ws");
    const guest = makeService({
      sessions: mockSessions({ start: guestStart }),
    });
    const guestId = await joinGuest(host, roomId, port, guest);

    guest.setFilePolicy(roomId, "deny");
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.find((m) => m.userId === guestId)?.filePolicy,
      ).toBe("deny");
    });

    const added = host.addSeat(roomId, "agent", "借脑", undefined, {
      workspaceUserId: guestId,
      aiUserId: host.get(roomId)!.localUserId,
    });
    expect(added.ok).toBe(true);
    const seat = host.get(roomId)!.seats.find((s) => s.name === "借脑")!;
    expect(seat.workspaceUserId).toBe(guestId);
    expect(seat.executorUserId).toBe(guestId);

    const sent = await host.send(roomId, seat.id, "改一下");
    expect(sent.ok).toBe(true);

    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.items.some(
          (i) => i.kind === "tool" && /禁止|拒绝/.test(i.text),
        ),
      ).toBe(true);
    });
    expect(guestStart).not.toHaveBeenCalled();
    expect(hostSessions.start).not.toHaveBeenCalled();
  });

  it("runs on the file owner's machine with auto permissions when filePolicy is allow", async () => {
    const host = makeService({ sessions: mockSessions() });
    const { roomId, port } = await createHost(host);
    const guestStart = vi.fn().mockImplementation(
      (_p: unknown, _cwd: unknown, extras?: { permissionMode?: string }) => {
        expect(extras?.permissionMode).toBe("auto");
        return Promise.resolve("sess-allow");
      },
    );
    const guestTranscript = vi
      .fn()
      .mockReturnValue([{ kind: "text", role: "assistant", text: "好了" }]);
    const guest = makeService({
      sessions: mockSessions({
        start: guestStart,
        getTranscript: guestTranscript,
      }),
    });
    const guestId = await joinGuest(host, roomId, port, guest);
    guest.setFilePolicy(roomId, "allow");
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.find((m) => m.userId === guestId)?.filePolicy,
      ).toBe("allow");
    });

    host.addSeat(roomId, "agent", "允许改", undefined, {
      workspaceUserId: guestId,
      aiUserId: guestId,
    });
    await vi.waitFor(() => {
      expect(host.get(roomId)!.seats.some((s) => s.name === "允许改")).toBe(true);
    });
    const seatId = host.get(roomId)!.seats.find((s) => s.name === "允许改")!.id;
    await host.send(roomId, seatId, "动手");
    await vi.waitFor(() => expect(guestStart).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.items.some(
          (i) => i.kind === "assistant" && i.text.includes("好了"),
        ),
      ).toBe(true);
    });
  });
});

describe("room borrow AI — loop on files, env to borrowed AI", () => {
  it("starts the host-side session with a skipCpa proxy env when AI is another member", async () => {
    const hostStart = vi.fn().mockResolvedValue("sess-borrow");
    const host = makeService({
      sessions: mockSessions({
        start: hostStart,
        getTranscript: vi
          .fn()
          .mockReturnValue([{ kind: "text", role: "assistant", text: "借来的脑" }]),
      }),
    });
    const { roomId, port } = await createHost(host);
    const guest = makeService({
      sessions: mockSessions(),
      settingsValue: {
        lastProjectPath: tmp(),
        models: ["guest-sonnet"],
        defaultModel: "guest-sonnet",
      },
    });
    const guestId = await joinGuest(host, roomId, port, guest);
    guest.setAiShare(roomId, true);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.find((m) => m.userId === guestId)?.aiShare,
      ).toBe("on");
    });
    const hostId = host.get(roomId)!.localUserId;
    host.addSeat(roomId, "agent", "借脑改自己", undefined, {
      aiUserId: guestId,
      workspaceUserId: hostId,
      model: "guest-sonnet",
    });
    const seatId = host.get(roomId)!.seats.find((s) => s.name === "借脑改自己")!.id;
    await host.send(roomId, seatId, "帮我改本机");
    await vi.waitFor(() => expect(hostStart).toHaveBeenCalledTimes(1));
    const extras = hostStart.mock.calls[0][2] as {
      skipCpa?: boolean;
      extraEnv?: Record<string, string>;
      model?: string;
    };
    expect(extras.skipCpa).toBe(true);
    expect(extras.model).toBe("guest-sonnet");
    expect(extras.extraEnv?.ANTHROPIC_BASE_URL ?? "").toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(extras.extraEnv?.ANTHROPIC_AUTH_TOKEN).toMatch(/^room-borrow:/);
    expect(guest.get(roomId)!.seats.find((s) => s.id === seatId)?.running).toBeFalsy();
  });
});

describe("room borrow AI — share models", () => {
  it("asks, grants, lists models, and reverts seats on revoke", async () => {
    const host = makeService({
      sessions: mockSessions(),
      settingsValue: {
        lastProjectPath: tmp(),
        models: ["host-opus"],
        defaultModel: "host-opus",
      },
    });
    const { roomId, port } = await createHost(host);
    const guest = makeService({
      sessions: mockSessions(),
      settingsValue: {
        lastProjectPath: tmp(),
        models: ["guest-sonnet", "guest-haiku"],
        defaultModel: "guest-sonnet",
      },
    });
    const guestId = await joinGuest(host, roomId, port, guest);
    const hostId = host.get(roomId)!.localUserId;

    const asked = host.askAiShare(roomId, guestId);
    expect(asked.ok).toBe(true);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.find((m) => m.userId === guestId)?.aiShare,
      ).toBe("pending");
    });
    await vi.waitFor(() => {
      expect(
        guest.get(roomId)!.members.find((m) => m.userId === guestId)?.aiShare,
      ).toBe("pending");
    });

    const granted = guest.setAiShare(roomId, true);
    expect(granted.ok).toBe(true);
    await vi.waitFor(() => {
      const m = host.get(roomId)!.members.find((mm) => mm.userId === guestId);
      expect(m?.aiShare).toBe("on");
      expect(m?.aiModels).toEqual(["guest-sonnet", "guest-haiku"]);
    });

    host.addSeat(roomId, "agent", "用对方模型", undefined, {
      aiUserId: guestId,
      workspaceUserId: hostId,
      model: "guest-sonnet",
    });
    const seat = host.get(roomId)!.seats.find((s) => s.name === "用对方模型")!;
    expect(seat.aiUserId).toBe(guestId);
    expect(seat.workspaceUserId).toBe(hostId);

    guest.setAiShare(roomId, false);
    await vi.waitFor(() => {
      const s = host.get(roomId)!.seats.find((x) => x.name === "用对方模型")!;
      expect(s.aiUserId).toBe(hostId);
    });
  });
});
