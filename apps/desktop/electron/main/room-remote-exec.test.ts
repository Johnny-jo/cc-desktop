import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomService } from "./room-service";
import { RoomMetrics } from "./room-metrics";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

/**
 * 远程执行（docs/room-remote-exec-design.md）一期端到端：
 * 席位绑定执行节点 → 房主派发 exec.run → 节点本机执行 → exec.result 回传。
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-exec-"));
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

const dirByService = new Map<RoomService, string>();

function makeService(opts: {
  sessions: SessionManager;
  userDataDir?: string;
  /** 可变设置值：测试中途改 lastProjectPath 模拟用户切换项目。 */
  settingsValue?: { lastProjectPath: string | null };
}): RoomService {
  const userDataDir = opts.userDataDir ?? tmp();
  const settingsValue = opts.settingsValue ?? { lastProjectPath: userDataDir };
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
  dirByService.set(svc, userDataDir);
  services.push(svc);
  return svc;
}

async function createHost(svc: RoomService): Promise<{ roomId: string; port: number }> {
  let last = "";
  for (let i = 0; i < 10; i++) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const res = await svc.create({ name: "exec-test", port, password: "pw", autoApprove: true });
    if (res.ok && res.room) return { roomId: res.room.roomId, port };
    last = res.error ?? "create failed";
  }
  throw new Error(last);
}

describe("room remote exec", () => {
  it("routes a seat turn to the member's machine and posts the result back", async () => {
    // Host: local sessions must NEVER run for a remote-bound seat.
    const hostSessions = mockSessions();
    const host = makeService({ sessions: hostSessions, userDataDir: tmp() });
    const { roomId, port } = await createHost(host);
    const hostFp = host.get(roomId)!.hostFingerprint!;

    // Guest (execution node): deferred start so we can watch live progress
    // while the turn is still running.
    let resolveStart!: (id: string) => void;
    const guestStart = vi.fn().mockImplementation(
      (_p: unknown, _cwd: unknown, extras?: { onSessionId?: (id: string) => void }) => {
        extras?.onSessionId?.("sess-remote-1");
        return new Promise<string>((res) => {
          resolveStart = res;
        });
      },
    );
    const guestTranscript = vi
      .fn()
      .mockReturnValue([{ kind: "text", role: "assistant", text: "远端回复：已修好" }]);
    const guestSessions = mockSessions({
      start: guestStart,
      getTranscript: guestTranscript,
    });
    (guestSessions as unknown as { getChangesForSelect: ReturnType<typeof vi.fn> })
      .getChangesForSelect = vi.fn().mockImplementation(() => [
        {
          path: "src/a.ts",
          status: "M",
          hunks: "@@ -1 +1 @@\n-old\n+new",
          updatedAt: Date.now(),
          events: [
            { id: "e1", tool: "Edit", at: Date.now(), hunk: "-old\n+new", canRestore: true },
          ],
        },
      ]);
    const guestDir = tmp();
    const guest = makeService({ sessions: guestSessions, userDataDir: guestDir });

    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: hostFp,
    });
    expect(joined.ok).toBe(true);
    const guestUserId = joined.room!.localUserId!;

    // Guest adds an agent seat that runs on the guest's own machine.
    await guest.addSeat(roomId, "agent", "远端小助手", undefined, {
      executorUserId: guestUserId,
    });
    await vi.waitFor(() => {
      const snap = host.get(roomId)!;
      const seat = snap.seats.find((s) => s.name === "远端小助手");
      expect(seat).toBeTruthy();
      expect(seat!.executorUserId).toBe(guestUserId);
    });
    // Guest sees the seat in its own snapshot too.
    await vi.waitFor(() => {
      expect(
        guest.get(roomId)!.seats.some((s) => s.name === "远端小助手"),
      ).toBe(true);
    });
    const seatId = host.get(roomId)!.seats.find((s) => s.name === "远端小助手")!.id;

    // Guest messages the seat → host routes exec.run to the guest machine.
    const sent = await guest.send(roomId, seatId, "帮我修 a.ts");
    expect(sent.ok).toBe(true);

    // Node executed locally (hidden session, guest's project dir).
    await vi.waitFor(() => expect(guestStart).toHaveBeenCalledTimes(1));
    const extras = guestStart.mock.calls[0][2] as Record<string, unknown>;
    expect(extras.hiddenFromList).toBe(true);
    // Host never ran the turn locally.
    expect(hostSessions.start).not.toHaveBeenCalled();

    // 二期：执行中的流式进度经 exec.event 上快照，各端可见。
    guest.onSessionEvent({
      type: "text_delta",
      sessionId: "sess-remote-1",
      text: "正在改 a.ts…",
    });
    guest.onSessionEvent({
      type: "tool_start",
      sessionId: "sess-remote-1",
      tool: { id: "t1", name: "Edit", summary: "src/a.ts", status: "running" },
    });
    await vi.waitFor(() => {
      const live = host.get(roomId)!.liveExec ?? [];
      expect(live.some((e) => e.text.includes("正在改 a.ts"))).toBe(true);
    });
    await vi.waitFor(() => {
      const live = guest.get(roomId)!.liveExec ?? [];
      expect(live.some((e) => e.tool?.includes("Edit"))).toBe(true);
    });

    // Turn finishes.
    resolveStart("sess-remote-1");

    // Result lands on the host timeline: assistant text + tool audit entry.
    await vi.waitFor(() => {
      const items = host.get(roomId)!.items;
      expect(
        items.some((i) => i.kind === "assistant" && i.text === "远端回复：已修好"),
      ).toBe(true);
      expect(
        items.some(
          (i) => i.kind === "tool" && i.text.includes("执行完成") && i.text.includes("src/a.ts"),
        ),
      ).toBe(true);
      // Dispatch audit entry exists too.
      expect(
        items.some((i) => i.kind === "tool" && i.text.includes("已派发给")),
      ).toBe(true);
    });

    // 二期：终态后 live 进度撤掉，结构化改动进快照（只读、canRestore 抹掉）。
    await vi.waitFor(() => {
      expect((host.get(roomId)!.liveExec ?? []).length).toBe(0);
    });
    await vi.waitFor(() => {
      const snap = host.get(roomId)!;
      const changes = snap.remoteChanges?.[seatId] ?? [];
      expect(changes.some((c) => c.path === "src/a.ts")).toBe(true);
      expect(changes[0]?.events.every((e) => !e.canRestore)).toBe(true);
    });
    await vi.waitFor(() => {
      const changes = guest.get(roomId)!.remoteChanges?.[seatId] ?? [];
      expect(changes.some((c) => c.path === "src/a.ts")).toBe(true);
    });

    // Guest timeline also converges (via snapshot broadcast).
    await vi.waitFor(() => {
      expect(
        guest.get(roomId)!.items.some(
          (i) => i.kind === "assistant" && i.text === "远端回复：已修好",
        ),
      ).toBe(true);
    });

    // 证据链：两端各有一份 exec-log.jsonl，turnId 对得上。
    const hostLog = path.join(hostDirOf(host), "rooms", `${roomId}.exec-log.jsonl`);
    const guestLog = path.join(guestDir, "rooms", `${roomId}.exec-log.jsonl`);
    await vi.waitFor(() => expect(fs.existsSync(hostLog)).toBe(true));
    await vi.waitFor(() => expect(fs.existsSync(guestLog)).toBe(true));
    const hostLines = fs.readFileSync(hostLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const guestLines = fs.readFileSync(guestLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const turnId = hostLines.find((l) => l.type === "exec.run")?.turnId;
    expect(turnId).toBeTruthy();
    expect(hostLines.some((l) => l.turnId === turnId && l.state === "done")).toBe(true);
    expect(guestLines.some((l) => l.turnId === turnId && l.state === "accepted")).toBe(true);
    expect(guestLines.some((l) => l.turnId === turnId && l.state === "done")).toBe(true);

    // Seat is no longer running on the host snapshot.
    const seat = host.get(roomId)!.seats.find((s) => s.id === seatId)!;
    expect(seat.running).toBe(false);
  });

  it("advertises each member's current project and tracks changes", async () => {
    const hostDir = tmp();
    const hostSettingsValue = { lastProjectPath: hostDir as string | null };
    const host = makeService({
      sessions: mockSessions(),
      userDataDir: hostDir,
      settingsValue: hostSettingsValue,
    });
    const { roomId, port } = await createHost(host);

    // 建房时房主自己的成员记录就带上当前项目。
    expect(host.get(roomId)!.members[0]?.projectPath).toBe(hostDir);

    const guestDir = tmp();
    const guestSettingsValue = { lastProjectPath: guestDir as string | null };
    const guest = makeService({
      sessions: mockSessions(),
      userDataDir: guestDir,
      settingsValue: guestSettingsValue,
    });
    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: host.get(roomId)!.hostFingerprint!,
    });
    expect(joined.ok).toBe(true);
    const guestUserId = joined.room!.localUserId!;

    // join 帧携带 projectPath → 房主端成员列表可见客人的项目。
    await vi.waitFor(() => {
      const m = host
        .get(roomId)!
        .members.find((mm) => mm.userId === guestUserId);
      expect(m?.projectPath).toBe(guestDir);
    });
    // 快照流回客人端：房主与客人的项目都可见。
    await vi.waitFor(() => {
      const snap = guest.get(roomId)!;
      expect(snap.members.find((m) => m.role === "host")?.projectPath).toBe(
        hostDir,
      );
      expect(
        snap.members.find((m) => m.userId === guestUserId)?.projectPath,
      ).toBe(guestDir);
    });

    // 客人切换项目 → node.info 上报 → 各端成员列表更新。
    const newGuestDir = tmp();
    guestSettingsValue.lastProjectPath = newGuestDir;
    guest.reportLocalProject(newGuestDir);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.find((m) => m.userId === guestUserId)
          ?.projectPath,
      ).toBe(newGuestDir);
    });
    await vi.waitFor(() => {
      expect(
        guest.get(roomId)!.members.find((m) => m.userId === guestUserId)
          ?.projectPath,
      ).toBe(newGuestDir);
    });

    // 房主自己切项目 → 改本地成员记录 + 快照广播。
    const newHostDir = tmp();
    hostSettingsValue.lastProjectPath = newHostDir;
    host.reportLocalProject(newHostDir);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.find((m) => m.role === "host")?.projectPath,
      ).toBe(newHostDir);
    });
    await vi.waitFor(() => {
      expect(
        guest.get(roomId)!.members.find((m) => m.role === "host")?.projectPath,
      ).toBe(newHostDir);
    });

    // 清空项目（关掉项目目录）也会传播出去。
    guestSettingsValue.lastProjectPath = null;
    guest.reportLocalProject(null);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.members.find((m) => m.userId === guestUserId)
          ?.projectPath ?? null,
      ).toBe(null);
    });
  });

  it("host renames the room and the new name reaches guests via snapshot", async () => {
    const host = makeService({ sessions: mockSessions(), userDataDir: tmp() });
    const { roomId, port } = await createHost(host);
    const hostFp = host.get(roomId)!.hostFingerprint!;

    const guest = makeService({ sessions: mockSessions(), userDataDir: tmp() });
    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: hostFp,
    });
    expect(joined.ok).toBe(true);

    // 客人不能改名
    const denied = guest.rename(roomId, "客人改名");
    expect(denied.ok).toBe(false);

    const res = host.rename(roomId, "新群名");
    expect(res.ok).toBe(true);
    expect(host.get(roomId)!.name).toBe("新群名");
    // 时间线留痕
    expect(
      host.get(roomId)!.items.some((i) => i.text.includes("新群名")),
    ).toBe(true);
    // 快照广播到客人端
    await vi.waitFor(() => {
      expect(guest.get(roomId)!.name).toBe("新群名");
    });
    // 空名拒绝
    expect(host.rename(roomId, "   ").ok).toBe(false);
  });

  it("recalls messages: guests recall their own, host can recall any", async () => {
    const host = makeService({ sessions: mockSessions(), userDataDir: tmp() });
    const { roomId, port } = await createHost(host);
    const hostFp = host.get(roomId)!.hostFingerprint!;

    const guest = makeService({ sessions: mockSessions(), userDataDir: tmp() });
    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: hostFp,
    });
    expect(joined.ok).toBe(true);
    const guestUserId = joined.room!.localUserId!;

    // 客人用自己的人席发言
    await vi.waitFor(() => {
      expect(
        host
          .get(roomId)!
          .seats.some(
            (s) => s.kind === "human" && s.occupantUserId === guestUserId,
          ),
      ).toBe(true);
    });
    const guestSeat = host
      .get(roomId)!
      .seats.find(
        (s) => s.kind === "human" && s.occupantUserId === guestUserId,
      )!;
    const sent = await guest.send(roomId, guestSeat.id, "这条要撤回");
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.items.some((i) => i.text === "这条要撤回"),
      ).toBe(true);
    });
    const itemId = host
      .get(roomId)!
      .items.find((i) => i.text === "这条要撤回")!.id;

    // 客人撤回自己的消息 → chat.recall 帧 → 房主标记 → 快照回流
    expect(guest.recall(roomId, itemId).ok).toBe(true);
    await vi.waitFor(() => {
      const it = host.get(roomId)!.items.find((i) => i.id === itemId)!;
      expect(it.recalled).toBe(true);
      expect(it.text).toBe("");
    });
    await vi.waitFor(() => {
      expect(
        guest.get(roomId)!.items.find((i) => i.id === itemId)?.recalled,
      ).toBe(true);
    });

    // 客人不能撤别人的消息（本地校验即拒）
    const hostSeat = host
      .get(roomId)!
      .seats.find((s) => s.kind === "human" && s.occupantUserId !== guestUserId)!;
    const sentByHost = await host.send(roomId, hostSeat.id, "房主的话");
    expect(sentByHost.ok).toBe(true);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.items.some((i) => i.text === "房主的话"),
      ).toBe(true);
    });
    const hostItemId = host
      .get(roomId)!
      .items.find((i) => i.text === "房主的话")!.id;
    expect(guest.recall(roomId, hostItemId).ok).toBe(false);

    // 房主可以撤客人的消息
    await guest.send(roomId, guestSeat.id, "再发一条");
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.items.some((i) => i.text === "再发一条"),
      ).toBe(true);
    });
    const secondId = host
      .get(roomId)!
      .items.find((i) => i.text === "再发一条")!.id;
    expect(host.recall(roomId, secondId).ok).toBe(true);
    await vi.waitFor(() => {
      expect(
        guest.get(roomId)!.items.find((i) => i.id === secondId)?.recalled,
      ).toBe(true);
    });
  });

  it("posts a system message when the executor node is offline", async () => {
    const host = makeService({ sessions: mockSessions(), userDataDir: tmp() });
    const { roomId, port } = await createHost(host);
    const hostFp = host.get(roomId)!.hostFingerprint!;

    const guest = makeService({ sessions: mockSessions(), userDataDir: tmp() });
    const joined = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: hostFp,
    });
    const guestUserId = joined.room!.localUserId!;
    await guest.addSeat(roomId, "agent", "远端小助手", undefined, {
      executorUserId: guestUserId,
    });
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.seats.some((s) => s.name === "远端小助手"),
      ).toBe(true);
    });
    const seatId = host.get(roomId)!.seats.find((s) => s.name === "远端小助手")!.id;

    // Node goes away entirely; give the host a beat to notice the close.
    guest.disposeAll();
    await new Promise((r) => setTimeout(r, 300));

    const sent = await host.send(roomId, seatId, "在吗");
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => {
      expect(
        host.get(roomId)!.items.some(
          (i) => i.kind === "system" && i.text.includes("不在线"),
        ),
      ).toBe(true);
    });
  });
});

/** RoomService 不暴露 userDataDir，用 makeService 里登记的目录。 */
function hostDirOf(svc: RoomService): string {
  return dirByService.get(svc) ?? "";
}
