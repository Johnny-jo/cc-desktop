import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashModFiles } from "./mod-hash";
import {
  decodeRoomInvite,
  encodeCdr1ForTest,
  encodeRoomInvite,
  looksLikeRoomInvite,
  makeRoomFrame,
  parseRoomFrame,
  ROOM_PROTOCOL_VERSION,
  MOD_HOST_API,
  MOD_KERNEL_API,
  shortChecksum,
} from "./room-protocol";

describe("room invite secret key", () => {
  it("round-trips CDR2 without password", () => {
    const secret = encodeRoomInvite({
      host: "10.255.88.6",
      hosts: ["10.255.88.6", "192.168.1.8"],
      port: 18765,
      wss: ["wss://room.example.com"],
      hostFingerprint: "ab".repeat(32),
      roomName: "测试",
      modChecksum: "deadbeef",
    });
    expect(secret.startsWith("CDR2.")).toBe(true);
    const inv = decodeRoomInvite(secret);
    expect(inv.host).toBe("10.255.88.6");
    expect(inv.wss).toEqual(["wss://room.example.com"]);
    expect(inv.hostFingerprint).toBe("ab".repeat(32));
    expect(secret.includes("1234")).toBe(false);
    expect(JSON.stringify(inv).includes("password")).toBe(false);
  });

  it("refuses CDR1 as join credential", () => {
    const legacy = encodeCdr1ForTest({
      host: "127.0.0.1",
      port: 18765,
      password: "1234",
    });
    expect(legacy.startsWith("CDR1.")).toBe(true);
    expect(() => decodeRoomInvite(legacy)).toThrow(/旧版本/);
  });

  it("decodes from multi-line paste", () => {
    const secret = encodeRoomInvite({
      host: "127.0.0.1",
      port: 18765,
      hostFingerprint: "cd".repeat(32),
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

describe("mod api versions", () => {
  it("keeps play hostApi at 1 and kernel at 2", () => {
    expect(MOD_HOST_API).toBe(1);
    expect(MOD_KERNEL_API).toBe(2);
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

const BORROW_AI_FRAME_TYPES = [
  "seat.update",
  "member.role",
  "member.kick",
  "ai.share",
  "ai.ask",
  "ai.models",
  "ai.http",
  "file.policy",
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

describe("borrow-ai protocol frames", () => {
  it("round-trips new frame types", () => {
    for (const type of BORROW_AI_FRAME_TYPES) {
      const frame = makeRoomFrame("room-1", 1, type, {});
      expect(frame.type).toBe(type);
      const parsed = parseRoomFrame(JSON.stringify(frame));
      expect(parsed?.type).toBe(type);
    }
  });
});

describe("room live patches", () => {
  it("round-trips state.live without a full snapshot", () => {
    const payload = {
      liveExec: [
        {
          turnId: "turn-1",
          seatId: "seat-1",
          text: "working",
          at: 1,
        },
      ],
    };
    const parsed = parseRoomFrame(
      JSON.stringify(makeRoomFrame("room-1", 2, "state.live", payload)),
    );
    expect(parsed?.type).toBe("state.live");
    expect(parsed?.payload).toEqual(payload);
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
