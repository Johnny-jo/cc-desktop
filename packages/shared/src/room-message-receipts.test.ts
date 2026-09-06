import { describe, expect, it } from "vitest";
import { createRoomMessageId, roomMessageTime } from "./room-message-receipts";
describe("dated room message identities", () => {
  it("creates unique dated ids without a Node dependency in the renderer", () => {
    const before = Date.now();
    const id = createRoomMessageId();
    expect(roomMessageTime(id)).toBeGreaterThanOrEqual(before);
    expect(roomMessageTime(id)).toBeLessThanOrEqual(Date.now());
    expect(createRoomMessageId()).not.toBe(id);
  });
  it.each([undefined, null, 1, {}, "", "123-bad", "0000000000000-00000000-0000-0000-0000-000000000000", "a".repeat(500)])("rejects malformed ids %j", value => {
    expect(roomMessageTime(value)).toBeNull();
  });
});
