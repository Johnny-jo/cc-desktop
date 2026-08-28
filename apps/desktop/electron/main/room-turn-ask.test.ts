import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@claude-desktop/shared";
import { RoomService } from "./room-service";
import { RoomMetrics } from "./room-metrics";
import { pathJailViolation } from "./session-manager";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

/**
 * 文件策略 ask 的端到端：别人在你的本机项目上发起任务 → 本机弹审批
 * （roomPermAsk 事件），允许才执行、拒绝留审计；以及 pathJail 路径围栏
 * 的单元测试。
 */
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-ask-"));
  dirs.push(d);
  return d;
}

type Sent = Array<{ channel: string; payload: unknown }>;

function mockWindow(sent: Sent) {
  return () =>
    ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    }) as never;
}

function mockSessions() {
  return {
    start: vi.fn().mockResolvedValue("sess-agent"),
    continue: vi.fn().mockResolvedValue(undefined),
    getTranscript: vi.fn().mockReturnValue([]),
    getChangesForSelect: vi.fn().mockReturnValue([]),
    abort: vi.fn(),
    syncExtras: vi.fn(),
  } as unknown as SessionManager;
}

function makeService(opts?: {
  sessions?: SessionManager;
  projectPath?: string;
}): { svc: RoomService; sent: Sent; sessions: SessionManager; dir: string } {
  const dir = opts?.projectPath ?? tmp();
  const sent: Sent = [];
  const sessions = opts?.sessions ?? mockSessions();
  const svc = new RoomService({
    getWindow: mockWindow(sent),
    sessions,
    settings: {
      get: vi.fn().mockReturnValue({ lastProjectPath: dir }),
    } as unknown as SettingsStore,
    userDataDir: dir,
    archive: null,
    metrics: new RoomMetrics(() => {}),
  });
  services.push(svc);
  return { svc, sent, sessions, dir };
}

async function createHost(
  svc: RoomService,
): Promise<{ roomId: string; port: number; hostFingerprint: string }> {
  let last = "";
  for (let i = 0; i < 10; i++) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const res = await svc.create({
      name: "ask-test",
      port,
      password: "pw",
      autoApprove: true,
    });
    if (res.ok && res.room) {
      return {
        roomId: res.room.roomId,
        port,
        hostFingerprint: res.room.hostFingerprint!,
      };
    }
    last = res.error ?? "create failed";
  }
  throw new Error(last);
}

function lastAsk(sent: Sent): { requestId: string } | null {
  for (let i = sent.length - 1; i >= 0; i--) {
    const e = sent[i];
    if (e.channel === IPC.roomPermAsk) {
      const p = e.payload as { requestId: string; resolved?: boolean };
      if (!p.resolved) return { requestId: p.requestId };
    }
  }
  return null;
}

async function joinGuest(
  guest: RoomService,
  port: number,
  hostFingerprint: string,
): Promise<string> {
  const res = await guest.join({
    host: "127.0.0.1",
    port,
    password: "pw",
    hostFingerprint,
  });
  expect(res.ok).toBe(true);
  return res.room!.localUserId!;
}

describe("room turn ask (filePolicy = ask)", () => {
  it("客人对宿主工作区席位发言 → 宿主弹审批，允许后才执行", async () => {
    const host = makeService();
    const { roomId, port, hostFingerprint } = await createHost(host.svc);
    const guest = makeService();
    await joinGuest(guest.svc, port, hostFingerprint);

    const add = host.svc.addSeat(roomId, "agent", "bot");
    expect(add.ok).toBe(true);
    const seatId = host
      .svc.get(roomId)!
      .seats.find((s) => s.name === "bot")!.id;
    // 等客人的快照同步到新席位，否则 send 会在本地校验失败。
    await vi.waitFor(() =>
      expect(
        guest.svc.get(roomId)!.seats.some((s) => s.name === "bot"),
      ).toBe(true),
    );

    const sent = await guest.svc.send(roomId, seatId, "帮我改 a.ts");
    expect(sent.ok).toBe(true);

    // 宿主窗口收到审批弹窗事件，且任务尚未执行。
    await vi.waitFor(() => expect(lastAsk(host.sent)).toBeTruthy());
    expect(host.sessions.start).not.toHaveBeenCalled();

    const ask = lastAsk(host.sent)!;
    expect(host.svc.respondTurnAsk(ask.requestId, true).ok).toBe(true);

    await vi.waitFor(() =>
      expect(host.sessions.start).toHaveBeenCalledTimes(1),
    );
    const extras = (host.sessions.start as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as Record<string, unknown>;
    expect(extras.pathJail).toBe(host.dir);
    // 作答后广播 resolved，便于关掉其他窗口的弹窗。
    await vi.waitFor(() =>
      expect(
        host.sent.some(
          (e) =>
            e.channel === IPC.roomPermAsk &&
            (e.payload as { resolved?: boolean }).resolved === true,
        ),
      ).toBe(true),
    );
  });

  it("拒绝 → 任务不执行，时间线留审计记录", async () => {
    const host = makeService();
    const { roomId, port, hostFingerprint } = await createHost(host.svc);
    const guest = makeService();
    await joinGuest(guest.svc, port, hostFingerprint);

    expect(host.svc.addSeat(roomId, "agent", "bot").ok).toBe(true);
    const seatId = host
      .svc.get(roomId)!
      .seats.find((s) => s.name === "bot")!.id;
    await vi.waitFor(() =>
      expect(
        guest.svc.get(roomId)!.seats.some((s) => s.name === "bot"),
      ).toBe(true),
    );

    const sent = await guest.svc.send(roomId, seatId, "删库跑路");
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(lastAsk(host.sent)).toBeTruthy());

    const ask = lastAsk(host.sent)!;
    expect(host.svc.respondTurnAsk(ask.requestId, false).ok).toBe(true);

    await vi.waitFor(() => {
      const items = host.svc.get(roomId)!.items;
      expect(
        items.some(
          (i) => i.kind === "tool" && i.text.includes("被本机用户拒绝或超时"),
        ),
      ).toBe(true);
    });
    expect(host.sessions.start).not.toHaveBeenCalled();
  });

  it("filePolicy = allow → 不弹审批直接执行", async () => {
    const host = makeService();
    const { roomId, port, hostFingerprint } = await createHost(host.svc);
    const guest = makeService();
    await joinGuest(guest.svc, port, hostFingerprint);

    expect(host.svc.setFilePolicy(roomId, "allow").ok).toBe(true);
    expect(host.svc.addSeat(roomId, "agent", "bot").ok).toBe(true);
    const seatId = host
      .svc.get(roomId)!
      .seats.find((s) => s.name === "bot")!.id;
    await vi.waitFor(() =>
      expect(
        guest.svc.get(roomId)!.seats.some((s) => s.name === "bot"),
      ).toBe(true),
    );
    // 等客人的快照也带上宿主 filePolicy = allow（状态经 pushState 广播）。
    await vi.waitFor(() => {
      const snap = guest.svc.get(roomId)!;
      const hostMember = snap.members.find((m) => m.role === "host");
      expect(hostMember?.filePolicy).toBe("allow");
    });

    const sent = await guest.svc.send(roomId, seatId, "随便改");
    expect(sent.ok).toBe(true);

    await vi.waitFor(() =>
      expect(host.sessions.start).toHaveBeenCalledTimes(1),
    );
    expect(lastAsk(host.sent)).toBeNull();
  });

  it("席位绑在客人机器：宿主发言 → 客人本机弹审批，允许后才执行", async () => {
    const host = makeService();
    const { roomId, port, hostFingerprint } = await createHost(host.svc);
    const guest = makeService();
    const guestUserId = await joinGuest(guest.svc, port, hostFingerprint);

    // 客人加一个在本机执行的席位。
    await guest.svc.addSeat(roomId, "agent", "远端 bot", undefined, {
      executorUserId: guestUserId,
    });
    await vi.waitFor(() => {
      const seat = host.svc
        .get(roomId)!
        .seats.find((s) => s.name === "远端 bot");
      expect(seat?.executorUserId).toBe(guestUserId);
    });
    const seatId = host.svc
      .get(roomId)!
      .seats.find((s) => s.name === "远端 bot")!.id;

    // 宿主（≠ 工作区主人）发言 → 派发到客人机器，客人先审批。
    const sent = await host.svc.send(roomId, seatId, "读一下 b.ts");
    expect(sent.ok).toBe(true);

    await vi.waitFor(() => expect(lastAsk(guest.sent)).toBeTruthy());
    expect(guest.sessions.start).not.toHaveBeenCalled();
    expect(host.sessions.start).not.toHaveBeenCalled();

    const ask = lastAsk(guest.sent)!;
    expect(guest.svc.respondTurnAsk(ask.requestId, true).ok).toBe(true);
    await vi.waitFor(() =>
      expect(guest.sessions.start).toHaveBeenCalledTimes(1),
    );
    const extras = (guest.sessions.start as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as Record<string, unknown>;
    expect(extras.pathJail).toBe(guest.dir);
  });
});

describe("pathJailViolation", () => {
  const root = path.join(os.tmpdir(), "jail-root");

  it("工作区内的绝对路径放行", () => {
    expect(
      pathJailViolation(root, "Read", {
        file_path: path.join(root, "src", "a.ts"),
      }),
    ).toBeNull();
  });

  it("工作区内的相对路径放行", () => {
    expect(
      pathJailViolation(root, "Edit", { file_path: "src/a.ts" }),
    ).toBeNull();
  });

  it("相对路径 .. 逃出围栏被拒", () => {
    const v = pathJailViolation(root, "Write", { file_path: "../x.ts" });
    expect(v).toContain("已拒绝");
  });

  it("工作区外的绝对路径被拒", () => {
    const v = pathJailViolation(root, "Read", {
      file_path: path.join(os.tmpdir(), "jail-other", "x.ts"),
    });
    expect(v).toContain("已拒绝");
  });

  it("不带 path 的 Glob/Grep 放行（默认落在 cwd）", () => {
    expect(pathJailViolation(root, "Glob", { pattern: "**/*.ts" })).toBeNull();
    expect(pathJailViolation(root, "Grep", { pattern: "foo" })).toBeNull();
  });

  it("越界的 Grep path 被拒", () => {
    const v = pathJailViolation(root, "Grep", {
      pattern: "foo",
      path: "../../etc",
    });
    expect(v).toContain("已拒绝");
  });

  it("Bash 不做路径解析，交给权限弹窗", () => {
    expect(
      pathJailViolation(root, "Bash", { command: "rm -rf /" }),
    ).toBeNull();
  });

  it("未登记的工具放行", () => {
    expect(
      pathJailViolation(root, "WebFetch", { url: "https://x" }),
    ).toBeNull();
  });
});
