import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomMessageId, makeRoomFrame, ROOM_MESSAGE_RECEIPT_LIMIT, ROOM_MESSAGE_RETRY_WINDOW_MS, type RoomMessageReceipt, type Attachment, type UserPrompt } from "@claude-desktop/shared";
import { RoomService } from "./room-service";
import { RoomMetrics } from "./room-metrics";
import { buildUserContent } from "./attachment-reader";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";
import { RoomArchive } from "./room-archive";
import type { RoomAttachmentCache } from "./room-attachment-cache";

const nodes: Array<{ rooms: RoomService; dir: string }> = [];
function node(reuse?: { dir: string; archive: RoomArchive }) {
  const dir = reuse?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "room-attachment-integration-"));
  const sessions = { start: vi.fn().mockResolvedValue("attachment-session"), continue: vi.fn().mockResolvedValue(undefined), getTranscript: vi.fn().mockReturnValue([]), getChangesForSelect: vi.fn().mockReturnValue([]), abort: vi.fn(), syncExtras: vi.fn() };
  const rooms = new RoomService({ getWindow: () => null, sessions: sessions as unknown as SessionManager, settings: { get: () => ({ lastProjectPath: dir }) } as unknown as SettingsStore, archive: reuse?.archive ?? null, userDataDir: dir, metrics: new RoomMetrics(() => {}) });
  nodes.push({ rooms, dir });
  return { rooms, dir, sessions };
}
async function setup(encrypt = false) {
  const host = node();
  for (let n = 0; n < 10; n++) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const made = await host.rooms.create({ name: "Files", port, autoApprove: true, encrypt });
    if (!made.ok || !made.room) continue;
    const roomId = made.room.roomId;
    host.rooms.setFilePolicy(roomId, "allow");
    const guest = node();
    const joined = await guest.rooms.join({ host: "127.0.0.1", port });
    expect(joined.ok).toBe(true);
    const guestId = joined.room!.localUserId!;
    guest.rooms.setFilePolicy(roomId, "allow");
    return { host, guest, roomId, port, guestId, hostHuman: made.room.seats.find(s => s.kind === "human")!, guestHuman: joined.room!.seats.find(s => s.kind === "human" && s.occupantUserId === guestId)! };
  }
  throw new Error("test listener unavailable");
}
function file(dir: string, name: string, bytes: string | Buffer): Attachment {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return { path: filePath, name, size: Buffer.byteLength(bytes), mimeType: "text/plain", kind: "text" };
}
function wire(rooms: RoomService, roomId: string) {
  return (rooms as unknown as { rooms: Map<string, { client: WebSocket; guests: Set<WebSocket> }> }).rooms.get(roomId)!;
}
afterEach(async () => {
  for (const n of nodes.slice().reverse()) n.rooms.disposeAll();
  await new Promise(r => setTimeout(r, 30));
  for (const n of nodes.splice(0)) fs.rmSync(n.dir, { recursive: true, force: true });
});

describe("real room attachments", () => {
  it("persists receipts beyond display history and restores them after a service restart", async () => {
    const { host, guest, roomId, hostHuman } = await setup();
    const archive = new RoomArchive(host.dir, null);
    (host.rooms as unknown as { archive: RoomArchive }).archive = archive;
    const id = createRoomMessageId();
    const source = file(host.dir, "persisted.txt", "saved bytes");
    expect(await host.rooms.send(roomId, hostHuman.id, "persisted", undefined, [source], [], id)).toEqual({ ok: true });
    const internal = host.rooms as unknown as { append: (record: unknown, item: { kind: "system"; text: string }) => void };
    for (let n = 0; n < 401; n++) internal.append(wire(host.rooms, roomId), { kind: "system", text: `event ${n}` });
    guest.rooms.disposeAll();
    host.rooms.disposeAll();
    expect(archive.loadRoom(roomId)!.messageReceipts?.some(r => r.id === id)).toBe(true);
    const restarted = node({ dir: host.dir, archive });
    await vi.waitFor(() => expect(restarted.rooms.get(roomId)?.status).toBe("open"));
    expect(await restarted.rooms.send(roomId, hostHuman.id, "persisted", undefined, [source], [], id)).toEqual({ ok: true });
    expect(restarted.rooms.get(roomId)!.items.some(i => i.kind === "user")).toBe(false);
  });

  it("rejects expired or pruned ids instead of forgetting them and executing again", async () => {
    const { host, roomId, hostHuman } = await setup();
    const record = wire(host.rooms, roomId) as unknown as { messageReceipts: Map<string, RoomMessageReceipt>; minMessageTime: number };
    const at = Date.now() - 100_000;
    const entries = Array.from({ length: ROOM_MESSAGE_RECEIPT_LIMIT }, (_, index) => ({ userId: hostHuman.occupantUserId!, id: `${at + index}-${randomUUID()}`, at: at + index, digest: "a".repeat(64) }));
    record.messageReceipts = new Map(entries.map(r => [JSON.stringify([r.userId, r.id]), r]));
    expect(await host.rooms.send(roomId, hostHuman.id, "latest")).toEqual({ ok: true });
    expect(record.messageReceipts.size).toBeLessThanOrEqual(ROOM_MESSAGE_RECEIPT_LIMIT);
    expect(record.minMessageTime).toBeGreaterThan(at);
    expect((await host.rooms.send(roomId, hostHuman.id, "old", undefined, [], [], entries[0].id)).ok).toBe(false);
    expect((await host.rooms.send(roomId, hostHuman.id, "expired", undefined, [], [], `${Date.now() - ROOM_MESSAGE_RETRY_WINDOW_MS - 1}-${randomUUID()}`)).ok).toBe(false);
    expect(host.rooms.get(roomId)!.items.filter(i => i.kind === "user").map(i => i.text)).toEqual(["latest"]);
  });

  it("rejects excessive combined size before consuming cache quota", async () => {
    const { host, roomId, hostHuman } = await setup();
    const cache = (host.rooms as unknown as { attachmentCache: RoomAttachmentCache }).attachmentCache;
    const imports = vi.spyOn(cache, "importFile");
    const source = file(host.dir, "large.txt", Buffer.alloc(9 * 1024 * 1024, 65));
    const result = await host.rooms.send(roomId, hostHuman.id, "too much", undefined, [source, source, source]);
    expect(result.ok).toBe(false);
    expect(imports).not.toHaveBeenCalled();
    expect(host.rooms.get(roomId)!.items.some(i => i.kind === "user")).toBe(false);
  });

  it("cleans partial unpublished imports without removing a published attachment", async () => {
    const { host, roomId, hostHuman } = await setup();
    await host.rooms.send(roomId, hostHuman.id, "keep", undefined, [file(host.dir, "keep.txt", "published")]);
    const cacheRoot = path.join(host.dir, "room-attachments");
    const before = fs.readdirSync(cacheRoot, { recursive: true }).sort();
    const good = file(host.dir, "new.txt", "unpublished");
    const invalid = { ...file(host.dir, "bad.txt", "also unpublished"), name: "invalid/name.txt" };
    expect((await host.rooms.send(roomId, hostHuman.id, "bad batch", undefined, [good, invalid])).ok).toBe(false);
    expect(fs.readdirSync(cacheRoot, { recursive: true }).sort()).toEqual(before);
    const item = host.rooms.get(roomId)!.items.find(i => i.kind === "user")!;
    expect((await host.rooms.getAttachment(roomId, item.id, item.attachments![0].id)).ok).toBe(true);
  });

  it("retries an uncertain send from its immutable copy after the source disappears", async () => {
    const { host, guest, roomId, guestHuman } = await setup();
    const ws = [...wire(host.rooms, roomId).guests][0];
    const original = ws.send.bind(ws);
    vi.spyOn(ws, "send").mockImplementation((data, ...args: unknown[]) => {
      if (typeof data === "string" && JSON.parse(data).type === "chat.result") { ws.close(); return; }
      Reflect.apply(original, ws, [data, ...args]);
    });
    const source = file(guest.dir, "retry.txt", "durable file");
    const id = createRoomMessageId();
    expect((await guest.rooms.send(roomId, guestHuman.id, "uncertain", undefined, [source], [], id)).ok).toBe(false);
    expect(host.rooms.get(roomId)!.items.filter(i => i.kind === "user")).toHaveLength(1);
    fs.unlinkSync(source.path);
    expect((await guest.rooms.rejoin(roomId)).ok).toBe(true);
    expect(await guest.rooms.send(roomId, guestHuman.id, "uncertain", undefined, [source], [], id)).toEqual({ ok: true });
    expect(host.rooms.get(roomId)!.items.filter(i => i.kind === "user")).toHaveLength(1);
  });

  it("does not publish or start a task if the durable message receipt cannot be saved", async () => {
    const { host, roomId, hostHuman } = await setup();
    host.rooms.addSeat(roomId, "agent", "Reader");
    const seat = host.rooms.get(roomId)!.seats.find(s => s.name === "Reader")!;
    const saveRoom = vi.fn(() => { throw new Error("disk full"); });
    (host.rooms as unknown as { archive: RoomArchive }).archive = { saveRoom } as unknown as RoomArchive;
    const result = await host.rooms.send(roomId, hostHuman.id, "@Reader work", undefined, [], [{ seatId: seat.id, start: 0, end: 7 }]);
    expect(result).toEqual({ ok: false, error: "disk full" });
    expect(host.rooms.get(roomId)!.items.some(i => i.kind === "user")).toBe(false);
    expect(host.sessions.start).not.toHaveBeenCalled();
  });

  it("does not block ordinary chat while an upload is stalled, and rejects it on disconnect", async () => {
    const { host, guest, roomId, hostHuman, guestHuman } = await setup();
    const ws = wire(guest.rooms, roomId).client;
    const original = ws.send.bind(ws);
    let stalled = 0;
    vi.spyOn(ws, "send").mockImplementation((data, ...args: unknown[]) => {
      if (typeof data === "string" && JSON.parse(data).type === "attachment.chunk") { stalled++; return; }
      Reflect.apply(original, ws, [data, ...args]);
    });
    const sending = guest.rooms.send(roomId, guestHuman.id, "stalled upload", undefined, [file(guest.dir, "slow.txt", "bytes")]);
    const otherSending = guest.rooms.send(roomId, guestHuman.id, "second upload", undefined, [file(guest.dir, "slow2.txt", "bytes")]);
    await vi.waitFor(() => expect(stalled).toBe(2));
    expect(await guest.rooms.send(roomId, guestHuman.id, "guest ordinary")).toEqual({ ok: true });
    expect(await host.rooms.send(roomId, hostHuman.id, "ordinary chat")).toEqual({ ok: true });
    expect(host.rooms.get(roomId)!.items.filter(i => i.kind === "user").map(i => i.text)).toEqual(["guest ordinary", "ordinary chat"]);
    ws.close();
    expect((await sending).ok).toBe(false);
    expect((await otherSending).ok).toBe(false);
    await vi.waitFor(() => expect(wire(host.rooms, roomId).guests.size).toBe(0));
    expect(host.rooms.get(roomId)!.items.some(i => i.text === "stalled upload")).toBe(false);
  });

  it("checks published-reference authorization over the actual socket", async () => {
    const { guest, roomId } = await setup();
    const ws = wire(guest.rooms, roomId).client;
    const requestId = randomUUID();
    const result = new Promise<Record<string, unknown>>(resolve => {
      const listener = (raw: unknown) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "attachment.chunk" && frame.payload.requestId === requestId) { ws.off("message", listener); resolve(frame.payload); }
      };
      ws.on("message", listener);
    });
    ws.send(JSON.stringify(makeRoomFrame(roomId, 300, "attachment.get", { requestId, offset: 0, attachment: { id: randomUUID(), name: "unpublished.txt", size: 1, sha256: "a".repeat(64), mimeType: "text/plain", kind: "text" } })));
    expect(await result).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });

  it("cannot republish another member's recalled attachment by replaying its metadata", async () => {
    const { host, guest, roomId, hostHuman, guestHuman } = await setup();
    await host.rooms.send(roomId, hostHuman.id, "original", undefined, [file(host.dir, "hidden.txt", "never downloaded")]);
    await vi.waitFor(() => expect(guest.rooms.get(roomId)!.items.find(i => i.kind === "user")?.attachments).toHaveLength(1));
    const original = host.rooms.get(roomId)!.items.find(i => i.kind === "user")!;
    host.rooms.recall(roomId, original.id);
    await vi.waitFor(() => expect(guest.rooms.get(roomId)!.items.find(i => i.id === original.id)?.recalled).toBe(true));
    const clientMessageId = createRoomMessageId();
    const ws = wire(guest.rooms, roomId).client;
    const reply = new Promise<{ ok: boolean }>(resolve => {
      const listener = (raw: unknown) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "chat.result" && frame.payload.clientMessageId === clientMessageId) { ws.off("message", listener); resolve(frame.payload); }
      };
      ws.on("message", listener);
    });
    ws.send(JSON.stringify(makeRoomFrame(roomId, 300, "chat.user", { clientMessageId, seatId: guestHuman.id, text: "republish", mentions: [], attachments: original.attachments })));
    expect((await reply).ok).toBe(false);
    expect(host.rooms.get(roomId)!.items.some(i => i.text === "republish")).toBe(false);
  });

  it("stops a remote task during attachment transfer without starting the SDK", async () => {
    const { host, guest, roomId, guestId, hostHuman } = await setup();
    await guest.rooms.addSeat(roomId, "agent", "Reader", undefined, { executorUserId: guestId });
    await vi.waitFor(() => expect(host.rooms.get(roomId)!.seats.some(s => s.name === "Reader")).toBe(true));
    const seat = host.rooms.get(roomId)!.seats.find(s => s.name === "Reader")!;
    const hostSocket = [...wire(host.rooms, roomId).guests][0];
    let stopped: Promise<unknown> | undefined;
    hostSocket.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "attachment.get" && !stopped) {
        const task = host.rooms.get(roomId)!.tasks![0];
        stopped = host.rooms.controlTask({ roomId, action: "stop", taskId: task.id });
      }
    });
    await host.rooms.send(roomId, hostHuman.id, "@Reader read", undefined, [file(host.dir, "big.txt", "data".repeat(50000))], [{ seatId: seat.id, start: 0, end: 7 }]);
    await vi.waitFor(() => expect(stopped).toBeDefined());
    await stopped;
    await vi.waitFor(() => expect(host.rooms.get(roomId)!.tasks![0].status).toBe("cancelled"));
    expect(guest.sessions.start).not.toHaveBeenCalled();
  });
  it("copies guest bytes to the host before acknowledging, without paths in history", async () => {
    const { host, guest, roomId, guestHuman } = await setup(true);
    const reads = vi.spyOn((guest.rooms as unknown as { attachmentCache: RoomAttachmentCache }).attachmentCache, "read");
    const source = file(guest.dir, "资料.txt", "跨设备内容\n".repeat(9000));
    expect(await guest.rooms.send(roomId, guestHuman.id, "文件", undefined, [source])).toEqual({ ok: true });
    expect(reads).toHaveBeenCalledTimes(1); // Large files are not re-read in full for every 48 KiB chunk.
    const item = host.rooms.get(roomId)!.items.find(i => i.kind === "user")!;
    expect(item.attachments).toHaveLength(1);
    expect(JSON.stringify(item)).not.toContain(source.path);
    fs.unlinkSync(source.path);
    const downloaded = await host.rooms.getAttachment(roomId, item.id, item.attachments![0].id);
    expect(downloaded.ok).toBe(true);
    expect(downloaded.attachment!.path).not.toBe(source.path);
    expect(createHash("sha256").update(fs.readFileSync(downloaded.attachment!.path)).digest("hex")).toBe(item.attachments![0].sha256);
  }, 15000);

  it("delivers actual images and text to a different Agent node", async () => {
    const { host, guest, roomId, guestId, hostHuman } = await setup();
    await guest.rooms.addSeat(roomId, "agent", "远端附件", undefined, { executorUserId: guestId });
    await vi.waitFor(() => expect(host.rooms.get(roomId)!.seats.some(s => s.name === "远端附件")).toBe(true));
    const target = host.rooms.get(roomId)!.seats.find(s => s.name === "远端附件")!;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const inputs = [file(host.dir, "tiny.png", png), file(host.dir, "task.txt", "这是真实正文")];
    const text = "@远端附件 分析这些附件";
    expect(await host.rooms.send(roomId, hostHuman.id, text, undefined, inputs, [{ seatId: target.id, start: 0, end: 5 }])).toEqual({ ok: true });
    await vi.waitFor(() => expect(guest.sessions.start).toHaveBeenCalledTimes(1));
    const prompt = guest.sessions.start.mock.calls[0][0] as UserPrompt;
    expect(prompt.attachments).toHaveLength(2);
    expect(prompt.attachments.every(a => a.path.startsWith(guest.dir))).toBe(true);
    const content = buildUserContent(prompt);
    expect(content.errors).toEqual([]);
    expect(content.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", source: expect.objectContaining({ data: png.toString("base64") }) }), expect.objectContaining({ type: "text", text: expect.stringContaining("这是真实正文") })]));
  });

  it("does not publish or start an Agent when the selected source has disappeared", async () => {
    const { host, roomId, hostHuman } = await setup();
    host.rooms.addSeat(roomId, "agent", "Reader");
    const seat = host.rooms.get(roomId)!.seats.find(s => s.name === "Reader")!;
    const source = file(host.dir, "gone.txt", "unavailable");
    fs.unlinkSync(source.path);
    const result = await host.rooms.send(roomId, hostHuman.id, "@Reader read", undefined, [source], [{ seatId: seat.id, start: 0, end: 7 }]);
    expect(result.ok).toBe(false);
    expect(host.rooms.get(roomId)!.items.filter(i => i.kind === "user")).toEqual([]);
    expect(host.sessions.start).not.toHaveBeenCalled();
  });

  it("downloads binary files but fails closed when asked to send them to the model", async () => {
    const { host, guest, roomId, hostHuman } = await setup();
    host.rooms.addSeat(roomId, "agent", "Reader");
    const seat = host.rooms.get(roomId)!.seats.find(s => s.name === "Reader")!;
    const source = file(host.dir, "package.zip", Buffer.from([0x50, 0x4b, 0, 0xff]));
    await host.rooms.send(roomId, hostHuman.id, "@Reader read", undefined, [source], [{ seatId: seat.id, start: 0, end: 7 }]);
    await vi.waitFor(() => expect(host.rooms.get(roomId)!.tasks?.[0]?.status).toBe("failed"));
    expect(host.sessions.start).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(guest.rooms.get(roomId)!.items.find(i => i.kind === "user")?.attachments).toHaveLength(1));
    const item = guest.rooms.get(roomId)!.items.find(i => i.kind === "user")!;
    const result = await guest.rooms.getAttachment(roomId, item.id, item.attachments![0].id);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(result.attachment!.path)).toEqual(fs.readFileSync(source.path));
    expect(result.attachment!.kind).toBe("binary");
  });

  it("rejects unpublished ids and attachments on recalled messages", async () => {
    const { host, guest, roomId, hostHuman } = await setup();
    await host.rooms.send(roomId, hostHuman.id, "download", undefined, [file(host.dir, "note.txt", "private after recall")]);
    await vi.waitFor(() => expect(guest.rooms.get(roomId)!.items.find(i => i.kind === "user")?.attachments).toHaveLength(1));
    const item = guest.rooms.get(roomId)!.items.find(i => i.kind === "user")!;
    expect((await guest.rooms.getAttachment(roomId, item.id, randomUUID())).ok).toBe(false);
    expect(host.rooms.recall(roomId, item.id).ok).toBe(true);
    await vi.waitFor(() => expect(guest.rooms.get(roomId)!.items.find(i => i.id === item.id)?.recalled).toBe(true));
    expect((await guest.rooms.getAttachment(roomId, item.id, item.attachments![0].id)).ok).toBe(false);
  });

  it("does not duplicate a retried confirmed attachment message or its task", async () => {
    const { host, guest, roomId, guestHuman } = await setup();
    host.rooms.addSeat(roomId, "agent", "Reader");
    await vi.waitFor(() => expect(guest.rooms.get(roomId)!.seats.some(s => s.name === "Reader")).toBe(true));
    const seat = guest.rooms.get(roomId)!.seats.find(s => s.name === "Reader")!;
    const source = file(guest.dir, "note.txt", "exactly once");
    const id = createRoomMessageId();
    const send = () => guest.rooms.send(roomId, guestHuman.id, "@Reader read", undefined, [source], [{ seatId: seat.id, start: 0, end: 7 }], id);
    expect(await send()).toEqual({ ok: true });
    const internal = host.rooms as unknown as { append: (record: unknown, item: { kind: "system"; text: string }) => void };
    for (let n = 0; n < 401; n++) internal.append(wire(host.rooms, roomId), { kind: "system", text: `other event ${n}` });
    expect(await send()).toEqual({ ok: true });
    await vi.waitFor(() => expect(host.sessions.start).toHaveBeenCalledTimes(1));
    expect(host.rooms.get(roomId)!.items.filter(i => i.kind === "user")).toHaveLength(0);
  });
});
