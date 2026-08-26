import {
  createCipheriv,
  createDecipheriv,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";

export const ROOM_TRANSPORT_VERSION = 1 as const;
/**
 * Electron's Node crypto is BoringSSL, which does not register
 * ChaCha20-Poly1305 as an EVP_CIPHER (`createCipheriv` throws "Unknown cipher").
 * AES-256-GCM is in both OpenSSL (vitest/Node) and BoringSSL (Electron 34).
 * Spec allows either; nonce 12 / tag 16 / key 32 stay the same.
 */
export const ROOM_AEAD_ALG = "aes-256-gcm" as const;
const HKDF_INFO = Buffer.from("cc-desktop-room-s1");
const NONCE_LEN = 12;
const TAG_LEN = 16;

export type DeviceKeys = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicRaw: Buffer;
};

export type AeadEnvelope = {
  tv: typeof ROOM_TRANSPORT_VERSION;
  kid: string;
  n: string;
  c: string;
  mid: string;
};

export function generateDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { privateKey, publicKey, publicRaw: rawPublic(publicKey) };
}

export function importDeviceKeys(pkcs8: Buffer, publicRaw: Buffer): DeviceKeys {
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = publicFromRaw(publicRaw);
  return { privateKey, publicKey, publicRaw };
}

export function exportPrivatePkcs8(keys: DeviceKeys): Buffer {
  return keys.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
}

export function fingerprintPublic(publicRaw: Buffer): string {
  return createHash("sha256").update(publicRaw).digest("hex");
}

export function deriveSessionKey(self: DeviceKeys, peerPublicRaw: Buffer): Buffer {
  const ss = diffieHellman({
    privateKey: self.privateKey,
    publicKey: publicFromRaw(peerPublicRaw),
  });
  return Buffer.from(hkdfSync("sha256", ss, Buffer.alloc(0), HKDF_INFO, 32));
}

export function sealEnvelope(opts: {
  key: Buffer;
  kid: string;
  sendSeq: bigint;
  fromFp: string;
  plain: Buffer;
}): AeadEnvelope {
  const nonce = Buffer.alloc(NONCE_LEN);
  nonce.writeBigUInt64BE(opts.sendSeq, 4);
  const ad = aad(opts.kid, opts.fromFp, opts.sendSeq);
  const cipher = createCipheriv(ROOM_AEAD_ALG, opts.key, nonce, {
    authTagLength: TAG_LEN,
  });
  cipher.setAAD(ad, { plaintextLength: opts.plain.length });
  const ct = Buffer.concat([cipher.update(opts.plain), cipher.final(), cipher.getAuthTag()]);
  return {
    tv: ROOM_TRANSPORT_VERSION,
    kid: opts.kid,
    n: nonce.toString("base64url"),
    c: ct.toString("base64url"),
    mid: `${opts.fromFp}:${opts.sendSeq.toString()}`,
  };
}

export function openEnvelope(opts: {
  key: Buffer;
  env: AeadEnvelope;
  expectKid: string;
  seenNonces?: Set<string>;
}): { plain: Buffer; sendSeq: bigint; fromFp: string } {
  if (opts.env.tv !== ROOM_TRANSPORT_VERSION) throw new Error("unsupported transport version");
  if (opts.env.kid !== opts.expectKid) throw new Error("kid mismatch");
  const nonceKey = `${opts.env.kid}:${opts.env.n}`;
  if (opts.seenNonces?.has(nonceKey)) throw new Error("nonce reuse");
  const nonce = Buffer.from(opts.env.n, "base64url");
  if (nonce.length !== NONCE_LEN) throw new Error("bad nonce");
  const sendSeq = nonce.readBigUInt64BE(4);
  const colon = opts.env.mid.indexOf(":");
  if (colon <= 0) throw new Error("bad mid");
  const fromFp = opts.env.mid.slice(0, colon);
  const ad = aad(opts.env.kid, fromFp, sendSeq);
  const blob = Buffer.from(opts.env.c, "base64url");
  if (blob.length < TAG_LEN) throw new Error("short ciphertext");
  const tag = blob.subarray(blob.length - TAG_LEN);
  const data = blob.subarray(0, blob.length - TAG_LEN);
  const decipher = createDecipheriv(ROOM_AEAD_ALG, opts.key, nonce, {
    authTagLength: TAG_LEN,
  });
  decipher.setAAD(ad, { plaintextLength: data.length });
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    opts.seenNonces?.add(nonceKey);
    return { plain, sendSeq, fromFp };
  } catch {
    throw new Error("auth/tamper");
  }
}

function aad(kid: string, fromFp: string, sendSeq: bigint): Buffer {
  return Buffer.from(`${ROOM_TRANSPORT_VERSION}|${kid}|${fromFp}|${sendSeq}`);
}

function rawPublic(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("missing x");
  return Buffer.from(jwk.x, "base64url");
}

function publicFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error("bad public key");
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") },
    format: "jwk",
  });
}
