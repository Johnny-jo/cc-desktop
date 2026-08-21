import { describe, expect, it } from "vitest";
import {
  fingerprintPublic,
  generateDeviceKeys,
  deriveSessionKey,
  sealEnvelope,
  openEnvelope,
  type DeviceKeys,
} from "./room-crypto";

describe("device keys", () => {
  it("generates X25519 pair and stable 64-hex fingerprint", () => {
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    expect(a.publicRaw.length).toBe(32);
    expect(fingerprintPublic(a.publicRaw)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintPublic(a.publicRaw)).toBe(fingerprintPublic(a.publicRaw));
    expect(fingerprintPublic(a.publicRaw)).not.toBe(fingerprintPublic(b.publicRaw));
  });
});

describe("session key", () => {
  it("ECDH is symmetric and HKDF is 32 bytes", () => {
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    const ab = deriveSessionKey(a, b.publicRaw);
    const ba = deriveSessionKey(b, a.publicRaw);
    expect(ab.equals(ba)).toBe(true);
    expect(ab.length).toBe(32);
  });
});

describe("envelope", () => {
  const keys = (): { a: DeviceKeys; b: DeviceKeys; key: Buffer } => {
    const a = generateDeviceKeys();
    const b = generateDeviceKeys();
    return { a, b, key: deriveSessionKey(a, b.publicRaw) };
  };

  it("round-trips a RoomFrame payload", () => {
    const { key } = keys();
    const plain = Buffer.from(JSON.stringify({ v: 1, type: "chat.user", payload: { text: "hi" } }));
    const env = sealEnvelope({ key, kid: "c1", sendSeq: 1n, fromFp: "aa", plain });
    expect(env.tv).toBe(1);
    expect(env.kid).toBe("c1");
    expect(env.mid).toBe("aa:1");
    const opened = openEnvelope({ key, env, expectKid: "c1" });
    expect(opened.plain.equals(plain)).toBe(true);
    expect(opened.sendSeq).toBe(1n);
  });

  it("rejects tampered ciphertext", () => {
    const { key } = keys();
    const env = sealEnvelope({
      key,
      kid: "c1",
      sendSeq: 2n,
      fromFp: "aa",
      plain: Buffer.from("hello"),
    });
    const ct = Buffer.from(env.c, "base64url");
    ct[0] = ct[0]! ^ 0xff;
    env.c = ct.toString("base64url");
    expect(() => openEnvelope({ key, env, expectKid: "c1" })).toThrow(/tamper|auth/i);
  });

  it("rejects nonce reuse for the same key+kid", () => {
    const { key } = keys();
    const env = sealEnvelope({
      key,
      kid: "c1",
      sendSeq: 3n,
      fromFp: "aa",
      plain: Buffer.from("x"),
    });
    const seen = new Set<string>([`${env.kid}:${env.n}`]);
    expect(() =>
      openEnvelope({ key, env, expectKid: "c1", seenNonces: seen }),
    ).toThrow(/reuse/i);
  });
});
