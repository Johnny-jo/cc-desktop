import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomSnapshot } from "@claude-desktop/shared";
import { performRoomAttachmentAction } from "./room-attachment-actions";

const dirs: string[] = [];
function setup(name = "image.png", mimeType = "image/png") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-file-actions-")); dirs.push(dir);
  const source = path.join(dir, "cache.bin");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(source, bytes);
  const ref = { id: randomUUID(), name, mimeType, kind: "image" as const, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const item = { id: "item", recalled: false, attachments: [ref] };
  const rooms = { get: () => ({ items: [item] }) as RoomSnapshot, getAttachment: vi.fn(async () => ({ ok: true, attachment: { ...ref, path: source } })) };
  const choosePath = vi.fn(async () => path.join(dir, "saved.png"));
  const args = { roomId: "r", itemId: "item", attachmentId: ref.id, action: "preview" as const };
  return { dir, source, bytes, ref, item, rooms, choosePath, args };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe("room attachment native actions", () => {
  it("previews verified pixels without returning a local file path", async () => {
    const s = setup();
    expect(await performRoomAttachmentAction(s.rooms, s.args, s.choosePath)).toEqual({ ok: true, dataUrl: `data:image/png;base64,${s.bytes.toString("base64")}` });
    expect(s.choosePath).not.toHaveBeenCalled();
  });
  it("saves actual bytes only to the path explicitly chosen by the user", async () => {
    const s = setup();
    expect(await performRoomAttachmentAction(s.rooms, { ...s.args, action: "save" }, s.choosePath)).toEqual({ ok: true, saved: true });
    expect(fs.readFileSync(path.join(s.dir, "saved.png"))).toEqual(s.bytes);
  });
  it("does not fetch or save when the native dialog is cancelled", async () => {
    const s = setup();
    expect(await performRoomAttachmentAction(s.rooms, { ...s.args, action: "save" }, async () => undefined)).toEqual({ ok: true, cancelled: true });
    expect(s.rooms.getAttachment).not.toHaveBeenCalled();
  });
  it("refuses active documents and large images before downloading", async () => {
    const s = setup("x.svg", "image/svg+xml");
    expect((await performRoomAttachmentAction(s.rooms, s.args, s.choosePath)).ok).toBe(false);
    s.ref.mimeType = "image/png"; s.ref.size = 6 * 1024 * 1024;
    expect((await performRoomAttachmentAction(s.rooms, s.args, s.choosePath)).ok).toBe(false);
    expect(s.rooms.getAttachment).not.toHaveBeenCalled();
  });
  it("rechecks recall after a native save dialog", async () => {
    const s = setup();
    const result = await performRoomAttachmentAction(s.rooms, { ...s.args, action: "save" }, async () => { s.item.recalled = true; return path.join(s.dir, "blocked.png"); });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(s.dir, "blocked.png"))).toBe(false);
  });
  it("refuses local corruption instead of previewing or overwriting a destination", async () => {
    const s = setup();
    fs.writeFileSync(s.source, "tampered");
    expect((await performRoomAttachmentAction(s.rooms, s.args, s.choosePath)).ok).toBe(false);
    expect((await performRoomAttachmentAction(s.rooms, { ...s.args, action: "save" }, s.choosePath)).ok).toBe(false);
    expect(fs.existsSync(path.join(s.dir, "saved.png"))).toBe(false);
  });
});
