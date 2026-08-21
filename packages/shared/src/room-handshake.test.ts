import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveSessionKey, generateDeviceKeys, fingerprintPublic } from "./room-crypto";
import {
  makeHandshake,
  parseHandshake,
  provePassword,
  verifyPassword,
  HandshakeReject,
} from "./room-handshake";

describe("handshake codec", () => {
  it("round-trips hello", () => {
    const raw = JSON.stringify(
      makeHandshake("hello", { pub: "abc", fp: "ff", name: "bob" }),
    );
    const hs = parseHandshake(raw);
    expect(hs?.type).toBe("hello");
    expect(hs?.payload).toEqual({ pub: "abc", fp: "ff", name: "bob" });
  });

  it("rejects RoomFrame as handshake", () => {
    expect(parseHandshake(JSON.stringify({ v: 1, type: "join", roomId: "r", seq: 1 }))).toBeNull();
  });
});

describe("password proof", () => {
  it("host accepts matching password bound to this ECDH", () => {
    const host = generateDeviceKeys();
    const guest = generateDeviceKeys();
    const ss = deriveSessionKey(guest, host.publicRaw);
    const nonce = Buffer.alloc(32, 7);
    const proof = provePassword({
      password: "secret",
      nonce,
      hostFp: fingerprintPublic(host.publicRaw),
      guestFp: fingerprintPublic(guest.publicRaw),
      ecdhSs: ss,
    });
    expect(
      verifyPassword({
        password: "secret",
        nonce,
        hostFp: fingerprintPublic(host.publicRaw),
        guestFp: fingerprintPublic(guest.publicRaw),
        ecdhSs: deriveSessionKey(host, guest.publicRaw),
        proof,
      }),
    ).toBe(true);
  });

  it("wrong password fails without throwing extra info", () => {
    const host = generateDeviceKeys();
    const guest = generateDeviceKeys();
    const ss = deriveSessionKey(guest, host.publicRaw);
    const nonce = Buffer.alloc(32, 1);
    const proof = provePassword({
      password: "right",
      nonce,
      hostFp: fingerprintPublic(host.publicRaw),
      guestFp: fingerprintPublic(guest.publicRaw),
      ecdhSs: ss,
    });
    expect(
      verifyPassword({
        password: "wrong",
        nonce,
        hostFp: fingerprintPublic(host.publicRaw),
        guestFp: fingerprintPublic(guest.publicRaw),
        ecdhSs: deriveSessionKey(host, guest.publicRaw),
        proof,
      }),
    ).toBe(false);
  });

  it("proof from another ECDH is rejected", () => {
    const host = generateDeviceKeys();
    const guest = generateDeviceKeys();
    const other = generateDeviceKeys();
    const nonce = Buffer.alloc(32, 2);
    const proof = provePassword({
      password: "secret",
      nonce,
      hostFp: fingerprintPublic(host.publicRaw),
      guestFp: fingerprintPublic(guest.publicRaw),
      ecdhSs: deriveSessionKey(guest, other.publicRaw),
    });
    expect(
      verifyPassword({
        password: "secret",
        nonce,
        hostFp: fingerprintPublic(host.publicRaw),
        guestFp: fingerprintPublic(guest.publicRaw),
        ecdhSs: deriveSessionKey(host, guest.publicRaw),
        proof,
      }),
    ).toBe(false);
  });
});

describe("reject reasons", () => {
  it("enumerates distinguishable reasons", () => {
    expect(HandshakeReject.password).toBe("password");
    expect(HandshakeReject.fingerprint).toBe("fingerprint");
    expect(HandshakeReject.denied).toBe("denied");
    expect(HandshakeReject.timeout).toBe("timeout");
    expect(HandshakeReject.blacklist).toBe("blacklist");
  });
});
