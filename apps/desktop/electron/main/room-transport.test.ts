import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  ROOM_PROTOCOL_VERSION,
  deriveSessionKey,
  fingerprintPublic,
  generateDeviceKeys,
  makeHandshake,
  makeRoomFrame,
  openEnvelope,
  parsePdu,
  parseRoomFrame,
  provePassword,
  sealEnvelope,
  type Handshake,
  type RoomSnapshot,
} from "@claude-desktop/shared";
import { RoomService } from "./room-service";
import type { SessionManager } from "./session-manager";
import type { SettingsStore } from "./settings-store";

const dirs: string[] = [];
const services: RoomService[] = [];

afterEach(() => {
  for (const s of [...services].reverse()) {
    try {
      s.disposeAll();
    } catch {
      // ignore
    }
  }
  services.length = 0;
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dirs.length = 0;
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "room-transport-"));
  dirs.push(d);
  return d;
}

function mockWindow() {
  return () =>
    ({
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: () => undefined,
      },
    }) as never;
}

function mockSessions() {
  return {
    start: vi.fn().mockResolvedValue("sess-agent"),
    continue: vi.fn().mockResolvedValue(undefined),
    getTranscript: vi.fn().mockReturnValue([]),
    abort: vi.fn(),
    syncExtras: vi.fn(),
  } as unknown as SessionManager;
}

function mockSettings(project: string) {
  return {
    get: vi.fn().mockReturnValue({ lastProjectPath: project }),
  } as unknown as SettingsStore;
}

function makeRooms(): RoomService {
  const userDataDir = tmp();
  const rooms = new RoomService({
    getWindow: mockWindow(),
    sessions: mockSessions(),
    settings: mockSettings(userDataDir),
    userDataDir,
    archive: null,
  });
  services.push(rooms);
  return rooms;
}

async function createHost(
  rooms: RoomService,
  opts?: { name?: string; password?: string; encrypt?: boolean },
): Promise<{ room: RoomSnapshot; port: number }> {
  let last = "";
  for (let i = 0; i < 10; i++) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const res = await rooms.create({
      name: opts?.name ?? "t",
      port,
      password: opts?.password,
      encrypt: opts?.encrypt,
      autoApprove: true,
    });
    if (res.ok && res.room) return { room: res.room, port };
    last = res.error ?? "create failed";
  }
  throw new Error(last);
}

function waitOpen(ws: WebSocket, ms = 5000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), ms);
    ws.once("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

/** Resolve with the first handshake message of the given type. */
function waitHs(ws: WebSocket, type: string, ms = 5000): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting hs.${type}`)), ms);
    const onMsg = (data: RawData) => {
      const pdu = parsePdu(String(data));
      if (pdu?.kind !== "hs" || pdu.hs.type !== type) return;
      clearTimeout(t);
      ws.off("message", onMsg);
      resolve(pdu.hs);
    };
    ws.on("message", onMsg);
  });
}

/** Resolve with the raw text of the first non-handshake message. */
function waitNonHs(ws: WebSocket, ms = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting non-hs message")), ms);
    const onMsg = (data: RawData) => {
      const raw = String(data);
      const pdu = parsePdu(raw);
      if (!pdu || pdu.kind === "hs") return;
      clearTimeout(t);
      ws.off("message", onMsg);
      resolve(raw);
    };
    ws.on("message", onMsg);
  });
}

function waitClose(ws: WebSocket, ms = 2000): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    ws.once("close", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Raw-socket handshake: hello → challenge → prove → ok. Returns session context. */
async function rawHandshake(
  ws: WebSocket,
  password: string,
): Promise<{
  key: Buffer;
  kid: string;
  guestFp: string;
  hostFp: string;
  encrypt: boolean;
}> {
  const keys = generateDeviceKeys();
  const guestFp = fingerprintPublic(keys.publicRaw);
  ws.send(
    JSON.stringify(
      makeHandshake("hello", {
        pub: keys.publicRaw.toString("base64url"),
        fp: guestFp,
        name: "raw",
      }),
    ),
  );
  const challenge = await waitHs(ws, "challenge");
  const cp = challenge.payload as {
    pub: string;
    fp: string;
    nonce: string;
    encrypt: boolean;
  };
  const key = deriveSessionKey(keys, Buffer.from(cp.pub, "base64url"));
  const proof = provePassword({
    password,
    nonce: Buffer.from(cp.nonce, "base64url"),
    hostFp: cp.fp,
    guestFp,
    ecdhSs: key,
  });
  ws.send(JSON.stringify(makeHandshake("prove", { proof })));
  const ok = await waitHs(ws, "ok");
  const op = ok.payload as { kid: string; encrypt: boolean };
  return { key, kid: op.kid, guestFp, hostFp: cp.fp, encrypt: op.encrypt };
}

describe("room transport: handshake + encrypted frames", () => {
  it("encrypted join succeeds; welcome travels inside an AEAD envelope", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });
    expect(room.encrypt).toBe(true);
    const hostFp = room.hostFingerprint ?? "";
    expect(hostFp).toMatch(/^[0-9a-f]{64}$/);

    // Service-level guest join (handshake + encrypted join).
    const guest = makeRooms();
    const res = await guest.join({
      host: "127.0.0.1",
      port,
      password: "pw",
      hostFingerprint: hostFp,
    });
    expect(res.ok).toBe(true);
    expect(res.room?.encrypt).toBe(true);

    // Raw-socket guest: verify the wire format directly.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    const hs = await rawHandshake(ws, "pw");
    expect(hs.encrypt).toBe(true);
    expect(hs.hostFp).toBe(hostFp);

    const joinFrame = makeRoomFrame("pending", 1, "join", {
      userId: "raw-user-1",
      name: "raw",
      protocol: ROOM_PROTOCOL_VERSION,
      modChecksum: "",
    });
    const env = sealEnvelope({
      key: hs.key,
      kid: hs.kid,
      sendSeq: 1n,
      fromFp: hs.guestFp,
      plain: Buffer.from(JSON.stringify(joinFrame), "utf8"),
    });
    ws.send(JSON.stringify(env));

    // First non-handshake message must be an AEAD envelope decrypting to welcome.
    const first = parsePdu(await waitNonHs(ws));
    expect(first?.kind).toBe("env");
    if (first?.kind !== "env") throw new Error("unreachable");
    const opened = openEnvelope({
      key: hs.key,
      env: first.env,
      expectKid: hs.kid,
      seenNonces: new Set(),
    });
    const welcome = parseRoomFrame(opened.plain.toString("utf8"));
    expect(welcome?.type).toBe("welcome");
    ws.close();
  });

  it("wrong password is rejected with reason=password and no snapshot follows", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { password: "pw" });

    const guest = makeRooms();
    const res = await guest.join({
      host: "127.0.0.1",
      port,
      password: "nope",
      hostFingerprint: room.hostFingerprint,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/密码/);

    // Raw socket: bad proof → hs.reject { reason: "password" } then close.
    const keys = generateDeviceKeys();
    const guestFp = fingerprintPublic(keys.publicRaw);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    ws.send(
      JSON.stringify(
        makeHandshake("hello", {
          pub: keys.publicRaw.toString("base64url"),
          fp: guestFp,
          name: "raw",
        }),
      ),
    );
    const challenge = await waitHs(ws, "challenge");
    const cp = challenge.payload as { pub: string; fp: string; nonce: string };
    const key = deriveSessionKey(keys, Buffer.from(cp.pub, "base64url"));
    const badProof = provePassword({
      password: "nope",
      nonce: Buffer.from(cp.nonce, "base64url"),
      hostFp: cp.fp,
      guestFp,
      ecdhSs: key,
    });
    ws.send(JSON.stringify(makeHandshake("prove", { proof: badProof })));
    const reject = await waitHs(ws, "reject");
    expect((reject.payload as { reason: string }).reason).toBe("password");

    const later: string[] = [];
    ws.on("message", (d) => later.push(String(d)));
    await waitClose(ws);
    expect(
      later.some((m) => parseRoomFrame(m)?.type === "state.snapshot"),
    ).toBe(false);
  });

  it("skip-encrypt room still accepts today's plaintext join frame", async () => {
    const host = makeRooms();
    const { room, port } = await createHost(host, { encrypt: false });
    expect(room.encrypt).toBe(false);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitOpen(ws);
    const welcomePending = new Promise<ReturnType<typeof parseRoomFrame>>(
      (resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout waiting welcome")), 5000);
        const onMsg = (data: RawData) => {
          const frame = parseRoomFrame(String(data));
          if (frame?.type === "welcome" || frame?.type === "error") {
            clearTimeout(t);
            ws.off("message", onMsg);
            resolve(frame);
          }
        };
        ws.on("message", onMsg);
      },
    );
    ws.send(
      JSON.stringify(
        makeRoomFrame("pending", 1, "join", {
          userId: "plain-1",
          name: "plain",
          password: "",
          protocol: ROOM_PROTOCOL_VERSION,
          modChecksum: "",
        }),
      ),
    );
    const welcome = await welcomePending;
    expect(welcome?.type).toBe("welcome");
    ws.close();
  });
});
