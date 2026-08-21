import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  deriveSessionKey,
  fingerprintPublic,
  generateDeviceKeys,
  makeRoomFrame,
  openEnvelope,
  parsePdu,
  sealEnvelope,
  type AeadEnvelope,
  type RoomFrame,
} from "@claude-desktop/shared";
import { RoomConnection } from "./room-connection";

const KID = "test-kid";

type Pair = {
  client: RoomConnection;
  server: RoomConnection;
  clientWs: WebSocket;
  serverWs: WebSocket;
  wss: WebSocketServer;
  keyA: Buffer;
  keyB: Buffer;
  fpA: string;
  fpB: string;
};

const pairs: Pair[] = [];

afterEach(() => {
  for (const p of pairs.splice(0)) {
    try {
      p.client.close();
      p.server.close();
    } catch {
      // ignore
    }
    try {
      p.wss.close();
    } catch {
      // ignore
    }
  }
});

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

async function makePair(encrypt: boolean): Promise<Pair> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });
  const addr = wss.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const serverWsP = new Promise<WebSocket>((resolve) =>
    wss.once("connection", (ws) => resolve(ws)),
  );
  const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
  const [serverWs] = await Promise.all([serverWsP, waitOpen(clientWs)]);

  const a = generateDeviceKeys();
  const b = generateDeviceKeys();
  const keyA = deriveSessionKey(a, b.publicRaw);
  const keyB = deriveSessionKey(b, a.publicRaw);
  const fpA = fingerprintPublic(a.publicRaw);
  const fpB = fingerprintPublic(b.publicRaw);

  const client = new RoomConnection({
    ws: clientWs,
    kid: KID,
    key: keyA,
    selfFp: fpA,
    peerFp: fpB,
    encrypt,
  });
  const server = new RoomConnection({
    ws: serverWs,
    kid: KID,
    key: keyB,
    selfFp: fpB,
    peerFp: fpA,
    encrypt,
  });
  const pair: Pair = { client, server, clientWs, serverWs, wss, keyA, keyB, fpA, fpB };
  pairs.push(pair);
  return pair;
}

function collect(conn: RoomConnection): RoomFrame[] {
  const got: RoomFrame[] = [];
  conn.onFrame((f) => got.push(f));
  return got;
}

describe("RoomConnection", () => {
  it("encrypt round-trip: wire is an envelope the peer can open back to the frame", async () => {
    const p = await makePair(true);
    const raws: string[] = [];
    p.serverWs.on("message", (d) => raws.push(String(d)));
    const got = collect(p.server);

    const frame = makeRoomFrame("room-1", 1, "chat.user", { text: "hello" });
    p.client.sendFrame(frame);

    await vi.waitFor(() => expect(got.length).toBe(1));
    expect(got[0]).toEqual(frame);

    const pdu = parsePdu(raws[0]!);
    expect(pdu?.kind).toBe("env");
    const env = (pdu as { kind: "env"; env: AeadEnvelope }).env;
    const opened = openEnvelope({ key: p.keyB, env, expectKid: KID });
    expect(JSON.parse(opened.plain.toString("utf8"))).toEqual(frame);
    expect(opened.fromFp).toBe(p.fpA);
    expect(opened.sendSeq).toBe(1n);
  });

  it("plaintext round-trip when encrypt=false sends the frame as-is", async () => {
    const p = await makePair(false);
    const raws: string[] = [];
    p.serverWs.on("message", (d) => raws.push(String(d)));
    const got = collect(p.server);

    const frame = makeRoomFrame("room-1", 3, "chat.user", { text: "plain" });
    p.client.sendFrame(frame);

    await vi.waitFor(() => expect(got.length).toBe(1));
    expect(got[0]).toEqual(frame);
    expect(raws[0]).toBe(JSON.stringify(frame));
    expect(parsePdu(raws[0]!)?.kind).toBe("frame");
  });

  it("drops a second frame with the same mid (dedupe) and nonce replays", async () => {
    const p = await makePair(true);
    const got = collect(p.client);

    const frameA = makeRoomFrame("room-1", 1, "chat.user", { text: "A" });
    const frameB = makeRoomFrame("room-1", 2, "chat.user", { text: "B" });
    const env1 = sealEnvelope({
      key: p.keyB,
      kid: KID,
      sendSeq: 1n,
      fromFp: p.fpB,
      plain: Buffer.from(JSON.stringify(frameA), "utf8"),
    });
    // Valid cipher for seq 2 but reusing env1's mid → must hit mid dedupe.
    const env2: AeadEnvelope = {
      ...sealEnvelope({
        key: p.keyB,
        kid: KID,
        sendSeq: 2n,
        fromFp: p.fpB,
        plain: Buffer.from(JSON.stringify(frameB), "utf8"),
      }),
      mid: env1.mid,
    };

    p.serverWs.send(JSON.stringify(env1));
    p.serverWs.send(JSON.stringify(env2));
    p.serverWs.send(JSON.stringify(env1)); // exact replay → nonce reuse

    await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([frameA]);
  });

  it("drops a tampered envelope without triggering onFrame", async () => {
    const p = await makePair(true);
    const got = collect(p.client);

    const good = sealEnvelope({
      key: p.keyB,
      kid: KID,
      sendSeq: 1n,
      fromFp: p.fpB,
      plain: Buffer.from(JSON.stringify(makeRoomFrame("room-1", 1, "chat.user", { text: "x" }))),
    });
    const tampered: AeadEnvelope = {
      ...good,
      c: (good.c[0] === "A" ? "B" : "A") + good.c.slice(1),
    };
    p.serverWs.send(JSON.stringify(tampered));

    const frame2 = makeRoomFrame("room-1", 2, "chat.user", { text: "ok" });
    const valid = sealEnvelope({
      key: p.keyB,
      kid: KID,
      sendSeq: 2n,
      fromFp: p.fpB,
      plain: Buffer.from(JSON.stringify(frame2), "utf8"),
    });
    p.serverWs.send(JSON.stringify(valid));

    await vi.waitFor(() => expect(got.length).toBe(1));
    expect(got[0]).toEqual(frame2);
  });

  it("plaintext frames are rejected when encrypt=true", async () => {
    const p = await makePair(true);
    const got = collect(p.client);
    p.serverWs.send(
      JSON.stringify(makeRoomFrame("room-1", 1, "chat.user", { text: "plain" })),
    );

    const frame = makeRoomFrame("room-1", 2, "chat.user", { text: "enc" });
    p.server.sendFrame(frame);
    await vi.waitFor(() => expect(got.length).toBe(1));
    expect(got[0]).toEqual(frame);
  });

  it("acks every 8 app frames and advances peerUpto", async () => {
    const p = await makePair(true);
    expect(p.client.peerUpto).toBe(0);
    for (let i = 1; i <= 8; i++) {
      p.client.sendFrame(makeRoomFrame("room-1", i, "chat.user", { text: `m${i}` }));
    }
    await vi.waitFor(() => expect(p.client.peerUpto).toBe(8));
    expect(p.server.peerFp).toBe(p.fpA);
    expect(p.client.kid).toBe(KID);
  });
});
