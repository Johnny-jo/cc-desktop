# 房间传输 S1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有 `RoomFrame` 之下垫应用层 AEAD 信道与设备身份；邀请码改为 `CDR2.`（密码不进码）；局域网 / 公网 WSS / Cloudflare Tunnel 三选一可达；中间方只见密文。

**架构：** 房主仍是权威端点，客人只连房主。传输是哑管道。握手 PDU（`kind: "hs"`）与 AEAD 信封（`tv: 1`）垫在 `RoomFrame` 下面；应用帧类型与语义不动。跳过加密仅允许局域网，且写入快照对全体可见。

**技术栈：** TypeScript · Node `crypto`（X25519 + ChaCha20-Poly1305 + HKDF + HMAC-SHA256）· `ws` · Electron main · Vitest。不新增密码学 npm 依赖。

**规格：** `docs/superpowers/specs/2026-08-20-room-comms-design.md`（三轮审议合并稿）。冲突以《通信架构补充条款》为准。

**实现根目录：** 仓库根。未经用户明确同意，不在 `main` 上实现——先建分支。

**全局钉死（规格留给实现的 6 项）：**

| 项 | S1 选择 | 理由 |
|---|---|---|
| AEAD | ChaCha20-Poly1305，tag 16 字节，nonce 12 字节 | Node 内置；无 AES-NI 也稳；信封 `tv: 1` 可以后加 AES |
| 握手 | X25519 ECDH + HMAC-SHA256 挑战-响应（绑定 ECDH 共享秘密） | 规格「最低可接受降级」；CPace 无稳妥零依赖实现，列入「本计划不做」 |
| 最近 N 条 | 沿用房主 `items` 上限 400，重连发全量快照 | 规格允许 S1 全量；不另造邮箱 |
| 帧大小 | 见任务 5 常量表 | 按类型分，不是一刀切 |
| cloudflared | 优先 quick tunnel（stdout 解析 `trycloudflare.com`）；named token 只进 `userData` | 账号不进邀请码、不进仓库、不进渲染进程 |
| 密码算法 | HMAC 绑定 `nonce \|\| hostFp \|\| guestFp \|\| ecdhSs` | 被动窃听者拿不到 `ecdhSs`，无法离线爆密码 |

**本计划不做：** WebRTC / ICE / TURN / STUN；CPace / OPAQUE / X3DH / MLS；Dead Drop；快照差量与扇出写合并（S2）；房主崩溃后续摊；跨 Path 半包续传；把 `cloudflared` 二进制提交进 git。

---

## 文件结构

```
packages/shared/src/
  room-protocol.ts              # CDR2 编解码；RoomSnapshot.encrypt；路径/指纹字段；大小上限常量
  room-protocol.test.ts
  room-crypto.ts                # 新建：设备钥、指纹、HKDF、信封 seal/open
  room-crypto.test.ts           # 新建
  room-handshake.ts             # 新建：HMAC 证明、握手 PDU、拒绝原因
  room-handshake.test.ts        # 新建
  room-pdu.ts                   # 新建：parsePdu 判别 hs / env / frame / ack
  room-pdu.test.ts              # 新建
  index.ts                      # 导出新模块
  ipc.ts                        # 新 IPC：审批 / 踢人 / 指标 / 建房选项

apps/desktop/electron/main/
  room-device-store.ts          # 新建：userData/room-device.json 持久化设备钥
  room-device-store.test.ts     # 新建
  room-connection.ts            # 新建：包装 ws；加密收发；msg_id 去重；累积 ACK
  room-connection.test.ts       # 新建
  room-limits.ts                # 新建：令牌桶、握手超时、半开清理
  room-limits.test.ts           # 新建
  room-metrics.ts               # 新建：T0/T1/T2 计数
  room-metrics.test.ts          # 新建
  room-tunnel.ts                # 新建：spawn cloudflared，解析公网 URL
  room-tunnel.test.ts           # 新建
  room-service.ts               # 接入握手/信封/审批/踢人/选路；invite 改 CDR2
  room-transport.test.ts        # 新建：host↔guest 加密集成
  room-mod.test.ts              # createHost 显式 encrypt:false，避免明文测例全红
  ipc-handlers.ts
  runtime-paths.ts              # cloudflared 解析路径

apps/desktop/electron/preload/index.ts
apps/desktop/src/
  state/room-store.ts
  components/RoomSidebar.tsx    # 创建：加密开关 / 公网；加入：CDR2 + 独立密码；CDR1 拒绝
  components/RoomInviteModal.tsx
  components/RoomPendingBanner.tsx  # 新建：待审批 / 指纹变化
  i18n/zh.ts
  i18n/en.ts
```

职责边界：密码学与 PDU 解析全部在 `packages/shared`（可单测、不碰 Electron）。`RoomService` 只编排。`room-connection` 是「一条客人↔房主 Connection」的发送面，不处理玩法/kernel。

---

### 任务 1：AEAD 信封（ChaCha20-Poly1305）

**文件：**
- 创建：`packages/shared/src/room-crypto.ts`
- 创建：`packages/shared/src/room-crypto.test.ts`
- 修改：`packages/shared/src/index.ts`（`export * from "./room-crypto"`）

- [ ] **步骤 1：编写失败的测试**

创建 `packages/shared/src/room-crypto.test.ts`：

```ts
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```
pnpm --filter @claude-desktop/shared test -- room-crypto.test.ts
```

预期：FAIL，报错 `Cannot find module './room-crypto'`。

- [ ] **步骤 3：编写最少实现代码**

`packages/shared/src/room-crypto.ts`：

```ts
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
  const cipher = createCipheriv("chacha20-poly1305", opts.key, nonce, {
    authTagLength: TAG_LEN,
  });
  cipher.setAAD(ad);
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
  const decipher = createDecipheriv("chacha20-poly1305", opts.key, nonce, {
    authTagLength: TAG_LEN,
  });
  decipher.setAAD(ad);
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
```

Nonce 布局：前 4 字节为 0，后 8 字节为大端 `sendSeq`。同一 `kid` 上 `sendSeq` 单调递增，等价于 nonce 不重复。不要用随机 nonce。

- [ ] **步骤 4：运行测试验证通过**

```
pnpm --filter @claude-desktop/shared test -- room-crypto.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```
git add packages/shared/src/room-crypto.ts packages/shared/src/room-crypto.test.ts packages/shared/src/index.ts
git commit -m "feat: room AEAD envelope with X25519 and ChaCha20-Poly1305"
```

---

### 任务 2：握手 PDU 与 HMAC 证明

**文件：**
- 创建：`packages/shared/src/room-handshake.ts`
- 创建：`packages/shared/src/room-handshake.test.ts`
- 创建：`packages/shared/src/room-pdu.ts`
- 创建：`packages/shared/src/room-pdu.test.ts`
- 修改：`packages/shared/src/index.ts`

握手不进 `RoomFrameType`。三种线上 JSON：

| 判别 | 形状 |
|---|---|
| 握手 | `{ kind: "hs", v: 1, type, payload }` |
| 信封 | `{ tv: 1, kid, n, c, mid }` |
| 明文帧（仅 skip-encrypt） | `{ v: 1, roomId, seq, type, payload }`（现有） |
| ACK | `{ kind: "ack", tv: 1, kid, upto }` |

HMAC：`HMAC-SHA256(utf8(password), nonce || hostFp || guestFp || ecdhSs)`。空密码视为空字符串（无密码房只靠设备指纹 + 审批）。

- [ ] **步骤 1：编写失败的测试**

`packages/shared/src/room-handshake.test.ts`：

```ts
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
```

`packages/shared/src/room-pdu.test.ts`：把同一段 JSON 分别判为 `hs` / `env` / `frame` / `ack` / `null`。`parsePdu('{"kind":"hs","v":1,"type":"hello","payload":{}}')` → `{ kind: "hs", ... }`；`parsePdu` 对损坏 JSON 返回 `null`。

- [ ] **步骤 2：运行测试验证失败**

```
pnpm --filter @claude-desktop/shared test -- room-handshake.test.ts room-pdu.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：编写最少实现代码**

`provePassword` / `verifyPassword` 必须用 `createHmac("sha256", password)`，比较用 `timingSafeEqual`。`proof` 为 32 字节的 base64url。

`makeHandshake(type, payload)` 返回 `{ kind: "hs", v: 1, type, payload }`。

`HandshakeType = "hello" | "challenge" | "prove" | "pending" | "ok" | "reject"`。

`hello` payload：`{ pub: base64url, fp: hex, name: string }`。

`challenge` payload：`{ pub, fp, nonce: base64url, encrypt: boolean }`。

`prove` payload：`{ proof: base64url }`。

`reject` payload：`{ reason: HandshakeReject }`。

`ok` payload：`{ kid: string, encrypt: boolean }`。

`pending` payload：`{ fp: string }`。不带成员列表。

`parsePdu`：先 `JSON.parse`；若 `kind === "hs"` 且 `v === 1` → hs；若 `kind === "ack"` → ack；若 `tv === 1` 且有 `c`/`n`/`kid` → env；若 `v === 1` 且有 `type`/`roomId` → frame；否则 null。

- [ ] **步骤 4：运行测试验证通过**

```
pnpm --filter @claude-desktop/shared test -- room-handshake.test.ts room-pdu.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```
git add packages/shared/src/room-handshake.ts packages/shared/src/room-handshake.test.ts packages/shared/src/room-pdu.ts packages/shared/src/room-pdu.test.ts packages/shared/src/index.ts
git commit -m "feat: room handshake HMAC proof and PDU discriminator"
```

---

### 任务 3：`CDR2.` 邀请码（密码不得入码）

**文件：**
- 修改：`packages/shared/src/room-protocol.ts`
- 修改：`packages/shared/src/room-protocol.test.ts`

钉死 CDR2 body：

```ts
{
  v: 2,
  h: string,          // 首选 LAN host
  hs: string[],       // 其余 LAN
  p: number,          // LAN 端口
  u?: string[],       // wss:// 列表（T1/T2）
  f: string,          // 房主设备指纹 64-hex
  n?: string,         // 房间名
  m?: string,         // modChecksum
}
```

前缀 `CDR2.`。仍用现有 XOR+base64url 做混淆（不是加密；机密性靠 AEAD）。`w`（密码）字段禁止写入。

`RoomInvitePayload` 改为：

```ts
export type RoomInvitePayload = {
  host: string;
  hosts?: string[];
  port: number;
  wss?: string[];
  hostFingerprint: string;
  modChecksum?: string;
  roomName?: string;
};

export type LegacyRoomInvite = RoomInvitePayload & { password?: string; legacy: true };
```

行为：

- `encodeRoomInvite` **只**产出 `CDR2.`，没有 `password` 参数。缺 `hostFingerprint` 抛错。
- `decodeRoomInvite`：`CDR2.` → `RoomInvitePayload`；`CDR1.` → 抛 `旧版本生成，安全性不足，请让房主重新生成`（**不要**返回可用来建连的 payload）。
- 新增 `decodeLegacyRoomInviteForHint`：仅测试与诊断用，UI 不得拿它去 `join`。
- `looksLikeRoomInvite`：`CDR1.` 或 `CDR2.` 都为 true（UI 才能识别旧码并提示）。

- [ ] **步骤 1：编写失败的测试**

在 `room-protocol.test.ts` 的 invite describe 里**替换**「round-trips host/port/password」：

```ts
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
```

把现有 XOR 编码器留作 `encodeCdr1ForTest`（`/** @internal test only */`），从 `room-protocol.ts` 导出，仅测试调用。生产路径禁止调用。把现有 `expect(secret.startsWith("CDR1."))` 全部改成 CDR2。`decode from multi-line paste` 改为编 CDR2、解 CDR2。

- [ ] **步骤 2：运行测试验证失败**

```
pnpm --filter @claude-desktop/shared test -- room-protocol.test.ts
```

预期：FAIL（仍编出 `CDR1.` 或类型缺字段）。

- [ ] **步骤 3：实现 CDR2**

`INVITE_PREFIX` 改为 `CDR2.`。旧前缀 `CDR1.` 单独常量 `LEGACY_INVITE_PREFIX`。`looksLikeRoomInvite` 两个前缀都认。`encodeRoomInvite` body 用 `v: 2`，字段 `f` 必填，禁止 `w`。

`decodeRoomInvite`：若前缀是 `CDR1.`，直接 `throw new Error("该邀请码由旧版本生成，安全性不足，请让房主重新生成")`。

- [ ] **步骤 4：运行测试验证通过**

```
pnpm --filter @claude-desktop/shared test -- room-protocol.test.ts
```

预期：PASS。全 shared 测试也要绿：`pnpm --filter @claude-desktop/shared test`。

- [ ] **步骤 5：Commit**

```
git add packages/shared/src/room-protocol.ts packages/shared/src/room-protocol.test.ts
git commit -m "feat: CDR2 invite without password; refuse CDR1 as credential"
```

---

### 任务 4：设备钥落盘

**文件：**
- 创建：`apps/desktop/electron/main/room-device-store.ts`
- 创建：`apps/desktop/electron/main/room-device-store.test.ts`

路径：`path.join(userDataDir, "room-device.json")`。

形状：`{ v: 1, pkcs8: base64, pub: base64 }`。首次调用 `loadOrCreateDeviceKeys(userDataDir)` 生成并写盘；之后稳定返回同一指纹。私钥永不通过 IPC。

- [ ] **步骤 1：编写失败的测试**

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { fingerprintPublic } from "@claude-desktop/shared";
import { loadOrCreateDeviceKeys } from "./room-device-store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("room-device-store", () => {
  it("persists and reloads the same fingerprint", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-"));
    dirs.push(dir);
    const a = loadOrCreateDeviceKeys(dir);
    const b = loadOrCreateDeviceKeys(dir);
    expect(fingerprintPublic(a.publicRaw)).toBe(fingerprintPublic(b.publicRaw));
    const raw = fs.readFileSync(path.join(dir, "room-device.json"), "utf8");
    expect(raw).not.toMatch(/BEGIN/);
  });
});
```

- [ ] **步骤 2：运行失败**

```
pnpm --filter @claude-desktop/desktop exec vitest run electron/main/room-device-store.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现** `loadOrCreateDeviceKeys`：读文件 → `importDeviceKeys`；缺文件 → `generateDeviceKeys` + 写 JSON。损坏文件则重新生成并覆盖。

- [ ] **步骤 4：测试通过后 commit**

```
git add apps/desktop/electron/main/room-device-store.ts apps/desktop/electron/main/room-device-store.test.ts
git commit -m "feat: persist room device X25519 key in userData"
```

---

### 任务 5：帧大小上限与每连接令牌桶

**文件：**
- 创建：`apps/desktop/electron/main/room-limits.ts`
- 创建：`apps/desktop/electron/main/room-limits.test.ts`
- 修改：`packages/shared/src/room-protocol.ts` 导出常量（shared 无状态，limits 类放 main）

常量（写进 `room-protocol.ts`）：

```ts
export const ROOM_HANDSHAKE_TIMEOUT_MS = 10_000;
export const ROOM_FRAME_LIMITS = {
  handshake: 8 * 1024,
  "chat.user": 64 * 1024,
  "chat.event": 64 * 1024,
  "state.snapshot": 2 * 1024 * 1024,
  "mod.bundle": MOD_BUNDLE_MAX_BYTES,
  envelope: 2 * 1024 * 1024 + 256,
  default: 256 * 1024,
} as const;
```

令牌桶：`TokenBucket({ rate: 30, burst: 60 })`，`take()` 返回 boolean。半开连接：`HandshakeWatchdog(timeoutMs)`，超时回调。重连桶：`rate: 3 / 30s` per fingerprint。

- [ ] **步骤 1：测试**

```ts
it("allows burst then denies", () => {
  const b = new TokenBucket({ ratePerSec: 30, burst: 3, now: () => t });
  expect(b.take()).toBe(true);
  expect(b.take()).toBe(true);
  expect(b.take()).toBe(true);
  expect(b.take()).toBe(false);
});

it("frameLimit uses type table and default", () => {
  expect(frameLimit("chat.user")).toBe(64 * 1024);
  expect(frameLimit("seat.claim")).toBe(256 * 1024);
  expect(frameLimit("handshake")).toBe(8 * 1024);
});
```

超限帧在接入 `RoomService` 之前就被丢掉并计一次桶（任务 7 接线）。本任务只交纯函数。

- [ ] **步骤 2–5：** 红 → 实现 → 绿 → commit `feat: room frame size limits and token bucket`

---

### 任务 6：Connection 包装（加密收发 + 去重 + ACK）

**文件：**
- 创建：`apps/desktop/electron/main/room-connection.ts`
- 创建：`apps/desktop/electron/main/room-connection.test.ts`

`RoomConnection` 职责：一条已握手 Connection。持有 `kid`、`sessionKey`、`sendSeq`、对端指纹、`seenNonces`、对端水位 `peerUpto`。

```ts
export class RoomConnection {
  constructor(opts: {
    ws: WebSocket;
    kid: string;
    key: Buffer;
    selfFp: string;
    peerFp: string;
    encrypt: boolean;
  });
  sendFrame(frame: RoomFrame): void;
  onFrame(handler: (frame: RoomFrame) => void): void;
  close(): void;
  get peerFp(): string;
  get kid(): string;
}
```

`encrypt: false` 时 `sendFrame` 直接 `JSON.stringify(frame)`（现有路径）。`encrypt: true` 时 `sealEnvelope` 后发送。收包走 `parsePdu`：env → open → `parseRoomFrame`；ack 更新水位；重复 `mid` 丢弃；明文 frame 仅当 `encrypt === false`。

ACK：每收到 8 个应用帧或距上次 ACK > 500ms，发 `{ kind: "ack", tv: 1, kid, upto: lastSeq }`。S1 不在同条 TCP 上做超时重传（WS 已可靠）；未 ACK 缓冲留给将来换 Path。本任务测试去重：同一 `mid` 第二次 `onFrame` 不触发。

用 `ws` 的一对 `WebSocketServer` + `WebSocket` 在 127.0.0.1 随机端口上测 round-trip（可抄 `room-mod.test.ts` 的 `waitOpen`）。

- [ ] **步骤 1–5：** 红 → 实现 → 绿 → commit `feat: room connection AEAD send path with msg_id dedupe`

---

### 任务 7：接入 RoomService（默认加密 + 握手后才 join）

**文件：**
- 修改：`apps/desktop/electron/main/room-service.ts`
- 修改：`apps/desktop/electron/main/room-mod.test.ts`（`createHost` 传 `encrypt: false`）
- 创建：`apps/desktop/electron/main/room-transport.test.ts`
- 修改：`packages/shared/src/room-protocol.ts` 的 `RoomSnapshot`：加 `encrypt: boolean`、`hostFingerprint?: string`
- 修改：`packages/shared/src/ipc.ts` 的 `roomCreate` opts：`encrypt?: boolean`（默认 true）

状态机（房主 `onGuest`）：

1. TCP 开 → 启动 10s 握手超时；**不**入 `r.guests`、**不**分配席位。
2. 仅接受 `hs` / 明文 `hello`（peek 仍允许，只回 `mod.offer`，与今日一致）。
3. `hs.hello` → 黑名单则 `hs.reject { reason: "blacklist" }` 并断开。
4. 发 `hs.challenge { pub, fp, nonce, encrypt }`。
5. `hs.prove` → 验 HMAC。失败：`hs.reject { reason: "password" }`，关连接。成功且新指纹：若 `autoApprove` 则记指纹并发 `hs.ok`；否则 `hs.pending`，等房主审批（任务 8；本任务若 `autoApprove` 未开，测试里创建时 `autoApprove: true`）。
6. `hs.ok { kid, encrypt }` 之后才允许加密的 `join`。`join` payload **不再带 password**。
7. `sendRaw` / `reply` / `broadcast` / `sendClient` 全部改走 `RoomConnection.sendFrame`。找不到 connection 的 ws（peek）仍可明文回 `mod.offer`。

`create` 选项：

```ts
encrypt?: boolean; // default true
autoApprove?: boolean;
```

若 `encrypt === false`，快照 `encrypt: false`。公网 URL 或 tunnel 已开时，忽略 `encrypt: false` 并强制 true（任务 10/11 再加断言；本任务若 `wss` 非空则强制）。

`invite()`：改 `encodeRoomInvite` 为 CDR2，带 `hostFingerprint`，**不要**把 `password` 放进 secret。返回值仍可含 `password` 给房主自己看，但 `secret` 里没有。

`join()`：

- 入口参数增 `wss?: string[]`、`hostFingerprint?: string`（来自 CDR2）。指纹缺省 = TOFU 首次见谁信谁，之后变化走任务 8。
- 先握手再发加密 join。
- 密码只用于 `provePassword`，不进 `join` 帧。

`fetchMod` / `peek`：

- `hello` → `mod.offer` 仍允许未认证（校验和本就在邀请码里）。
- `mod.fetch` **必须**在 `hs.ok` 之后（skip-encrypt 房除外）。`fetchMod` 自己走一遍握手再拉 bundle，然后关这条短连接；UI 仍是「先 sync 再 join」，会握两次手，S1 接受。
- `fetchMod` IPC 增 `password?: string`、`hostFingerprint?: string`。

`RoomRecord` 增：

```ts
encrypt: boolean;
hostFingerprint: string;
deviceKeys: DeviceKeys; // host 进程级可共享同一把设备钥
connections: Map<WebSocket, RoomConnection>;
pendingByFp: Map<string, { ws: WebSocket; name: string; nonce: Buffer; guestPub: Buffer }>;
blacklist: Set<string>;
knownDevices: Map<string, { fp: string; name: string; userId?: string }>;
```

进程级设备钥：`RoomService` 构造时 `loadOrCreateDeviceKeys(userDataDir)` 一次。

`snapshot()` 必须带 `encrypt: r.encrypt` 和 `hostFingerprint`。

- [ ] **步骤 1：写集成测试** `room-transport.test.ts`

抄 `room-mod.test.ts` 的 `makeRooms` / `createHost`。三例：

1. **加密加入成功。** host `create({ name: "t", password: "pw", autoApprove: true })`（默认 encrypt）。guest 用 `rooms.join({ host: "127.0.0.1", port, password: "pw", hostFingerprint })`。断言 `res.ok`，且用原始 `WebSocket` 抓到的首条非 hs 消息 `parsePdu` 为 `env`，`openEnvelope` 后才是 `welcome`。
2. **错密码。** `join({ password: "nope" })` → `ok: false`，error 匹配 `/密码/`。另开裸 `WebSocket` 做完 hello+challenge+错误 prove，断言拒绝帧 `reason === "password"`，随后没有任何 `state.snapshot`。
3. **skip-encrypt 明文。** `create({ encrypt: false, autoApprove: true })`，裸 `WebSocket` 直接发今日 `join` 帧仍能 `welcome`（兼容现有 `room-mod.test.ts` 路径）。

把 `room-mod.test.ts` 的 `createHost` 改为：

```ts
const res = await rooms.create({ name, port, encrypt: false, autoApprove: true });
```

否则模组测例会在握手处挂死。

- [ ] **步骤 2：跑 `room-transport.test.ts` 确认失败**（还没有握手）

```
pnpm --filter @claude-desktop/desktop exec vitest run electron/main/room-transport.test.ts
```

- [ ] **步骤 3：改 `room-service.ts`**

最小接线要点：

- `onGuest`：`parsePdu` 分流；握手未完成只处理 `hs` 与 peek `hello`。
- 新增 `private async handshakeGuest(...)` / `private async handshakeAsGuest(ws, ...)`。
- `broadcast` / `reply`：若 `r.connections.get(ws)` 存在则 `conn.sendFrame(makeRoomFrame(...))`，否则仅 peek 明文。
- 现有 `p.password !== r.password` 比较删除；改在 `verifyPassword`。
- `invite` 用 CDR2。

LAN 地址：`join` 里若 `host` 含 `:` 且看起来像 IPv6，不要按 `host:port` 拆（已有 `!host.includes("::")` 判断，保留）。

- [ ] **步骤 4：测试通过**

```
pnpm --filter @claude-desktop/desktop exec vitest run electron/main/room-transport.test.ts electron/main/room-mod.test.ts
```

预期：两组都 PASS。

- [ ] **步骤 5：Commit**

```
git add apps/desktop/electron/main/room-service.ts apps/desktop/electron/main/room-transport.test.ts apps/desktop/electron/main/room-mod.test.ts packages/shared/src/room-protocol.ts packages/shared/src/ipc.ts apps/desktop/electron/preload/index.ts
git commit -m "feat: encrypt room frames after HMAC handshake"
```

---

### 任务 8：审批、指纹 TOFU、黑名单、踢人

**文件：**
- 修改：`room-service.ts`、`ipc.ts`、`preload/index.ts`、`room-store.ts`
- 修改：`room-transport.test.ts` 追加用例
- 创建：`apps/desktop/src/components/RoomPendingBanner.tsx`（UI 可本任务先 IPC + 测主进程，UI 放到任务 12；本任务至少主进程 + IPC）

语义（规格 6.4）：

- 新设备默认待审批。`autoApprove: true` 自动放行仍记指纹。
- 同一 `userId` 重连且指纹未变：直接 `hs.ok`。
- 指纹变了：告警 + 重新审批（reason 走 IPC 事件 `fingerprintChanged`）。
- 踢人：断该 Connection、废弃 sessionKey、指纹进 `blacklist`。持旧邀请码重连 → `hs.reject { reason: "blacklist" }`。
- `RoomFrameType` 已有 `"kick"`，实现 `kick(roomId, userId)`：对那条连接 `sendFrame(kick)` 后 `close`。

IPC：

```ts
roomApproveDevice: { roomId, fingerprint }
roomDenyDevice: { roomId, fingerprint }
roomKick: { roomId, userId }
roomPending:  // 结果：pending[]
```

`safeSend(IPC.roomEvent, { roomId, pending: [...] })` 推给渲染。

- [ ] **步骤 1：测试**

```ts
it("pending device does not receive snapshot until approved", async () => { ... });
it("blacklisted fingerprint is rejected after kick", async () => { ... });
it("fingerprint change requires re-approval", async () => { ... });
```

待审批期间：guest `join()` Promise 仍挂起或返回 `{ ok: false, error: "等待群主审批" }`——钉死为：**返回错误「等待群主审批」且本地不建 RoomRecord 席位**；房主批准后客人再点加入（S1 不做「审批瞬间自动续握手」，避免半开对象）。握手 socket 在 pending 期间保持，直到超时 60s 或 deny。

更顺手的 UX：pending 时 `join()` 等到 `hs.ok` 或超时。规格没钉。本计划钉：**`join()` 阻塞到 ok / reject / 60s**。测试用 `approveDevice` 在 100ms 后调用。

- [ ] **步骤 2–5：** 红 → 实现 → 绿 → commit `feat: room device approval, TOFU, kick blacklist`

---

### 任务 9：重连拉快照 + 水位（替换 3×30s）

**文件：**
- 修改：`room-service.ts` 的 `reconnectGuest` / `tryReconnectOnce` / `bindGuestSocket`
- 修改：`room-transport.test.ts`

现状：客人断线最多 3 次、每次等 30s。S1：断线后立刻按 `joinInfo` 重握手（含密码与指纹）；成功则收 `welcome`/`state.snapshot`（items 已 ≤400）。失败原因写入 metrics。次数：改为 5 次、指数回退 1s/2s/4s/8s/8s，总等待与现在同量级但第一次更快。

`joinInfo` 增 `hostFingerprint`、`wss?: string[]`，**仍存 password**（仅本机归档，供重连 prove；不进邀请码）。

去重：重连后新 `kid` / 新 session key；旧信封不重放（离线即错过）。`msg_id` 从 1 再计。

- [ ] **步骤 1：测试**

起 host+guest 加密房，`guestWs.close()`，断言 3s 内 guest `RoomRecord.status === "open"` 且收到新 snapshot（通过 `IPC.roomEvent` 数组）。host 进程保持。

再测：host `end()` 后 guest 不再重连（保持今日 `room.closed` → `dismissGuest`）。

- [ ] **步骤 2–5：** 红 → 把 `reconnectGuest` 改走 `join()` 握手路径 → 绿 → commit `feat: room reconnect via handshake and snapshot`

---

### 任务 10：选路 T0 + T1（LAN 竞速与 wss://）

**文件：**
- 修改：`room-service.ts`（`lanAddresses`、`join`、`invite`）
- 修改：`room-protocol.ts` 已有 `wss?: string[]`
- 修改：`ipc.ts` `roomCreate`：`publicWss?: string`

`lanAddresses()`：除 IPv4 外加入非内部、非 `fe80::` 的 IPv6。IPv6 URL：`ws://[2001:db8::1]:18765`。

选路：邀请码里的 LAN `ws://` 与 `wss://` **并行**，每个 2s 超时，`Promise.any` 先开者胜，其余 `ws.close()`。记录胜出 Path：LAN ws → `T0`；`wss://` 且主机名含 `trycloudflare` 或 `cfargotunnel` 或设置标记 → `T2`；其余 wss → `T1`。

T1 主机侧：S1 **不**在 Node 里终止 TLS。房主若有反向代理 / IPv6 入向，创建时填 `publicWss`（例如 `wss://home.example.com:443`），邀请码写入 `u` 数组。本机仍 `WebSocketServer` 听 `0.0.0.0:port`。

强制：`publicWss` 非空时 `encrypt` 必须 true。

- [ ] **步骤 1：测试**

```ts
it("tries second LAN host if the first refuses", async () => { ... });
it("prefers a live wss candidate when LAN is dead", async () => {
  // 本地用 https.createServer 自签证书 + WebSocketServer
  // join({ host: "127.0.0.1", port: deadPort, wss: ["wss://127.0.0.1:tlsPort"] })
});
it("refuses encrypt:false when publicWss is set", async () => {
  const res = await rooms.create({ name: "t", encrypt: false, publicWss: "wss://x" });
  expect(res.ok).toBe(true);
  expect(res.room?.encrypt).toBe(true);
});
```

自签证书测试：`rejectUnauthorized: false` 仅测试；生产 guest 用系统 CA。S1 对自签公网不做特殊例外（用户应走正规证书或 T2）。

- [ ] **步骤 2–5：** 红 → 实现 `joinWithCandidates(urls)` → 绿 → commit `feat: race LAN and wss room candidates`

---

### 任务 11：T2 Cloudflare Tunnel

**文件：**
- 创建：`apps/desktop/electron/main/room-tunnel.ts`
- 创建：`apps/desktop/electron/main/room-tunnel.test.ts`
- 修改：`runtime-paths.ts` 增加 `resolveCloudflared(env)`
- 修改：`electron-builder.yml` extraResources 预留 `bin/cloudflared/**`（目录可空）
- 修改：`room-service.ts`：`create({ tunnel?: boolean })`；`end` 时杀掉子进程

行为：

- `startQuickTunnel(port)` spawn：`cloudflared tunnel --url http://127.0.0.1:${port} --no-autoupdate`。
- 从 stdout/stderr 解析第一个 `https://[a-z0-9-]+.trycloudflare.com`，改写成 `wss://...`。
- 超时 30s 解析不到 → `{ ok: false, error: "隧道启动超时" }`，房间仍作 LAN 房。
- named tunnel：若 `userData/cloudflare-tunnel.json` 有 `{ token: "..." }`，改为 `cloudflared tunnel run --token ...`，`publicWss` 取自同文件 `wss` 字段。Token 不进邀请、不进 IPC 返回值、不打日志全文。
- 找不到二进制：`{ ok: false, error: "未找到 cloudflared" }`，不崩房间。
- `end()` / `disposeAll()` 必须 `child.kill()`。

测试用假二进制：写一个 node 脚本打印一行 `https://abc.trycloudflare.com` 后 sleep；`resolveCloudflared` 可注入。

**不要**把真实 CF token 写进仓库或测试夹具。

- [ ] **步骤 1–5：** 红 → 实现 → 绿 → commit `feat: optional cloudflared quick tunnel for public rooms`

`runtime-paths.ts` 解析顺序：`env.cloudflaredPath` → `path.join(bundledBinRoot(env), "cloudflared", process.platform === "win32" ? "cloudflared.exe" : "cloudflared")` → PATH。

---

### 任务 12：观测指标

**文件：**
- 创建：`apps/desktop/electron/main/room-metrics.ts`
- 创建：`apps/desktop/electron/main/room-metrics.test.ts`
- 修改：`room-service.ts` 在握手成功/失败、选路、重连处 `metrics.record(...)`
- 修改：`ipc.ts` 增加 `roomMetrics`（调试用，可只返回当前进程计数）

事件：

```ts
type MetricEvent =
  | { type: "connect"; path: "T0" | "T1" | "T2"; ok: boolean }
  | { type: "handshake"; reason: "ok" | "password" | "fingerprint" | "denied" | "timeout" | "blacklist" }
  | { type: "reconnect"; ms: number; ok: boolean }
  | { type: "fanout"; bytes: number };
```

`snapshot()` 返回 `{ connect: { T0: { ok, fail }, ... }, handshake: Record<reason, number>, reconnectMsP50, fanoutBytes }`。

计数器用整数即可，P50 用环形缓冲最多 64 个样本。`console.info("[room-metrics]", json)` 一行，方便抓日志。S1 不做 UI 图表。

验收第 7 条：测试断言 T0 成功与密码失败分槽。

- [ ] **步骤 1–5：** 红 → 实现 → 绿 → commit `feat: room transport metrics for path and handshake`

---

### 任务 13：UI 与文案

**文件：**
- 修改：`apps/desktop/src/components/RoomSidebar.tsx`
- 修改：`apps/desktop/src/components/RoomInviteModal.tsx`
- 创建：`apps/desktop/src/components/RoomPendingBanner.tsx`
- 修改：`apps/desktop/src/state/room-store.ts`
- 修改：`apps/desktop/src/i18n/zh.ts`、`en.ts`
- 修改：`preload/index.ts` 对齐 IPC

创建对话框新增：

- 复选「跳过加密（仅局域网）」默认不勾。勾选时若同时勾了公网/隧道，忽略跳过并提示。
- 复选「自动放行新设备」绑定已有 `autoApprove`。
- 复选「公网可达」文本框 `publicWss`。
- 复选「Cloudflare 隧道」→ `create({ tunnel: true })`。
- 密码输入保留，hint 改为「加入时手动输入，不会写入邀请码」。

加入对话框：

- placeholder `粘贴 CDR2.… 邀请码`。
- 粘贴 `CDR1.`：`setErr("该邀请码由旧版本生成，安全性不足，请让房主重新生成")`，**不要**自动填密码、不要 `join`。
- 密码框始终显示（不再从邀请码带入）。
- 解析 CDR2 后把 `wss` 与 `hostFingerprint` 传给 `joinRoom`。

邀请弹窗：展示 `secret`；增加一行「端到端信道已开启 · 指纹 abcd…ef」或「未加密（局域网便利）」——读快照 `encrypt` / `hostFingerprint`。

待审批：房主侧 `RoomPendingBanner` 列出 `{ name, fp }`，按钮批准/拒绝。客人侧 join 返回等待文案即可。

踢人：在群聊设置 overview 的成员列表每行加「移出」按钮，调用 `kickRoom(roomId, userId)`。不要新做独立成员页。

`en.ts` 的 `Messages` 类型是源；`zh.ts` 必须补齐同键，否则 typecheck 失败。

键名（写入 `en.ts` 的 `room:`）：

```
legacyInvite: "This invite was made by an old version and is not safe. Ask the host to create a new one."
passwordHint: "Guests type this when joining. It is not stored in the invite code."
skipEncrypt: "Skip encryption (LAN only)"
skipEncryptHint: "Everyone can see this setting. Public / tunnel rooms cannot skip."
publicWss: "Public wss:// URL (optional)"
tunnel: "Cloudflare tunnel"
fingerprint: "Host fingerprint {fp}"
encryptedOn: "Encrypted channel on"
encryptedOff: "Unencrypted LAN room"
pendingTitle: "Devices waiting"
approve: "Approve"
deny: "Deny"
kick: "Remove"
fingerprintChanged: "This device fingerprint changed. Re-approve to continue."
```

中文由 `zh.ts` 对应翻译。

- [ ] **步骤 1：** 本任务以 typecheck 为测试。改完跑：

```
pnpm --filter @claude-desktop/desktop typecheck
pnpm --filter @claude-desktop/shared test
pnpm --filter @claude-desktop/desktop exec vitest run electron/main/room-transport.test.ts electron/main/room-mod.test.ts
```

渲染层没有现成组件测试框架；不要为了一个 checkbox 新加 RTL。逻辑（CDR1 拒绝、join 参数）若能抽 20 行纯函数到 `src/lib/room-invite-ui.ts` 则补一个 vitest（推荐）：

```ts
export function joinErrorForInvite(text: string): string | null {
  if (!looksLikeRoomInvite(text)) return null;
  try {
    decodeRoomInvite(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "邀请码无效";
  }
}
```

`RoomSidebar` 的 onChange 用它。

- [ ] **步骤 2–5：** 实现 UI → typecheck + 测试绿 → commit `feat: CDR2 join UI, pending approval, encryption flags`

---

### 任务 14：滥用防护接线 + 未知帧

**文件：**
- 修改：`room-service.ts`（在 `onGuest` / `RoomConnection.onFrame` 入口）

规则：

- 原始消息字节数 > `frameLimit(kind)` → 丢弃 + `bucket.take()` 记一次；连续超限 5 次断开。
- 未知 `RoomFrame.type`：已加入的连接上忽略，不计房间状态；仍消耗令牌桶。
- 伪造 `roomId` 与当前房不符：忽略 + 桶。
- 握手超时：`ROOM_HANDSHAKE_TIMEOUT_MS` 后 `hs.reject { reason: "timeout" }` 并 `ws.close()`。
- 未 `hs.ok` 之前：除 `hs` 与 peek `hello`/`mod.fetch` 外全部忽略。`mod.fetch` 仍允许（checksum 已在邀请码里）；**禁止** `state.snapshot` / 席位。

测试补在 `room-transport.test.ts`：

```ts
it("drops oversized handshake", async () => { ... });
it("ignores unknown frame types after join", async () => { ... });
it("times out a silent socket", async () => { ... });
```

超时测试把 watchdog 注入 50ms，不要真等 10s。

- [ ] **步骤 1–5：** 红 → 接线 `room-limits` → 绿 → commit `feat: room abuse limits on handshake and frames`

---

### 任务 15：验收对照与回归

**文件：** 不新增功能。跑全套并对照规格 §15。

- [ ] **步骤 1：跑测试**

```
pnpm --filter @claude-desktop/shared test
pnpm --filter @claude-desktop/desktop exec vitest run electron/main/room-transport.test.ts electron/main/room-mod.test.ts electron/main/room-device-store.test.ts electron/main/room-connection.test.ts electron/main/room-limits.test.ts electron/main/room-metrics.test.ts electron/main/room-tunnel.test.ts
pnpm --filter @claude-desktop/desktop typecheck
pnpm --filter @claude-desktop/shared typecheck
```

全部 PASS。

- [ ] **步骤 2：规格 §15 对照清单（人工，实现者在 PR 描述勾选）**

1. LAN + CDR2 + 密码进加密房；抓包不见 `RoomFrame` 明文（集成测试已用 `parsePdu === env` 代替 tcpdump）。
2. 仅 `wss://` 可进同一协议；隧道测例证明 invite 含 wss 且 AEAD 仍在。
3. 错密码无成员列表；未审批设备进不了默认审批房。
4. 被踢指纹换端口重连仍拒。
5. 不启动 tunnel 时 T0 测例仍绿（T2 代码路径可删除而不影响 T0——由 `room-tunnel.ts` 独立文件保证）。
6. CDR1 粘贴只提示升级。
7. metrics 能区分 T0/T1/T2。

- [ ] **步骤 3：不要在此任务改协议。** 若有缺口，开新任务而不是塞进「收尾」。

- [ ] **步骤 4：Commit** 仅当有测试/文档修补时：`test: cover S1 room transport acceptance`

---

## 规格覆盖对照

| 规格章节 | 任务 |
|---|---|
| §1–2 房主权威、星型、通道可替换 | 全局约束；不改 kernel / 席位权威 |
| §3 威胁模型 | 任务 1 AEAD；任务 8 吊销；房主失陷不防护（不写假承诺） |
| §4 协议栈、三词术语 | 任务 6 Connection；任务 10 Path；Conversation = 现有 roomId |
| §5 无群密钥、快照权威 | 任务 7/9 快照 |
| §6.1 设备钥 TOFU | 任务 1、4、8 |
| §6.2 CDR2、CDR1 只读拒绝 | 任务 3、13 |
| §6.3 PAKE / HMAC、密码不进码 | 任务 2、3；CPace 明确不做 |
| §6.3 LAN 跳过加密可见 | 任务 7 `snapshot.encrypt`、任务 13 UI |
| §6.4 审批 / 指纹变化 / 黑名单 | 任务 8 |
| §7 T0/T1/T2、选路并行短超时 | 任务 10、11 |
| §7.1 CF 账号不暴露、可删除 T2 | 任务 11 独立文件 |
| §7.2 不做 WebRTC | 「本计划不做」 |
| §8 msg_id / ACK / 整信封 / 离线错过 | 任务 6、9 |
| §9 滥用防护 | 任务 5、14 |
| §10 版本与观测 | 信封 `tv` vs `RoomFrame.v`；任务 12 |
| §11 与现行代码关系 | 任务 7 接线表 |
| §12 S1 范围 / 非 100 人验收 | 任务 15 |
| §15 七条验收 | 任务 15 |

## 类型与符号一致性

全程使用这些名字，禁止别名：

- `DeviceKeys` / `generateDeviceKeys` / `fingerprintPublic` / `deriveSessionKey`
- `AeadEnvelope` / `sealEnvelope` / `openEnvelope`
- `provePassword` / `verifyPassword` / `HandshakeReject`
- `parsePdu` → `hs | env | frame | ack`
- `RoomConnection.sendFrame`
- `encrypt: boolean`（快照与建房选项）
- Path 字面量 `"T0" | "T1" | "T2"`
- 邀请 `hostFingerprint`、`wss`
- IPC `roomApproveDevice` / `roomDenyDevice` / `roomKick`

`userId` 仍是房间内显示 ID（随机 UUID），与设备指纹分开。

## 依赖顺序

```
1 crypto
2 handshake + pdu
3 CDR2
4 device store
5 limits
6 connection          ← 1,2,5
7 RoomService wire    ← 3,4,6
8 approval / kick     ← 7
9 reconnect           ← 7,8
10 T0/T1 race         ← 7
11 T2 tunnel          ← 7,10
12 metrics            ← 7–11
13 UI                 ← 3,7,8,10,11
14 abuse wiring       ← 5,7
15 acceptance         ← all
```

任务 3/4/5 在 1、2 之后可并行。任务 10 与 8 在 7 之后可并行。
