import { createHmac, timingSafeEqual } from "node:crypto";

export type HandshakeType = "hello" | "challenge" | "prove" | "pending" | "ok" | "reject";

export const HandshakeReject = {
  password: "password",
  fingerprint: "fingerprint",
  denied: "denied",
  timeout: "timeout",
  blacklist: "blacklist",
} as const;
export type HandshakeReject = (typeof HandshakeReject)[keyof typeof HandshakeReject];

export type HandshakePayloads = {
  hello: { pub: string; fp: string; name: string; userId?: string };
  challenge: { pub: string; fp: string; nonce: string; encrypt: boolean };
  prove: { proof: string };
  pending: { fp: string };
  ok: { kid: string; encrypt: boolean };
  reject: { reason: HandshakeReject };
};

export type Handshake<T extends HandshakeType = HandshakeType> = {
  kind: "hs";
  v: 1;
  type: T;
  payload: HandshakePayloads[T];
};

export function makeHandshake<T extends HandshakeType>(
  type: T,
  payload: HandshakePayloads[T],
): Handshake<T> {
  return { kind: "hs", v: 1, type, payload };
}

export function parseHandshake(raw: string): Handshake | null {
  try {
    const obj = JSON.parse(raw) as Partial<Handshake> | null;
    if (!obj || typeof obj !== "object") return null;
    if (obj.kind !== "hs" || obj.v !== 1) return null;
    if (typeof obj.type !== "string") return null;
    return obj as Handshake;
  } catch {
    return null;
  }
}

export function provePassword(opts: {
  password: string;
  nonce: Buffer;
  hostFp: string;
  guestFp: string;
  ecdhSs: Buffer;
}): string {
  const input = Buffer.concat([
    opts.nonce,
    Buffer.from(opts.hostFp, "utf8"),
    Buffer.from(opts.guestFp, "utf8"),
    opts.ecdhSs,
  ]);
  return createHmac("sha256", opts.password ?? "").update(input).digest("base64url");
}

export function verifyPassword(opts: {
  password: string;
  nonce: Buffer;
  hostFp: string;
  guestFp: string;
  ecdhSs: Buffer;
  proof: string;
}): boolean {
  const expected = Buffer.from(provePassword(opts), "base64url");
  const actual = Buffer.from(opts.proof, "base64url");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
