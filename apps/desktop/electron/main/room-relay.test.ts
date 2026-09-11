import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const serverLogs = new Map<string, () => string>();
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-hosted-test-")); dirs.push(dir); return dir; }
function client(userDataDir = temp(), persistent = false, sessions = {} as SessionManager, projectPath: string | null = null) {
  const archive = persistent ? new RoomArchive(userDataDir) : undefined;
  if (archive) archives.push(archive);
  const service = new RoomService({ getWindow: () => null, userDataDir,
    ...(archive ? { archive } : {}),
    sessions, settings: { get: () => ({ lastProjectPath: projectPath }) } as SettingsStore });
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
  serverLogs.clear();
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
  let output = "";
  serverLogs.set(`ws://127.0.0.1:${port}`, () => output);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output || "startup timeout")), 10000);
    proc.stderr!.on("data", c => { output += String(c); });
    proc.stdout!.on("data", c => { output += String(c); if (output.includes("listening")) { clearTimeout(timer); resolve(); } });
    proc.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
  });
  return { proc, port, data, url: `ws://127.0.0.1:${port}` };
}
async function create(owner: RoomService, url: string, autoApprove = true) {
  const result = await owner.create({ name: "托管群", relay: url, relayToken: token, password: "password123", autoApprove });
  expect(result.ok, `${result.error ?? ""}\n${serverLogs.get(url)?.() ?? ""}`).toBe(true); return result.room!;
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
  it("rejects server execution frames, impersonated seats and unauthorized extension control", async () => {
    const server = await start(), owner = client(), member = client();
    const room = await create(owner, server.url);
    expect((await join(member, owner, room.roomId)).ok).toBe(true);
    const wire = (service: RoomService) => service as unknown as {
      rooms: Map<string, unknown>;
      sendClient: (r: unknown, type: string, p: unknown) => void;
      roomRpc: (r: unknown, type: string, p: unknown) => Promise<{ ok: boolean; error?: string }>;
      safeSend: (channel: string, p: unknown) => void;
    };
    const m = wire(member), o = wire(owner), record = m.rooms.get(room.roomId);
    const errors = vi.spyOn(m, "safeSend");
    m.sendClient(record, "exec.run", { turnId: "forged", seatId: "server", text: "run on server" });
    m.sendClient(record, "seat.add", { userId: room.localUserId, kind: "agent", name: "Forged" });
    await send(member, room.roomId, "攻击帧之后的正常消息");
    expect(errors.mock.calls.some(([, p]) => (p as { message?: string }).message?.includes("托管服务器禁止执行 Agent"))).toBe(true);
    expect(owner.get(room.roomId)?.seats.some(s => s.name === "Forged")).toBe(false);
    expect((await m.roomRpc(record, "extension.request", { action: "sync", state: {} })).ok).toBe(false);
    expect((await o.roomRpc(o.rooms.get(room.roomId), "extension.request", { action: "execute", code: "process.exit(1)" })).ok).toBe(false);
    expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).ok).toBe(true);
    errors.mockRestore();
  }, 15000);

  it("runs Agent tasks and resolves attachments on a member desktop, never on the server", async () => {
    const server = await start(), owner = client(), dir = temp();
    const sessions = { start: vi.fn().mockResolvedValue("desktop-session"), continue: vi.fn(), getTranscript: vi.fn().mockReturnValue([{ kind: "text", role: "assistant", text: "成员电脑执行完成" }]), getChangesForSelect: vi.fn().mockReturnValue([]), abort: vi.fn(), syncExtras: vi.fn() };
    const member = client(dir, false, sessions as unknown as SessionManager, dir);
    const room = await create(owner, server.url);
    expect((await join(member, owner, room.roomId)).ok).toBe(true);
    const memberId = member.get(room.roomId)!.localUserId!;
    expect(member.addSeat(room.roomId, "agent", "Desktop Agent").ok).toBe(true);
    await expect.poll(() => member.get(room.roomId)?.seats.some(s => s.kind === "agent")).toBe(true);
    const agent = member.get(room.roomId)!.seats.find(s => s.kind === "agent")!;
    expect(agent.workspaceUserId).toBe(memberId);
    const human = member.get(room.roomId)!.seats.find(s => s.occupantUserId === memberId)!;
    const attachmentPath = path.join(dir, "input.txt");
    fs.writeFileSync(attachmentPath, "来自成员电脑的附件");
    const label = "@" + agent.name;
    const result = await member.send(room.roomId, human.id, label + " 读取附件", undefined,
      [{ path: attachmentPath, name: "input.txt", kind: "text", mimeType: "text/plain", size: fs.statSync(attachmentPath).size }],
      [{ seatId: agent.id, start: 0, end: label.length }]);
    expect(result.ok, result.error).toBe(true);
    await expect.poll(() => sessions.start.mock.calls.length).toBe(1);
    expect(sessions.start.mock.calls[0][1]).toBe(dir);
    expect(sessions.start.mock.calls[0][2]).toMatchObject({ pathJail: dir });
    await expect.poll(() => owner.get(room.roomId)?.items.some(i => i.text === "成员电脑执行完成")).toBe(true);
    const item = owner.get(room.roomId)!.items.find(i => i.attachments?.length)!;
    member.disposeAll();
    const fetched = await owner.getAttachment(room.roomId, item.id, item.attachments![0].id);
    expect(fetched.ok).toBe(true);
    expect(fs.readFileSync(fetched.attachment!.path, "utf8")).toBe("来自成员电脑的附件");
    expect(owner.updateSeat(room.roomId, agent.id, { name: "Renamed Agent" }).ok).toBe(true);
    await expect.poll(() => owner.get(room.roomId)?.seats.find(s => s.id === agent.id)?.name).toBe("Renamed Agent");
    const ownHuman = owner.get(room.roomId)!.seats.find(s => s.occupantUserId === room.localUserId)!;
    const mention = "@Renamed Agent";
    await owner.send(room.roomId, ownHuman.id, mention + " 再执行", undefined, undefined, [{ seatId: agent.id, start: 0, end: mention.length }]);
    await expect.poll(() => owner.get(room.roomId)?.items.some(i => i.text.includes("对方不在线"))).toBe(true);
    const rejoined = await client(dir).join({ ...decodeRoomInvite(owner.invite(room.roomId).secret!), password: "password123", userId: memberId });
    expect(rejoined.ok).toBe(true);
    expect(rejoined.room?.localUserId).toBe(memberId);
    const ownerErrors = vi.spyOn(owner as unknown as { safeSend: (channel: string, data: unknown) => void }, "safeSend");
    expect(owner.kick(room.roomId, memberId).ok).toBe(true);
    await send(owner, room.roomId, "踢人后的确认消息");
    expect(ownerErrors.mock.calls.map(([, data]) => data).filter(data => (data as { error?: boolean }).error)).toEqual([]);
    ownerErrors.mockRestore();
    await expect.poll(() => owner.get(room.roomId)?.members.some(m => m.userId === memberId)).toBe(false);
    await owner.send(room.roomId, ownHuman.id, mention + " 节点已移除", undefined, undefined, [{ seatId: agent.id, start: 0, end: mention.length }]);
    await expect.poll(() => owner.get(room.roomId)?.tasks?.some(t => t.error?.includes("不能使用服务器工作区"))).toBe(true);
    await send(owner, room.roomId, "服务器仍然可用");
  }, 20000);

  it("executes Mod and kernel code only on the owner's desktop and relays member actions", async () => {
    const server = await start(), owner = client(), member = client();
    const room = await create(owner, server.url);
    expect((await join(member, owner, room.roomId)).ok).toBe(true);
    const modDir = temp();
    fs.writeFileSync(path.join(modDir, "manifest.json"), JSON.stringify({ id: "hosted-counter", name: "Counter", version: "1.0.0", hostApi: 1, permissions: [], seats: { min: 2, max: 4, roles: [] }, agent: false }));
    fs.writeFileSync(path.join(modDir, "host.js"), `export function createGame() { return {
      initialState() { return { n: 0 }; }, reduce(s, i) { return { n: i.name === "inc" ? s.n + 1 : s.n }; },
      getPublicView(s) { return s; }, getSeatView(s, id) { return { n: s.n, secret: id }; },
      getActions() { return [{ name: "inc" }]; }, getPrompt() { return ""; }, shouldPromptAgent() { return false; }
    }; }`);
    const enabled = await owner.enableMod(room.roomId, modDir);
    expect(enabled.ok, enabled.error).toBe(true);
    await expect.poll(() => member.get(room.roomId)?.modChecksum).toBe(enabled.offer!.checksum);
    expect((await member.setModParticipation(room.roomId, true)).ok).toBe(true);
    await expect.poll(() => owner.get(room.roomId)?.members.every(m => m.modChecksum === enabled.offer!.checksum)).toBe(true);
    expect((await owner.startMod(room.roomId)).ok).toBe(true);
    const internals = (service: RoomService) => service as unknown as { rooms: Map<string, { modPublicView?: { n: number }; modSeatViews?: Record<string, unknown> }> };
    await expect.poll(() => internals(member).rooms.get(room.roomId)?.modPublicView?.n).toBe(0);
    const memberSeat = member.get(room.roomId)!.seats.find(s => s.occupantUserId === member.get(room.roomId)!.localUserId)!;
    expect((await member.modIntent(room.roomId, memberSeat.id, "inc", {})).ok).toBe(true);
    await expect.poll(() => internals(member).rooms.get(room.roomId)?.modPublicView?.n).toBe(1);
    expect(Object.keys(internals(member).rooms.get(room.roomId)!.modSeatViews!)).toEqual([memberSeat.id]);
    const kernelDir = temp();
    fs.writeFileSync(path.join(kernelDir, "manifest.json"), JSON.stringify({ id: "hosted-prefix", name: "Prefix", version: "1.0.0", hostApi: 2, inject: [], provides: [], permissions: [], hooks: ["room.chat.in"] }));
    fs.writeFileSync(path.join(kernelDir, "mod.js"), `export function activate(ctx) { ctx.hooks.on("room.chat.in", env => ({ action: "replace", value: { ...env, text: "desktop:" + env.text } })); }`);
    expect(owner.enableKernelMod(room.roomId, kernelDir).ok).toBe(true);
    await expect.poll(() => member.get(room.roomId)?.kernel?.mods[0]?.id).toBe("hosted-prefix");
    await send(member, room.roomId, "有扩展");
    await expect.poll(() => owner.get(room.roomId)?.items.some(i => i.text === "desktop:有扩展")).toBe(true);
    // No executable bundle ever reaches the headless server's data directory.
    const serverFiles = fs.readdirSync(server.data, { recursive: true }).map(String);
    expect(serverFiles.some(f => /(?:host|mod)\.js$/.test(f))).toBe(false);
    await stop(server.proc);
    await start(server.port, server.data);
    expect((await owner.rejoin(room.roomId)).ok).toBe(true);
    expect((await member.rejoin(room.roomId)).ok).toBe(true);
    await expect.poll(() => member.get(room.roomId)?.kernel?.mods[0]?.id).toBe("hosted-prefix");
    await send(member, room.roomId, "重连后的扩展");
    await expect.poll(() => member.get(room.roomId)?.items.some(i => i.text === "desktop:重连后的扩展")).toBe(true);
    owner.disposeAll();
    await expect.poll(() => member.get(room.roomId)?.members.find(m => m.role === "host")?.online).toBe(false);
    await send(member, room.roomId, "群主离线后普通聊天");
    expect(member.get(room.roomId)?.items.some(i => i.text === "群主离线后普通聊天")).toBe(true);
  }, 20000);

  it("dispatches a Mod Agent turn to its member computer and applies only its returned action", async () => {
    const server = await start(), owner = client(), dir = temp();
    const sessions = { start: vi.fn().mockResolvedValue("mod-desktop-session"), continue: vi.fn(), getTranscript: vi.fn().mockReturnValue([{ kind: "text", role: "assistant", text: '{"tool":"room_mod_act","action":"inc","payload":{}}' }]), getChangesForSelect: vi.fn().mockReturnValue([]), abort: vi.fn(), syncExtras: vi.fn() };
    const member = client(dir, false, sessions as unknown as SessionManager, dir);
    const room = await create(owner, server.url);
    expect((await join(member, owner, room.roomId)).ok).toBe(true);
    member.setFilePolicy(room.roomId, "allow");
    member.addSeat(room.roomId, "agent", "Mod Agent");
    await expect.poll(() => owner.get(room.roomId)?.seats.some(s => s.kind === "agent")).toBe(true);
    const modDir = temp();
    fs.writeFileSync(path.join(modDir, "manifest.json"), JSON.stringify({ id: "hosted-agent", name: "Agent counter", version: "1.0.0", hostApi: 1, permissions: [], seats: { min: 2, max: 4, roles: [] }, agent: true }));
    fs.writeFileSync(path.join(modDir, "host.js"), `export function createGame() { return {
      initialState() { return { n: 0 }; }, reduce(s, i) { return { n: i.name === "inc" ? s.n + 1 : s.n }; },
      getPublicView(s) { return s; }, getSeatView(s) { return s; }, getActions() { return [{ name: "inc" }]; },
      getPrompt() { return "increment once"; }, shouldPromptAgent(s) { return s.n === 0; }
    }; }`);
    expect((await owner.enableMod(room.roomId, modDir)).ok).toBe(true);
    expect((await owner.startMod(room.roomId)).ok).toBe(true);
    const state = member as unknown as { rooms: Map<string, { modPublicView?: { n: number } }> };
    await expect.poll(() => state.rooms.get(room.roomId)?.modPublicView?.n).toBe(1);
    expect(sessions.start).toHaveBeenCalledTimes(1);
    expect(sessions.start.mock.calls[0][1]).toBe(dir);
    expect(sessions.start.mock.calls[0][2]).toMatchObject({ pathJail: dir });
  }, 15000);

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
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection(server.port, "127.0.0.1");
        socket.on("error", reject);
        socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
        socket.on("data", () => socket.resetAndDestroy());
        socket.on("close", () => resolve());
      });
    }
    expect((await fetch(`${base}/healthz`)).ok).toBe(true);
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
