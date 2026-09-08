import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeRoomInvite } from "@claude-desktop/shared";
import { RoomArchive } from "./room-archive";
import { RoomService } from "./room-service";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";
const token = "test-room-server-token-not-a-real-secret";
const children: ChildProcess[] = [];
const services: RoomService[] = [];
const dirs: string[] = [];
const archives: RoomArchive[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-hosted-test-")); dirs.push(dir); return dir; }
function client(userDataDir = temp(), persistent = false) {
  const archive = persistent ? new RoomArchive(userDataDir) : undefined;
  if (archive) archives.push(archive);
  const service = new RoomService({ getWindow: () => null, userDataDir,
    ...(archive ? { archive } : {}),
    sessions: {} as SessionManager, settings: { get: () => ({ lastProjectPath: null }) } as SettingsStore });
  services.push(service); return service;
}
async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>(resolve => { proc.once("exit", () => resolve()); proc.kill(); });
}
afterEach(async () => {
  for (const service of services.splice(0)) service.disposeAll();
  await Promise.all(children.splice(0).map(stop));
  for (const archive of archives.splice(0)) archive.database?.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function freePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function start(port = 0, data = temp()) {
  port ||= await freePort();
  // Run outside the repo: no workspace node_modules may mask missing bundle dependencies.
  const script = path.join(temp(), "room-relay-server.mjs");
  fs.copyFileSync(path.resolve(__dirname, "../../../../scripts/room-relay-server.mjs"), script);
  const proc = spawn(process.execPath, [script, "--port", String(port), "--data-dir", data], {
    env: { ...process.env, ROOM_SERVER_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(proc);
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(output || "startup timeout")), 10000);
    proc.stderr!.on("data", c => { output += String(c); });
    proc.stdout!.on("data", c => { output += String(c); if (output.includes("listening")) { clearTimeout(timer); resolve(); } });
    proc.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
  });
  return { proc, port, data, url: `ws://127.0.0.1:${port}` };
}
async function create(owner: RoomService, url: string, autoApprove = true) {
  const result = await owner.create({ name: "托管群", relay: url, relayToken: token, password: "password123", autoApprove });
  expect(result.ok, result.error).toBe(true); return result.room!;
}
function join(service: RoomService, owner: RoomService, id: string) {
  const invite = owner.invite(id); expect(invite.ok).toBe(true);
  return service.join({ ...decodeRoomInvite(invite.secret!), password: "password123" });
}
async function send(service: RoomService, id: string, text: string) {
  const snapshot = service.get(id)!;
  const seat = snapshot.seats.find(s => s.occupantUserId === snapshot.localUserId && s.kind === "human")!;
  const result = await service.send(id, seat.id, text); expect(result.ok, result.error).toBe(true);
}
describe("server-owned rooms (real deployment bundle)", () => {
  it("does not auto-rejoin a dismissed room after restarting the desktop", async () => {
    const server = await start(), memberDir = temp();
    const owner = client(), member = client(memberDir, true);
    const room = await create(owner, server.url);
    expect((await join(member, owner, room.roomId)).ok).toBe(true);
    expect(owner.end(room.roomId).ok).toBe(true);
    await expect.poll(() => member.get(room.roomId)?.status).toBe("ended");
    member.disposeAll();
    const restarted = client(memberDir, true);
    expect(restarted.get(room.roomId)?.status).toBe("ended");
    expect(restarted.list()[0].offline).toBeUndefined();
  }, 15000);
  it("automatically restores owner and member connections after desktop restart", async () => {
    const server = await start();
    const ownerDir = temp(), memberDir = temp();
    const owner = client(ownerDir, true), member = client(memberDir, true);
    const room = await create(owner, server.url);
    expect((await join(member, owner, room.roomId)).ok).toBe(true);
    const memberId = member.get(room.roomId)!.localUserId;
    owner.disposeAll(); member.disposeAll();
    const restoredOwner = client(ownerDir, true), restoredMember = client(memberDir, true);
    await expect.poll(() => restoredOwner.list().find(r => r.roomId === room.roomId)?.offline, { timeout: 10000 }).toBeUndefined();
    await expect.poll(() => restoredMember.list().find(r => r.roomId === room.roomId)?.offline, { timeout: 10000 }).toBeUndefined();
    expect(restoredOwner.get(room.roomId)?.localUserId).toBe(room.localUserId);
    expect(restoredMember.get(room.roomId)?.localUserId).toBe(memberId);
    expect(restoredOwner.list()[0].role).toBe("host");
    await send(restoredMember, room.roomId, "自动重连后发送");
    await expect.poll(() => restoredOwner.get(room.roomId)?.items.some(i => i.text === "自动重连后发送")).toBe(true);
    expect(restoredOwner.get(room.roomId)?.memberCount).toBe(2);
  }, 20000);

  it("keeps guests chatting after creator disconnect and preserves history across restart", async () => {
    const server = await start();
    const owner = client(), alice = client(), bob = client();
    const room = await create(owner, server.url);
    expect(room.hosted).toBe(true);
    expect(room.members).toHaveLength(1);
    expect(room.members.find(m => m.userId === room.localUserId)?.role).toBe("host");
    expect(room.seats).toHaveLength(1);
    expect(owner.list()[0].role).toBe("host");
    expect(room.memberCount).toBe(1);
    expect(room.onlineCount).toBe(1);
    expect((await join(alice, owner, room.roomId)).ok).toBe(true);
    expect((await join(bob, owner, room.roomId)).ok).toBe(true);
    owner.disposeAll();
    await expect.poll(() => alice.get(room.roomId)?.members.find(m => m.userId === room.localUserId)?.online).toBe(false);
    expect(alice.get(room.roomId)?.onlineCount).toBe(2);
    await send(alice, room.roomId, "群主离线后仍能发送");
    await expect.poll(() => bob.get(room.roomId)?.items.some(i => i.text === "群主离线后仍能发送")).toBe(true);
    await stop(server.proc); await start(server.port, server.data);
    expect((await alice.rejoin(room.roomId)).ok).toBe(true);
    expect((await bob.rejoin(room.roomId)).ok).toBe(true);
    expect(bob.get(room.roomId)?.members.filter(m => m.role === "host").map(m => m.userId)).toEqual([room.localUserId]);
    expect(bob.get(room.roomId)?.members).toHaveLength(3);
    expect(bob.get(room.roomId)?.items.some(i => i.text === "群主离线后仍能发送")).toBe(true);
    await send(bob, room.roomId, "重启后继续");
    await expect.poll(() => alice.get(room.roomId)?.items.some(i => i.text === "重启后继续")).toBe(true);
  }, 30000);
  it("keeps admission approval with the authenticated creator", async () => {
    const server = await start(); const owner = client(), guest = client();
    const room = await create(owner, server.url, false);
    const pending = join(guest, owner, room.roomId);
    await expect.poll(() => owner.pendingDevices(room.roomId).pending.length).toBe(1);
    expect(owner.approveDevice(room.roomId, owner.pendingDevices(room.roomId).pending[0].fp).ok).toBe(true);
    expect((await pending).ok).toBe(true);
    expect(guest.end(room.roomId).ok).toBe(false);
    const internals = guest as unknown as { rooms: Map<string, unknown>; sendClient: (room: unknown, type: string, payload: unknown) => void };
    internals.sendClient(internals.rooms.get(room.roomId), "host.control", { action: "rename", value: "非法名称" });
    // Follow the attack with a confirmed chat so the same socket has processed it.
    await send(guest, room.roomId, "权限检查");
    expect(guest.get(room.roomId)?.name).toBe("托管群");
    expect(owner.rename(room.roomId, "新名称").ok).toBe(true);
    await expect.poll(() => guest.get(room.roomId)?.name).toBe("新名称");
    owner.end(room.roomId);
    await expect.poll(() => guest.get(room.roomId)?.status).toBe("ended");
  }, 20000);
  it("lets only the authenticated owner grant and revoke admins, and protects the owner", async () => {
    const server = await start(); const owner = client(), admin = client(), guest = client();
    const room = await create(owner, server.url);
    const adminRoom = (await join(admin, owner, room.roomId)).room!;
    const guestRoom = (await join(guest, owner, room.roomId)).room!;
    expect(adminRoom.members.find(m => m.userId === adminRoom.localUserId)?.role).toBe("member");
    expect(owner.setMemberRole(room.roomId, adminRoom.localUserId!, "admin").ok).toBe(true);
    await expect.poll(() => admin.get(room.roomId)?.members.find(m => m.userId === adminRoom.localUserId)?.role).toBe("admin");
    expect(admin.setMemberRole(room.roomId, guestRoom.localUserId!, "admin").ok).toBe(false);
    expect(admin.end(room.roomId).ok).toBe(false);
    expect(admin.kick(room.roomId, room.localUserId!).ok).toBe(false);
    expect(owner.setMemberRole(room.roomId, room.localUserId!, "member").ok).toBe(false);
    const internals = admin as unknown as { rooms: Map<string, unknown>; sendClient: (room: unknown, type: string, payload: unknown) => void };
    const connection = internals.rooms.get(room.roomId);
    internals.sendClient(connection, "member.role", { userId: guestRoom.localUserId, role: "admin" });
    internals.sendClient(connection, "member.role", { userId: room.localUserId, role: "member" });
    internals.sendClient(connection, "member.role", { userId: adminRoom.localUserId, role: "host" });
    internals.sendClient(connection, "join", { userId: room.localUserId, name: "冒充群主", protocol: 3, role: "host" });
    internals.sendClient(connection, "host.control", { action: "end" });
    await send(admin, room.roomId, "管理员越权请求已处理");
    await expect.poll(() => owner.get(room.roomId)?.items.some(i => i.text === "管理员越权请求已处理")).toBe(true);
    expect(owner.get(room.roomId)?.status).toBe("open");
    expect(owner.get(room.roomId)?.members.filter(m => m.role === "host").map(m => m.userId)).toEqual([room.localUserId]);
    expect(owner.get(room.roomId)?.members.find(m => m.userId === guestRoom.localUserId)?.role).toBe("member");
    const message = owner.get(room.roomId)!.items.find(i => i.text === "管理员越权请求已处理")!;
    expect(owner.recall(room.roomId, message.id).ok).toBe(true);
    await expect.poll(() => admin.get(room.roomId)?.items.find(i => i.id === message.id)?.recalled).toBe(true);
    expect(owner.setMemberRole(room.roomId, adminRoom.localUserId!, "member").ok).toBe(true);
    await expect.poll(() => admin.get(room.roomId)?.members.find(m => m.userId === adminRoom.localUserId)?.role).toBe("member");
  }, 20000);
  it("restores one owner identity when the creating device rejoins from an invitation", async () => {
    const server = await start(), deviceDir = temp();
    const owner = client(deviceDir), guest = client();
    const room = await create(owner, server.url);
    expect((await join(guest, owner, room.roomId)).ok).toBe(true);
    owner.disposeAll();
    const restored = client(deviceDir);
    const joined = await join(restored, guest, room.roomId);
    expect(joined.ok, joined.error).toBe(true);
    expect(joined.room?.localUserId).toBe(room.localUserId);
    expect(joined.room?.members.filter(m => m.role === "host")).toHaveLength(1);
    expect(joined.room?.members).toHaveLength(2);
    expect(restored.rename(room.roomId, "恢复群主身份").ok).toBe(true);
    await expect.poll(() => guest.get(room.roomId)?.name).toBe("恢复群主身份");
  }, 20000);
  it.each([false, true])("restores an old owner only with unambiguous persisted device evidence (ambiguous: %s)", async (ambiguous) => {
    const server = await start(), owner = client(), guest = client();
    const room = await create(owner, server.url);
    expect((await join(guest, owner, room.roomId)).ok).toBe(true);
    await send(guest, room.roomId, "迁移前消息");
    await stop(server.proc);
    const archive = new RoomArchive(server.data);
    const stored = archive.loadRoom(room.roomId)!;
    expect(stored.hosted).toBe(true);
    expect(stored.hostedOwnerFp).toMatch(/^[a-f0-9]{64}$/);
    const ownerMember = stored.members!.find(m => m.userId === room.localUserId)!;
    ownerMember.role = "admin";
    if (ambiguous) stored.members!.find(m => m.userId !== room.localUserId)!.role = "admin";
    stored.members!.push({ userId: stored.localUserId!, name: "群聊服务器", role: "host", online: true });
    stored.seats!.push({ id: "legacy-server-seat", kind: "human", name: "群聊服务器", occupantUserId: stored.localUserId!, takenOverBy: null, sessionId: null, running: false, agentName: null });
    // Old normalize() discarded these fields, despite create() writing them.
    delete stored.hosted;
    delete stored.hostedOwnerFp;
    archive.saveRoom(stored); archive.close();
    await start(server.port, server.data);
    const joined = await guest.rejoin(room.roomId);
    expect(joined.ok, joined.error).toBe(true);
    expect(joined.room?.members.filter(m => m.role === "host").map(m => m.userId)).toEqual(ambiguous ? [] : [room.localUserId]);
    expect(joined.room?.members.some(m => m.userId === stored.localUserId)).toBe(false);
    expect(joined.room?.seats.some(s => s.occupantUserId === stored.localUserId)).toBe(false);
    expect(joined.room?.memberCount).toBe(2);
    expect((await owner.rejoin(room.roomId)).ok).toBe(true);
    if (ambiguous) {
      expect(owner.rename(room.roomId, "不能凭管理员角色猜群主").ok).toBe(false);
      return;
    }
    expect(owner.rename(room.roomId, "旧群已修复").ok).toBe(true);
    await expect.poll(() => guest.get(room.roomId)?.name).toBe("旧群已修复");
  }, 20000);
  it("rejects missing token, unsafe admission and removed legacy endpoints", async () => {
    const server = await start(); const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/rooms`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/ctl?id=0123456789ab`)).status).toBe(404);
    const result = await client().create({ name: "unsafe", relay: server.url, relayToken: token, autoApprove: true });
    expect(result.ok).toBe(false); expect(result.error).toContain("8");
  });
  it("keeps LAN rooms hosted on the creator desktop", async () => {
    const owner = client(), guest = client();
    const result = await owner.create({ name: "局域网", port: await freePort(), autoApprove: true });
    expect(result.ok).toBe(true); expect(result.room?.hosted).toBe(false);
    expect((await guest.join({ host: "127.0.0.1", port: result.room!.port })).ok).toBe(true);
    await send(guest, result.room!.roomId, "LAN正常"); owner.disposeAll();
    await expect.poll(() => guest.list().find(r => r.roomId === result.room!.roomId)?.offline).toBe(true);
  });
});
