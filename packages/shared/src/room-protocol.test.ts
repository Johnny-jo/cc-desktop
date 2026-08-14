import { describe, expect, it } from "vitest";
import {
  decodeRoomInvite,
  encodeRoomInvite,
  looksLikeRoomInvite,
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
