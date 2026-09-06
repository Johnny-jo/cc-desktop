import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomListItem, RoomSnapshot } from "@claude-desktop/shared";

vi.mock("./store", () => ({
  clearActiveSession: () => {}, clearChangesSessionOverride: () => {},
  detachedWindowRoomId: () => null, detachedWindowSessionId: () => null,
}));
vi.mock("./room-changes-bridge", () => ({ syncRoomSeatSessions: () => {} }));

const room: RoomSnapshot = {
  roomId: "r", name: "测试群", status: "open", port: 0, hostLabel: "host", inviteHost: "",
  memberCount: 1, requireMods: false, modChecksum: "", autoApprove: false, hasPassword: false,
  encrypt: true, localUserId: "me", members: [{ userId: "me", name: "本人", role: "member" }],
  seats: [
    { id: "human", kind: "human", name: "本人", occupantUserId: "me", takenOverBy: null, sessionId: null, running: false, agentName: null },
    { id: "agent", kind: "agent", name: "开发", occupantUserId: null, takenOverBy: null, sessionId: null, running: false, agentName: null },
  ],
  items: [{ id: "initial", at: 0, seatId: "human", authorUserId: "me", authorLabel: "本人", kind: "user", text: "开场" }],
  tasks: [{ id: "task", rootTaskId: "task", initiatorUserId: "me", seatId: "agent", status: "running", text: "工作", readOnly: true, createdAt: 0 }],
};

async function setup() {
  let event: (...args: unknown[]) => void = () => {};
  const api = {
    getRoom: vi.fn(async () => ({ room })),
    listRooms: vi.fn(async (): Promise<{ rooms: RoomListItem[] }> => ({ rooms: [] })),
    sendRoomMessage: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
    controlRoomTask: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
    on: (_name: string, cb: typeof event) => { event = cb; return () => {}; },
  };
  vi.stubGlobal("window", { desktop: api });
  vi.stubGlobal("document", { hasFocus: () => false });
  const notifications: string[] = [];
  vi.stubGlobal("Notification", class { constructor(_title: string, opts: { body: string }) { notifications.push(opts.body); } });
  const store = await import("./room-store");
  store.selectRoom(room.roomId);
  await Promise.resolve();
  store.bindRoomEvents();
  return { store, api, emit: (snapshot: RoomSnapshot, flags: Record<string, unknown> = {}) => event({ roomId: snapshot.roomId, room: snapshot, ...flags }), notifications };
}

beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });

describe("room store structured messages and controls", () => {
  it("keeps the message id on failure, then allocates a fresh id after success", async () => {
    const { store, api } = await setup();
    api.sendRoomMessage.mockResolvedValueOnce({ ok: false });
    await store.sendToSeat("retry body");
    await store.sendToSeat("retry body");
    expect(api.sendRoomMessage.mock.calls[0][6]).toEqual(expect.any(String));
    expect(api.sendRoomMessage.mock.calls[1][6]).toBe(api.sendRoomMessage.mock.calls[0][6]);
    await store.sendToSeat("retry body");
    expect(api.sendRoomMessage.mock.calls[2][6]).not.toBe(api.sendRoomMessage.mock.calls[0][6]);
  });
  it("returns IPC failure as a send error and retains retry identity", async () => {
    const { store, api } = await setup();
    api.sendRoomMessage.mockRejectedValueOnce(new Error("connection lost"));
    expect(await store.sendToSeat("retry body")).toEqual({ ok: false, error: "connection lost" });
    await store.sendToSeat("retry body");
    expect(api.sendRoomMessage.mock.calls[1][6]).toBe(api.sendRoomMessage.mock.calls[0][6]);
  });
  it("sends the exact body and valid metadata from my human seat despite an Agent selection", async () => {
    const { store, api } = await setup();
    store.selectSeat("agent");
    const text = "  @开发 ";
    const mentions = [{ seatId: "agent", start: 2, end: 5 }];
    await store.sendToSeat(text, undefined, undefined, [], mentions);
    expect(api.sendRoomMessage).toHaveBeenCalledWith("r", "human", text, undefined, [], mentions, expect.any(String));
  });
  it("does not forward invalid marks or impersonate the provided Agent target", async () => {
    const { store, api } = await setup();
    await store.sendToSeat("@开发", undefined, "agent", [], [{ seatId: "agent", start: 0, end: 3 }]);
    expect(api.sendRoomMessage).toHaveBeenCalledWith("r", "human", "@开发", undefined, [], [], expect.any(String));
  });
  it("does not implicitly select an Agent when the human seat disappears", async () => {
    const { store, emit, api } = await setup();
    emit({ ...room, seats: [room.seats[1]] });
    expect(store.getRoomState().selectedSeatId).toBeNull();
    expect((await store.sendToSeat("hello")).ok).toBe(false);
    expect(api.sendRoomMessage).not.toHaveBeenCalled();
  });
  it("forwards requestId and policy without locally claiming a task has stopped", async () => {
    const { store, api } = await setup();
    const stop = { roomId: "r", action: "stop" as const, taskId: "task" };
    await store.controlRoomTask(stop);
    expect(api.controlRoomTask).toHaveBeenCalledWith(stop);
    expect(store.getRoomState().activeRoom?.tasks?.[0].status).toBe("running");
    await store.controlRoomTask({ roomId: "r", action: "approve", taskId: "task", requestId: "request-2", allow: false });
    expect(api.controlRoomTask).toHaveBeenLastCalledWith({ roomId: "r", action: "approve", taskId: "task", requestId: "request-2", allow: false });
    await store.controlRoomTask({ roomId: "r", action: "policy", policy: "read-only" });
    expect(api.controlRoomTask).toHaveBeenLastCalledWith({ roomId: "r", action: "policy", policy: "read-only" });
  });
  it("surfaces control rejection and accepts backend task snapshots", async () => {
    const { store, api, emit } = await setup();
    api.controlRoomTask.mockRejectedValueOnce(new Error("连接已断开"));
    expect(await store.controlRoomTask({ roomId: "r", action: "stop", taskId: "task" }))
      .toEqual({ ok: false, error: "连接已断开" });
    emit({ ...room, tasks: room.tasks!.map(task => ({ ...task, status: "stopping" })) });
    expect(store.getRoomState().activeRoom?.tasks?.[0].status).toBe("stopping");
  });
  it("notifies once for null-author tool mentions while ordinary assistant output stays quiet", async () => {
    const { emit, notifications } = await setup();
    emit(room);
    const prose = { id: "prose", at: 1, seatId: "agent", authorUserId: null, authorLabel: "开发", kind: "assistant" as const, text: "普通回复" };
    const mention = { ...prose, id: "mention", text: "@本人 请看", mentions: [{ seatId: "human", start: 0, end: 3 }] };
    const next = { ...room, items: [...room.items, prose, mention] };
    emit(next);
    emit(next);
    expect(notifications).toEqual(["[有人@我] @本人 请看"]);
  });
});

describe("room list snapshot previews", () => {
  it.each([{}, { reconnecting: true }, { error: true }, { closed: true, offline: true }, { pending: [] }])(
    "updates an inactive room's preview on every snapshot path (%j)", async flags => {
      const { store, emit } = await setup();
      const inactive = { ...room, roomId: "inactive", name: "另一个群", items: [{ ...room.items[0], at: 123, text: "新消息" }] };
      emit(inactive, flags);
      expect(store.getRoomState().rooms.find(r => r.roomId === "inactive")?.lastMessage)
        .toEqual({ authorLabel: "本人", text: "新消息", at: 123 });
      expect(store.getRoomState().activeRoom?.roomId).toBe(room.roomId);
    },
  );

  it("replaces a cached preview with recall, and clears it when no chat remains", async () => {
    const { store, emit } = await setup();
    emit(room);
    expect(store.getRoomState().rooms[0].lastMessage?.text).toBe("开场");
    emit({ ...room, items: [{ ...room.items[0], recalled: true, text: "private old text" }] });
    expect(store.getRoomState().rooms[0].lastMessage).toEqual({ authorLabel: "本人", text: "已撤回", at: 0 });
    emit({ ...room, items: [{ ...room.items[0], kind: "tool", text: "diagnostic" }] });
    expect(store.getRoomState().rooms[0].lastMessage).toBeUndefined();
  });

  it("preserves offline and role metadata on ended snapshots and uses fresh online counts", async () => {
    const { store, api, emit } = await setup();
    api.listRooms.mockResolvedValue({ rooms: [{
      roomId: "r", name: room.name, status: "ended", role: "host", offline: true,
      memberCount: 4, onlineCount: 3, port: 9, inviteHost: "saved-host",
    }] });
    await store.refreshRooms();
    emit({ ...room, status: "ended", localUserId: undefined, onlineCount: 0 });
    expect(store.getRoomState().rooms[0]).toMatchObject({ role: "host", offline: true, onlineCount: 0, lastMessage: { text: "开场" } });
  });

  it("derives role and online count from members for a newly observed room", async () => {
    const { store, emit } = await setup();
    emit({ ...room, members: [{ ...room.members[0], role: "host" }, { userId: "away", name: "离线成员", role: "member", online: false }] });
    expect(store.getRoomState().rooms[0]).toMatchObject({ role: "host", onlineCount: 1, lastMessage: { text: "开场" } });
  });

  it("updates membership role and clears a stale offline flag after a successful open snapshot", async () => {
    const { store, api, emit } = await setup();
    api.listRooms.mockResolvedValue({ rooms: [{ roomId: "r", name: room.name, status: "ended", role: "member", offline: true, memberCount: 1, port: 0, inviteHost: "" }] });
    await store.refreshRooms();
    emit({ ...room, onlineCount: 1, members: [{ ...room.members[0], role: "admin" }] });
    expect(store.getRoomState().rooms[0]).toMatchObject({ role: "admin", offline: false, onlineCount: 1, lastMessage: { text: "开场" } });
  });

  it("keeps the offline flag while reconnecting and respects an explicit offline event", async () => {
    const { store, api, emit } = await setup();
    api.listRooms.mockResolvedValue({ rooms: [{ roomId: "r", name: room.name, status: "ended", role: "member", offline: true, memberCount: 1, port: 0, inviteHost: "" }] });
    await store.refreshRooms();
    emit(room, { reconnecting: true });
    expect(store.getRoomState().rooms[0]).toMatchObject({ offline: true, lastMessage: { text: "开场" } });
    emit(room, { offline: true });
    expect(store.getRoomState().rooms[0].offline).toBe(true);
  });
});
