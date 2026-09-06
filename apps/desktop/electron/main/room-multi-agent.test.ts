import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { generateDeviceKeys } from "@claude-desktop/shared/room-crypto";
import { makeHandshake } from "@claude-desktop/shared/room-handshake";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC, makeRoomFrame, ROOM_PROTOCOL_VERSION, type Attachment, type RoomMention, type RoomSeat } from "@claude-desktop/shared";
import { RoomService } from "./room-service";
import { RoomMetrics } from "./room-metrics";
import type { SessionManager, SessionRunOpts } from "./session-manager";
import type { SettingsStore } from "./settings-store";

const services: RoomService[] = [];
const dirs: string[] = [];
const pending: Array<() => void> = [];
const mcpCleanups: Array<() => Promise<void>> = [];
const rawSockets: WebSocket[] = [];
const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
type ToolResult = { content: Array<{ text?: string }>; isError?: boolean };
type TestMcpClient = { connect(t: unknown): Promise<void>; close(): Promise<void>; callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<ToolResult> };

async function agentClient(extras: SessionRunOpts) {
  const server = extras.extraMcpServers!["room-chat"] as { instance: { connect(t: unknown): Promise<void>; close(): Promise<void> } };
  const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js") as { Client: new (info: { name: string; version: string }) => TestMcpClient };
  const { InMemoryTransport } = sdkRequire("@modelcontextprotocol/sdk/inMemory.js") as { InMemoryTransport: { createLinkedPair(): [unknown, unknown] } };
  const client = new Client({ name: "room-integration", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(b);
  await client.connect(a);
  mcpCleanups.push(async () => { await client.close(); await server.instance.close(); });
  return {
    call: async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "room_message", arguments: args });
      return JSON.parse(result.content[0].text!) as { ok: boolean; error?: string; value?: { taskId?: string } };
    },
  };
}

function wireClient(rooms: RoomService, roomId: string): WebSocket {
  return (rooms as unknown as { rooms: Map<string, { client: WebSocket }> }).rooms.get(roomId)!.client;
}

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-multi-agent-"));
  dirs.push(dir);
  let counter = 0;
  const start = vi.fn((_prompt: unknown, _cwd: string, extras?: SessionRunOpts) => {
    const id = `session-${++counter}`;
    extras?.onSessionId?.(id);
    return new Promise<string>((resolve) => pending.push(() => resolve(id)));
  });
  const sessions = {
    start, continue: vi.fn().mockResolvedValue(undefined),
    getTranscript: vi.fn().mockReturnValue([]),
    getChangesForSelect: vi.fn().mockReturnValue([]),
    abort: vi.fn(), syncExtras: vi.fn(),
  };
  const events: Array<{ channel: string; payload: unknown }> = [];
  const rooms = new RoomService({
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => events.push({ channel, payload }),
      },
    }) as never,
    sessions: sessions as unknown as SessionManager,
    settings: { get: () => ({ lastProjectPath: dir }) } as unknown as SettingsStore,
    userDataDir: dir, archive: null, metrics: new RoomMetrics(() => {}),
  });
  services.push(rooms);
  return { rooms, sessions, events };
}

async function host() {
  const result = service();
  for (let n = 0; n < 10; n++) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const created = await result.rooms.create({ name: "Parallel", port, autoApprove: true, encrypt: false });
    if (!created.ok || !created.room) continue;
    const roomId = created.room.roomId;
    result.rooms.addSeat(roomId, "agent", "开发助手");
    result.rooms.addSeat(roomId, "agent", "审查助手");
    const room = result.rooms.get(roomId)!;
    const human = room.seats.find(s => s.kind === "human")!;
    const agents = room.seats.filter(s => s.kind === "agent");
    return { ...result, roomId, port, human, agents };
  }
  throw new Error("failed to create test room");
}

function attachmentFixture(name: string): Attachment {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-multi-file-"));
  dirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "x");
  return { name, path: filePath, size: 1, kind: "text", mimeType: "text/plain" };
}

// A test-side equivalent of selecting each candidate; production never scans text.
function selectedSend(rooms: RoomService, roomId: string, seatId: string, text: string) {
  const mentions: RoomMention[] = [];
  for (const seat of rooms.get(roomId)!.seats) {
    const start = text.indexOf(`@${seat.name} `);
    if (start >= 0) mentions.push({ seatId: seat.id, start, end: start + seat.name.length + 1 });
  }
  return rooms.send(roomId, seatId, text, undefined, undefined, mentions);
}

afterEach(async () => {
  for (const ws of rawSockets.splice(0)) ws.close();
  for (const close of mcpCleanups.splice(0)) await close();
  pending.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  for (const rooms of services.splice(0).reverse()) rooms.disposeAll();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("one group message, parallel Agent tasks", () => {
  it("starts both mentioned Agents concurrently but records the user's message once", async () => {
    const { rooms, roomId, human, sessions } = await host();
    const text = `@${human.name} @开发助手 写实现 @审查助手 检查实现 @开发助手`;
    expect((await selectedSend(rooms, roomId, human.id, text)).ok).toBe(true);
    await vi.waitFor(() => expect(sessions.start).toHaveBeenCalledTimes(2));
    expect(rooms.get(roomId)!.seats.filter(s => s.running)).toHaveLength(2);
    expect(rooms.get(roomId)!.items.filter(i => i.kind === "user" && i.text === text)).toHaveLength(1);
  });

  it("also fans out a guest message using the host's existing permissions", async () => {
    const { rooms, roomId, port, sessions } = await host();
    rooms.setFilePolicy(roomId, "allow");
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    expect(joined.ok).toBe(true);
    const own = joined.room!.seats.find(s => s.occupantUserId === joined.room!.localUserId)!;
    const text = "@开发助手 @审查助手 并行工作";
    expect((await selectedSend(guest.rooms, roomId, own.id, text)).ok).toBe(true);
    await vi.waitFor(() => expect(sessions.start).toHaveBeenCalledTimes(2));
    expect(guest.sessions.start).not.toHaveBeenCalled();
    expect(rooms.get(roomId)!.items.filter(i => i.kind === "user" && i.text === text)).toHaveLength(1);
  });

  it("queues a busy Agent and still starts the other target", async () => {
    const { rooms, roomId, agents, human, sessions } = await host();
    await selectedSend(rooms, roomId, human.id, "@开发助手 first task");
    await vi.waitFor(() => expect(sessions.start).toHaveBeenCalledTimes(1));
    await selectedSend(rooms, roomId, human.id, "@开发助手 @审查助手 second task");
    await vi.waitFor(() => expect(rooms.get(roomId)!.tasks?.filter(t => t.seatId === agents[0].id && t.status === "queued")).toHaveLength(1));
    await vi.waitFor(() => expect(sessions.start).toHaveBeenCalledTimes(2));
    expect(sessions.continue).not.toHaveBeenCalled();
    expect(sessions.abort).not.toHaveBeenCalled();
    pending.shift()!();
    await vi.waitFor(() => expect(sessions.continue).toHaveBeenCalledTimes(1));
  });

  it("keeps a failed target independent from the other Agent", async () => {
    const { rooms, roomId, human, agents, sessions } = await host();
    sessions.start.mockRejectedValueOnce(new Error("model unavailable"));
    await selectedSend(rooms, roomId, human.id, "@开发助手 @审查助手 work");
    await vi.waitFor(() => expect(sessions.start).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(rooms.get(roomId)!.seats.find(s => s.id === agents[0].id)?.running).toBe(false));
    expect(rooms.get(roomId)!.seats.find(s => s.id === agents[1].id)?.running).toBe(true);
  });

  it("never routes an attachment filename as an Agent mention", async () => {
    const { rooms, roomId, human, sessions } = await host();
    await rooms.send(roomId, human.id, "附件", undefined, [
      attachmentFixture("@开发助手.txt"),
    ]);
    await vi.waitFor(() => expect(rooms.get(roomId)!.items.some(i => i.kind === "user")).toBe(true));
    expect(sessions.start).not.toHaveBeenCalled();
  });

  it("reserves a seat while waiting for approval without replacing the approval request", async () => {
    const { rooms, roomId, port, sessions, events } = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    const own = joined.room!.seats.find(s => s.occupantUserId === joined.room!.localUserId)!;
    const asks = () => events.filter(e => e.channel === IPC.roomPermAsk && !(e.payload as { resolved?: boolean }).resolved);
    await selectedSend(guest.rooms, roomId, own.id, "@开发助手 first task");
    await vi.waitFor(() => expect(asks()).toHaveLength(1));
    await selectedSend(guest.rooms, roomId, own.id, "@开发助手 @审查助手 second task");
    await vi.waitFor(() => expect(asks()).toHaveLength(2));
    expect(rooms.get(roomId)!.tasks?.filter(t => t.status === "queued")).toHaveLength(1);
    expect(sessions.start).not.toHaveBeenCalled();
    for (const ask of asks()) rooms.respondTurnAsk((ask.payload as { requestId: string }).requestId, true);
    await vi.waitFor(() => expect(sessions.start).toHaveBeenCalledTimes(2));
  });

  it("starts independent tasks on a remote member node", async () => {
    const { rooms, roomId, port, human, sessions } = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    const guestId = joined.room!.localUserId!;
    guest.rooms.setFilePolicy(roomId, "allow");
    await guest.rooms.addSeat(roomId, "agent", "远端开发", undefined, { executorUserId: guestId });
    await guest.rooms.addSeat(roomId, "agent", "远端检查", undefined, { executorUserId: guestId });
    await vi.waitFor(() => expect(rooms.get(roomId)!.seats.filter(s => s.name.startsWith("远端"))).toHaveLength(2));
    await selectedSend(rooms, roomId, human.id, "@远端开发 @远端检查 work");
    await vi.waitFor(() => expect(guest.sessions.start).toHaveBeenCalledTimes(2));
    expect(sessions.start).not.toHaveBeenCalled();
    expect(rooms.get(roomId)!.seats.filter(s => s.running)).toHaveLength(2);
  });

  it("can stop one pending approval without cancelling the other Agent", async () => {
    const { rooms, roomId, port, agents, sessions, events } = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    const own = joined.room!.seats.find(s => s.occupantUserId === joined.room!.localUserId)!;
    await selectedSend(guest.rooms, roomId, own.id, "@开发助手 @审查助手 work");
    const asks = () => events.filter(e => e.channel === IPC.roomPermAsk && !(e.payload as { resolved?: boolean }).resolved);
    await vi.waitFor(() => expect(asks()).toHaveLength(2));
    expect(rooms.stopSeat(roomId, agents[0].id).ok).toBe(true);
    const [first, second] = asks().map(e => e.payload as { requestId: string });
    expect(rooms.respondTurnAsk(first.requestId, true).ok).toBe(false);
    expect(rooms.respondTurnAsk(second.requestId, true).ok).toBe(true);
    await vi.waitFor(() => expect(sessions.start).toHaveBeenCalledTimes(1));
    expect(rooms.get(roomId)!.seats.find(s => s.id === agents[1].id)?.running).toBe(true);
  });

  it("does not duplicate guest message bytes or interpret guest attachment names", async () => {
    const { rooms, roomId, port, sessions } = await host();
    rooms.setFilePolicy(roomId, "allow");
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    const own = joined.room!.seats.find(s => s.occupantUserId === joined.room!.localUserId)!;
    // 36 KB of UTF-8 text fits a chat frame once, but not twice.
    const text = "内容".repeat(6000);
    await guest.rooms.send(roomId, own.id, text, undefined, [attachmentFixture("@开发助手.txt")]);
    await vi.waitFor(() => expect(rooms.get(roomId)!.items.some(i => i.kind === "user" && i.text.startsWith(text))).toBe(true));
    expect(sessions.start).not.toHaveBeenCalled();
    expect(guest.rooms.get(roomId)?.status).toBe("open");
  });

  it("cancels remote workspace approval and rejects a delayed allow without starting the model", async () => {
    const { rooms, roomId, port, human } = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    expect(joined.ok).toBe(true);
    await guest.rooms.addSeat(roomId, "agent", "远端开发", undefined, { executorUserId: joined.room!.localUserId! });
    await vi.waitFor(() => expect(rooms.get(roomId)!.seats.some(s => s.name === "远端开发")).toBe(true));
    await selectedSend(rooms, roomId, human.id, "@远端开发 work");
    const asks = () => guest.events.filter(e => e.channel === IPC.roomPermAsk && !(e.payload as { resolved?: boolean }).resolved);
    await vi.waitFor(() => expect(asks()).toHaveLength(1));
    const task = rooms.get(roomId)!.tasks![0];
    expect((await rooms.controlTask({ roomId, action: "stop", taskId: task.id })).ok).toBe(true);
    await vi.waitFor(() => expect(guest.events.some(e => e.channel === IPC.roomPermAsk && (e.payload as { resolved?: boolean }).resolved)).toBe(true));
    expect(guest.rooms.respondTurnAsk((asks()[0].payload as { requestId: string }).requestId, true).ok).toBe(false);
    await vi.waitFor(() => expect(rooms.get(roomId)!.tasks!.find(t => t.id === task.id)?.status).toBe("cancelled"));
    expect(guest.sessions.start).not.toHaveBeenCalled();
  });

  it("keeps remote stopping until the execution promise settles", async () => {
    const { rooms, roomId, port, human } = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    guest.rooms.setFilePolicy(roomId, "allow");
    await guest.rooms.addSeat(roomId, "agent", "远端开发", undefined, { executorUserId: joined.room!.localUserId! });
    await vi.waitFor(() => expect(rooms.get(roomId)!.seats.some(s => s.name === "远端开发")).toBe(true));
    await selectedSend(rooms, roomId, human.id, "@远端开发 work");
    await vi.waitFor(() => expect(guest.sessions.start).toHaveBeenCalledTimes(1));
    const task = rooms.get(roomId)!.tasks![0];
    await rooms.controlTask({ roomId, action: "stop", taskId: task.id });
    await vi.waitFor(() => expect(guest.sessions.abort).toHaveBeenCalledTimes(1));
    expect(rooms.get(roomId)!.tasks![0].status).toBe("stopping");
    expect(rooms.get(roomId)!.seats.find(s => s.id === task.seatId)?.running).toBe(true);
    pending.shift()!();
    await vi.waitFor(() => expect(rooms.get(roomId)!.tasks![0].status).toBe("cancelled"));
  });

  it("never executes plain or malformed mentions through an Agent seat fallback", async () => {
    const { rooms, roomId, human, agents, sessions } = await host();
    await rooms.send(roomId, human.id, "@开发助手 pasted");
    await rooms.send(roomId, agents[0].id, "@开发助手 pasted");
    await rooms.send(roomId, human.id, "@开发助手no-space", undefined, undefined, [{ seatId: agents[0].id, start: 0, end: 5 }]);
    await new Promise(resolve => setImmediate(resolve));
    expect(sessions.start).not.toHaveBeenCalled();
    expect(rooms.get(roomId)!.tasks ?? []).toHaveLength(0);
  });

  it("enforces initiator ownership and current administrator role over the real socket", async () => {
    const h = await host();
    h.rooms.setFilePolicy(h.roomId, "allow");
    const a = service(); const b = service();
    const joinedA = await a.rooms.join({ host: "127.0.0.1", port: h.port });
    const joinedB = await b.rooms.join({ host: "127.0.0.1", port: h.port });
    const ownB = joinedB.room!.seats.find(s => s.occupantUserId === joinedB.room!.localUserId)!;
    await selectedSend(b.rooms, h.roomId, ownB.id, "@开发助手 work");
    await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(1));
    const task = h.rooms.get(h.roomId)!.tasks![0];
    expect(task.initiatorUserId).toBe(joinedB.room!.localUserId);
    const stop = { roomId: h.roomId, action: "stop" as const, taskId: task.id };
    expect((await a.rooms.controlTask(stop)).ok).toBe(false);
    expect(h.sessions.abort).not.toHaveBeenCalled();
    h.rooms.setMemberRole(h.roomId, joinedA.room!.localUserId!, "admin");
    expect((await a.rooms.controlTask(stop)).ok).toBe(true);
    expect(h.sessions.abort).toHaveBeenCalledTimes(1);
    expect(h.rooms.get(h.roomId)!.tasks![0].status).toBe("stopping");
    h.rooms.setMemberRole(h.roomId, joinedA.room!.localUserId!, "member");
    expect((await a.rooms.controlTask(stop)).ok).toBe(false);
    expect((await b.rooms.controlTask(stop)).ok).toBe(true);
  });

  it("separates Agent notices from delegated tasks and binds approval to the original human", async () => {
    const h = await host();
    h.rooms.setFilePolicy(h.roomId, "allow");
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port: h.port });
    const own = joined.room!.seats.find(s => s.occupantUserId === joined.room!.localUserId)!;
    await selectedSend(guest.rooms, h.roomId, own.id, "@开发助手 work");
    await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(1));
    const agent = await agentClient(h.sessions.start.mock.calls[0][2]!);
    const notice = { requestId: "notice", mode: "notify", targetSeatId: h.agents[1].id, text: "背景资料" };
    expect((await agent.call(notice)).ok).toBe(true);
    expect((await agent.call(notice)).ok).toBe(true);
    expect(h.rooms.get(h.roomId)!.items.filter(i => i.text.includes("背景资料"))).toHaveLength(1);
    expect(h.sessions.start).toHaveBeenCalledTimes(1);
    expect((await agent.call({ ...notice, requestId: "human", targetSeatId: own.id })).ok).toBe(true);
    expect(h.rooms.get(h.roomId)!.items.at(-1)?.mentions?.[0].seatId).toBe(own.id);
    const delegated = await agent.call({ ...notice, requestId: "delegate", mode: "delegate", text: "检查实现", readOnly: true });
    expect(delegated.ok).toBe(true);
    const child = h.rooms.get(h.roomId)!.tasks!.find(t => t.id === delegated.value!.taskId)!;
    expect(child.initiatorUserId).toBe(joined.room!.localUserId);
    expect(child.status).toBe("awaiting-approval");
    const approve = { roomId: h.roomId, action: "approve" as const, taskId: child.id, requestId: child.approvalRequestId, allow: true };
    expect((await h.rooms.controlTask(approve)).ok).toBe(false);
    expect((await guest.rooms.controlTask(approve)).ok).toBe(true);
    await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(2));
    expect(h.sessions.start.mock.calls[1][2]?.roomReadOnly).toBe(true);
    expect((h.sessions.start.mock.calls[1][0] as { text: string }).text).toContain("背景资料");
    const parent = h.rooms.get(h.roomId)!.tasks!.find(t => !t.parentTaskId)!;
    expect((await guest.rooms.controlTask({ roomId: h.roomId, action: "stop", taskId: parent.id })).ok).toBe(true);
    expect((await agent.call({ ...notice, requestId: "late" })).ok).toBe(false);
    expect(h.rooms.get(h.roomId)!.tasks!.every(t => t.status === "stopping")).toBe(true);
  });

  it("cannot become the host by sending another join on an already bound connection", async () => {
    const h = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port: h.port });
    const hostId = h.rooms.get(h.roomId)!.localUserId;
    wireClient(guest.rooms, h.roomId).send(JSON.stringify(makeRoomFrame(h.roomId, 100_000, "join", {
      userId: hostId, name: "forged host", protocol: ROOM_PROTOCOL_VERSION,
    })));
    await vi.waitFor(() => expect(guest.events.some(e => e.channel === IPC.roomEvent && (e.payload as { error?: boolean }).error)).toBe(true));
    expect(h.rooms.get(h.roomId)!.members.find(m => m.userId === hostId)?.name).not.toBe("forged host");
    expect(h.rooms.get(h.roomId)!.members.find(m => m.userId === joined.room!.localUserId)?.role).toBe("member");
  });

  it("requires fresh approval if an already known device claims another member's identity", async () => {
    const h = await host();
    const a = service(); const b = service();
    await a.rooms.join({ host: "127.0.0.1", port: h.port });
    const joinedB = await b.rooms.join({ host: "127.0.0.1", port: h.port });
    const attempt = a.rooms.join({ host: "127.0.0.1", port: h.port, userId: joinedB.room!.localUserId! });
    await vi.waitFor(() => expect(h.rooms.pendingDevices(h.roomId).pending).toHaveLength(1));
    const fp = h.rooms.pendingDevices(h.roomId).pending[0].fp;
    h.rooms.denyDevice(h.roomId, fp);
    expect((await attempt).ok).toBe(false);
  });

  it("checks remote write escalation and keeps project permission independent from delegation", async () => {
    const h = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port: h.port });
    guest.rooms.setFilePolicy(h.roomId, "allow");
    await guest.rooms.addSeat(h.roomId, "agent", "远端审查", undefined, { executorUserId: joined.room!.localUserId! });
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.seats.some(s => s.name === "远端审查")).toBe(true));
    await h.rooms.controlTask({ roomId: h.roomId, action: "policy", policy: "read-only" });
    await selectedSend(h.rooms, h.roomId, h.human.id, "@开发助手 work");
    await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(1));
    const source = await agentClient(h.sessions.start.mock.calls[0][2]!);
    const target = h.rooms.get(h.roomId)!.seats.find(s => s.name === "远端审查")!;
    const delegated = await source.call({ requestId: "remote-read", mode: "delegate", targetSeatId: target.id, text: "read only", readOnly: true });
    await vi.waitFor(() => expect(guest.sessions.start).toHaveBeenCalledTimes(1));
    const extras = guest.sessions.start.mock.calls[0][2]!;
    expect(extras.roomReadOnly).toBe(true);
    const upgrade = extras.requestRoomWriteAccess!("Edit", { file_path: "a.ts" });
    const current = () => h.rooms.get(h.roomId)!.tasks!.find(t => t.id === delegated.value!.taskId)!;
    await vi.waitFor(() => expect(current().approvalKind).toBe("write"));
    const command = { roomId: h.roomId, action: "approve" as const, taskId: current().id, requestId: current().approvalRequestId, allow: true };
    expect((await guest.rooms.controlTask(command)).ok).toBe(false);
    expect((await h.rooms.controlTask(command)).ok).toBe(true);
    expect(await upgrade).toBe(true);
    expect(current().readOnly).toBe(false);
    const remote = await agentClient(extras);
    expect((await remote.call({ requestId: "notify-human", mode: "notify", targetSeatId: h.human.id, text: "请确认检查结果" })).ok).toBe(true);
    expect(h.rooms.get(h.roomId)!.items.at(-1)?.mentions?.[0].seatId).toBe(h.human.id);
    guest.rooms.setFilePolicy(h.roomId, "deny");
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.members.find(m => m.userId === joined.room!.localUserId)?.filePolicy).toBe("deny"));
    // Existing turn must settle before the same target dequeues another task.
    pending.splice(1, 1)[0]();
    await vi.waitFor(() => expect(current().status).toBe("completed"));
    const denied = await source.call({ requestId: "denied", mode: "delegate", targetSeatId: target.id, text: "read again", readOnly: true });
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.tasks!.find(t => t.id === denied.value?.taskId)?.status).toBe("failed"));
    expect(guest.sessions.start).toHaveBeenCalledTimes(1);
    expect(guest.sessions.continue).not.toHaveBeenCalled();
  });

  it("does not evict an active task from the bounded UI snapshot as other tasks complete", async () => {
    const h = await host();
    await selectedSend(h.rooms, h.roomId, h.human.id, "@开发助手 long work");
    await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(1));
    const first = h.rooms.get(h.roomId)!.tasks![0].id;
    h.sessions.start.mockResolvedValueOnce("quick-session");
    for (let n = 0; n < 66; n++) {
      await selectedSend(h.rooms, h.roomId, h.human.id, `@审查助手 quick ${n}`);
      await new Promise(resolve => setImmediate(resolve));
    }
    const visible = h.rooms.get(h.roomId)!.tasks!;
    expect(visible.length).toBeLessThanOrEqual(64);
    expect(visible.some(t => t.id === first && t.status === "running")).toBe(true);
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port: h.port });
    expect(joined.room!.tasks!.some(t => t.id === first)).toBe(true);
  });

  it("invalidates remote approval when its executor leaves the room", async () => {
    const h = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port: h.port });
    await guest.rooms.addSeat(h.roomId, "agent", "远端审查", undefined, { executorUserId: joined.room!.localUserId! });
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.seats.some(s => s.name === "远端审查")).toBe(true));
    await selectedSend(h.rooms, h.roomId, h.human.id, "@远端审查 work");
    const ask = () => guest.events.find(e => e.channel === IPC.roomPermAsk && !(e.payload as { resolved?: boolean }).resolved);
    await vi.waitFor(() => expect(ask()).toBeDefined());
    guest.rooms.leave(h.roomId);
    expect(guest.rooms.respondTurnAsk((ask()!.payload as { requestId: string }).requestId, true).ok).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(guest.sessions.start).not.toHaveBeenCalled();
  });

  it("does not trust a fingerprint unrelated to the handshake public key", async () => {
    const h = await host();
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}`);
    rawSockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const response = new Promise<string>(resolve => ws.once("message", data => resolve(String(data))));
    ws.send(JSON.stringify(makeHandshake("hello", { userId: "attacker", name: "attacker", fp: "0".repeat(64), pub: generateDeviceKeys().publicRaw.toString("base64url") })));
    expect(JSON.parse(await response).type).toBe("reject");
  });

  it("rejects an unauthenticated socket claiming an existing member", async () => {
    const h = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port: h.port });
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}`);
    rawSockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const response = new Promise<string>(resolve => ws.once("message", data => resolve(String(data))));
    ws.send(JSON.stringify(makeRoomFrame(h.roomId, 1, "join", { userId: joined.room!.localUserId, name: "forged", protocol: ROOM_PROTOCOL_VERSION })));
    expect(JSON.parse(await response).type).toBe("error");
  });

  it("dequeues a normal chat task when an existing Mod turn releases the same seat", async () => {
    const h = await host();
    const internal = h.rooms as unknown as {
      rooms: Map<string, { seats: RoomSeat[] }>;
      injectAgentTurn(r: unknown, s: RoomSeat, turn: { should: boolean; view: unknown; prompt: string; actions: unknown }): Promise<void>;
    };
    const record = internal.rooms.get(h.roomId)!;
    const seat = record.seats.find(s => s.id === h.agents[0].id)!;
    const modTurn = internal.injectAgentTurn(record, seat, { should: true, view: {}, prompt: "activity", actions: {} });
    await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(1));
    await selectedSend(h.rooms, h.roomId, h.human.id, "@开发助手 user work");
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.tasks![0]?.status).toBe("queued"));
    pending.shift()!();
    await modTurn;
    await vi.waitFor(() => expect(h.sessions.continue).toHaveBeenCalledTimes(1));
  });

  it("releases the attachment references of a cancelled queued task", async () => {
    const h = await host();
    await selectedSend(h.rooms, h.roomId, h.human.id, "@开发助手 running");
    await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(1));
    const text = "@开发助手 with file";
    await h.rooms.send(h.roomId, h.human.id, text, undefined, [attachmentFixture("note.txt")], [{ seatId: h.agents[0].id, start: 0, end: 5 }]);
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.tasks!.some(t => t.status === "queued")).toBe(true));
    const queued = h.rooms.get(h.roomId)!.tasks!.find(t => t.status === "queued")!;
    await h.rooms.controlTask({ roomId: h.roomId, action: "stop", taskId: queued.id });
    const record = (h.rooms as unknown as { rooms: Map<string, { taskAttachments?: Map<string, Attachment[]> }> }).rooms.get(h.roomId)!;
    expect(record.taskAttachments?.has(queued.id)).toBe(false);
  });

  it("retains idempotency for colon-containing request IDs while pruning notification history", async () => {
    const h = await host();
    for (let n = 0; n < 7; n++) h.rooms.addSeat(h.roomId, "agent", `Extra${n}`);
    const agents = h.rooms.get(h.roomId)!.seats.filter(s => s.kind === "agent");
    const clients: Awaited<ReturnType<typeof agentClient>>[] = [];
    for (const [n, seat] of agents.entries()) {
      await selectedSend(h.rooms, h.roomId, h.human.id, `@${seat.name} work`);
      await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(n + 1));
      clients.push(await agentClient(h.sessions.start.mock.calls[n][2]!));
    }
    const original = { requestId: "retry:original", mode: "notify", targetSeatId: h.human.id, text: "ONE ORIGINAL NOTICE" };
    expect((await clients[0].call(original)).ok).toBe(true);
    for (const [n, client] of clients.entries()) {
      for (let m = 0; m < 29; m++) expect((await client.call({ ...original, requestId: `n${m}`, text: `notice ${n}-${m}` })).ok).toBe(true);
    }
    expect((await clients[0].call(original)).ok).toBe(true);
    expect(h.rooms.get(h.roomId)!.items.filter(i => i.text.includes("ONE ORIGINAL NOTICE"))).toHaveLength(1);
  });

  it("cannot approve a remote write after the workspace owner switches policy to deny", async () => {
    const h = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port: h.port });
    guest.rooms.setFilePolicy(h.roomId, "allow");
    await guest.rooms.addSeat(h.roomId, "agent", "远端审查", undefined, { executorUserId: joined.room!.localUserId! });
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.seats.some(s => s.name === "远端审查")).toBe(true));
    await h.rooms.controlTask({ roomId: h.roomId, action: "policy", policy: "read-only" });
    await selectedSend(h.rooms, h.roomId, h.human.id, "@开发助手 work");
    await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(1));
    const client = await agentClient(h.sessions.start.mock.calls[0][2]!);
    const target = h.rooms.get(h.roomId)!.seats.find(s => s.name === "远端审查")!;
    const child = await client.call({ requestId: "read", mode: "delegate", targetSeatId: target.id, text: "read", readOnly: true });
    await vi.waitFor(() => expect(guest.sessions.start).toHaveBeenCalledTimes(1));
    const write = guest.sessions.start.mock.calls[0][2]!.requestRoomWriteAccess!("Edit", {});
    const task = () => h.rooms.get(h.roomId)!.tasks!.find(t => t.id === child.value!.taskId)!;
    await vi.waitFor(() => expect(task().approvalKind).toBe("write"));
    guest.rooms.setFilePolicy(h.roomId, "deny");
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.members.find(m => m.userId === joined.room!.localUserId)?.filePolicy).toBe("deny"));
    await h.rooms.controlTask({ roomId: h.roomId, action: "approve", taskId: task().id, requestId: task().approvalRequestId, allow: true });
    expect(await write).toBe(false);
  });

  it("stops the original remote executor even after the seat is rebound", async () => {
    const h = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port: h.port });
    guest.rooms.setFilePolicy(h.roomId, "allow");
    await guest.rooms.addSeat(h.roomId, "agent", "远端审查", undefined, { executorUserId: joined.room!.localUserId! });
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.seats.some(s => s.name === "远端审查")).toBe(true));
    await selectedSend(h.rooms, h.roomId, h.human.id, "@远端审查 work");
    await vi.waitFor(() => expect(guest.sessions.start).toHaveBeenCalledTimes(1));
    const task = h.rooms.get(h.roomId)!.tasks![0];
    expect(h.rooms.updateSeat(h.roomId, task.seatId, { workspaceUserId: h.rooms.get(h.roomId)!.localUserId! }).ok).toBe(true);
    await h.rooms.controlTask({ roomId: h.roomId, action: "stop", taskId: task.id });
    await vi.waitFor(() => expect(guest.sessions.abort).toHaveBeenCalledTimes(1));
    expect(h.sessions.abort).not.toHaveBeenCalled();
  });

  it("rechecks the seat reservation after an asynchronous Mod agentTurn", async () => {
    const h = await host();
    const internal = h.rooms as unknown as {
      rooms: Map<string, { modHost?: unknown; modStarted?: boolean }>;
      promptAgents(r: unknown): Promise<void>;
    };
    const record = internal.rooms.get(h.roomId)!;
    let release!: (turn: unknown) => void;
    record.modHost = { agentTurn: (id: string) => id === h.agents[0].id ? new Promise(resolve => { release = resolve; }) : Promise.resolve(null) };
    record.modStarted = true;
    try {
      const waiting = internal.promptAgents(record);
      await selectedSend(h.rooms, h.roomId, h.human.id, "@开发助手 work");
      await vi.waitFor(() => expect(h.sessions.start).toHaveBeenCalledTimes(1));
      release({ should: true, view: {}, prompt: "activity", actions: {} });
      await waiting;
      expect(h.sessions.continue).not.toHaveBeenCalled();
    } finally { record.modHost = undefined; }
  });

  it.each([false, true])("rechecks project denial after preparing model access (remote=%s)", async remote => {
    const h = await host();
    const guest = service();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port: h.port });
    const executor = remote ? guest : h;
    executor.rooms.setFilePolicy(h.roomId, "allow");
    let release!: (extras: SessionRunOpts) => void;
    const preparing = vi.spyOn(executor.rooms as unknown as { borrowAiExtras(): Promise<SessionRunOpts> }, "borrowAiExtras")
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    if (remote) {
      await guest.rooms.addSeat(h.roomId, "agent", "远端审查", undefined, { executorUserId: joined.room!.localUserId! });
      await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.seats.some(s => s.name === "远端审查")).toBe(true));
      await selectedSend(h.rooms, h.roomId, h.human.id, "@远端审查 work");
    } else {
      const own = joined.room!.seats.find(s => s.occupantUserId === joined.room!.localUserId)!;
      await selectedSend(guest.rooms, h.roomId, own.id, "@开发助手 work");
    }
    await vi.waitFor(() => expect(preparing).toHaveBeenCalledTimes(1));
    executor.rooms.setFilePolicy(h.roomId, "deny");
    release({});
    await vi.waitFor(() => expect(h.rooms.get(h.roomId)!.tasks![0].status).toBe("failed"));
    expect(executor.sessions.start).not.toHaveBeenCalled();
  });
});
