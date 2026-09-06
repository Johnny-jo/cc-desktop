import { describe, expect, it } from "vitest";
import { parseRoomAttachments, ROOM_ATTACHMENT_LIMITS } from "./room-attachments";

const ref = { id: "cc53477c-f070-463f-bca1-a58d8b7631a5", name: "资料.txt", size: 3, mimeType: "text/plain", kind: "text", sha256: "a".repeat(64) };
describe("room attachment references", () => {
  it("accepts bounded metadata and copies it without local paths", () => {
    expect(parseRoomAttachments([ref])).toEqual([ref]);
    expect(parseRoomAttachments(undefined)).toEqual([]);
    expect(parseRoomAttachments([ref])![0]).not.toBe(ref);
  });
  it.each([
    { path: "C:/secret" }, { name: "../secret" }, { name: "a\\b" }, { name: "a\u0000b" },
    { id: "../escape" }, { sha256: "bad" }, { size: -1 }, { size: 1.5 },
    { size: ROOM_ATTACHMENT_LIMITS.fileBytes + 1 }, { kind: "script" }, { mimeType: "text/plain\nX" },
  ])("rejects invalid or path-bearing metadata %j", (patch) => {
    expect(parseRoomAttachments([{ ...ref, ...patch }])).toBeNull();
  });
  it("rejects duplicates, excessive counts and total bytes", () => {
    expect(parseRoomAttachments([ref, ref])).toBeNull();
    const many = Array.from({ length: 6 }, (_, n) => ({ ...ref, id: `cc53477c-f070-463f-bca1-a58d8b7631a${n}` }));
    expect(parseRoomAttachments(many)).toBeNull();
    expect(parseRoomAttachments(many.slice(0, 3).map(r => ({ ...r, size: ROOM_ATTACHMENT_LIMITS.fileBytes })))).toBeNull();
  });
});
