import { describe, expect, it } from "vitest";
import { encodeCdr1ForTest, encodeRoomInvite } from "@claude-desktop/shared";
import { joinErrorForInvite, shortFingerprint } from "./room-invite-ui";

const cdr2 = encodeRoomInvite({
  host: "192.168.1.8",
  port: 18765,
  hostFingerprint: "ab".repeat(32),
});

describe("joinErrorForInvite", () => {
  it("ignores non-invite text (plain host / empty)", () => {
    expect(joinErrorForInvite("")).toBeNull();
    expect(joinErrorForInvite("192.168.1.8")).toBeNull();
    expect(joinErrorForInvite("10.0.0.2:18765")).toBeNull();
  });

  it("accepts a valid CDR2 invite", () => {
    expect(joinErrorForInvite(cdr2)).toBeNull();
  });

  it("rejects CDR1 with the legacy-upgrade message", () => {
    const legacy = encodeCdr1ForTest({
      host: "127.0.0.1",
      port: 18765,
      password: "1234",
    });
    expect(legacy.startsWith("CDR1.")).toBe(true);
    expect(joinErrorForInvite(legacy)).toBe(
      "该邀请码由旧版本生成，安全性不足，请让房主重新生成",
    );
  });

  it("rejects a corrupt CDR2 invite with the decode error", () => {
    expect(joinErrorForInvite("CDR2.not-valid-body")).not.toBeNull();
  });
});

describe("shortFingerprint", () => {
  it("truncates long fingerprints to abcd…ef", () => {
    expect(shortFingerprint("ab".repeat(32))).toBe("abab…ab");
    expect(shortFingerprint("1234567890abcdef")).toBe("1234…ef");
  });

  it("keeps short fingerprints as-is", () => {
    expect(shortFingerprint("abcd")).toBe("abcd");
    expect(shortFingerprint("12345678")).toBe("12345678");
  });
});
