import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeRoomInvite,
  encodeRoomInvite,
  hashModFiles,
  looksLikeRoomInvite,
  makeRoomFrame,
  parseRoomFrame,
  ROOM_PROTOCOL_VERSION,
  shortChecksum,
} from "./room-protocol";

describe("room invite secret key", () => {
  it("round-trips host/port/password", () => {
    const secret = encodeRoomInvite({
      host: "10.255.88.6",
      hosts: ["10.255.88.6", "192.168.1.8"],
      port: 18765,
      password: "1234",
      roomName: "测试",
    });
    expect(secret.startsWith("CDR1.")).toBe(true);
    expect(looksLikeRoomInvite(secret)).toBe(true);
    const inv = decodeRoomInvite(secret);
    expect(inv.host).toBe("10.255.88.6");
    expect(inv.port).toBe(18765);
    expect(inv.password).toBe("1234");
    expect(inv.hosts).toContain("192.168.1.8");
    expect(inv.roomName).toBe("测试");
  });

  it("decodes from multi-line paste", () => {
    const secret = encodeRoomInvite({
      host: "127.0.0.1",
      port: 18765,
    });
    const pasted = `房间邀请\n${secret}\n防火墙放行`;
    const inv = decodeRoomInvite(pasted);
    expect(inv.host).toBe("127.0.0.1");
    expect(inv.port).toBe(18765);
  });

  it("rejects garbage", () => {
    expect(() => decodeRoomInvite("not-a-key")).toThrow(/无效/);
  });
});

const MOD_FRAME_TYPES = [
  "mod.offer",
  "mod.fetch",
  "mod.bundle",
  "mod.intent",
  "mod.patch",
  "mod.priv",
  "mod.fail",
] as const;

describe("mod protocol frames", () => {
  it("includes new frame types in RoomFrameType via makeRoomFrame", () => {
    for (const type of MOD_FRAME_TYPES) {
      const frame = makeRoomFrame("room-1", 1, type, {});
      expect(frame.type).toBe(type);
      expect(frame.v).toBe(ROOM_PROTOCOL_VERSION);
      expect(frame.v).toBe(1);
    }
  });

  it("parseRoomFrame accepts mod frames with v: 1", () => {
    for (const type of MOD_FRAME_TYPES) {
      const parsed = parseRoomFrame(
        JSON.stringify({
          v: 1,
          roomId: "room-1",
          seq: 3,
          type,
          payload: {},
        }),
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe(type);
      expect(parsed?.v).toBe(1);
      expect(parsed?.roomId).toBe("room-1");
    }
  });
});

describe("hashModFiles", () => {
  it("is deterministic, 64-char hex, and changes if either file changes", () => {
    const manifest = '{"id":"demo"}';
    const hostJs = "export const hostApi = 1;\n";
    const a = hashModFiles(manifest, hostJs);
    const b = hashModFiles(manifest, hostJs);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(
      createHash("sha256").update(manifest, "utf8").update(hostJs, "utf8").digest("hex"),
    );
    expect(hashModFiles('{"id":"other"}', hostJs)).not.toBe(a);
    expect(hashModFiles(manifest, "export const hostApi = 2;\n")).not.toBe(a);
  });
});

describe("shortChecksum", () => {
  it("still returns a stable 8-char hex digest", () => {
    expect(shortChecksum(["force", "mods"])).toBe("7969223d");
  });
});
