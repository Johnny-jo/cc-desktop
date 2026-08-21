import type { WebSocket } from "ws";
import {
  openEnvelope,
  sealEnvelope,
  ROOM_TRANSPORT_VERSION,
  type AeadEnvelope,
} from "@claude-desktop/shared/room-crypto";
import { parsePdu } from "@claude-desktop/shared/room-pdu";
import { parseRoomFrame, type RoomFrame } from "@claude-desktop/shared";

/** Send an ack after this many received app frames… */
const ACK_EVERY = 8;
/** …or when this long has passed since the previous ack. */
const ACK_INTERVAL_MS = 500;

export type RoomConnectionOpts = {
  ws: WebSocket;
  kid: string;
  key: Buffer;
  selfFp: string;
  peerFp: string;
  encrypt: boolean;
};

/**
 * One post-handshake room connection: AEAD send/receive over a WebSocket,
 * msg_id dedupe, and ack watermarks. Handshake frames (`hs`) are ignored —
 * RoomService completes the handshake before wrapping the socket.
 */
export class RoomConnection {
  private readonly opts: RoomConnectionOpts;
  private sendSeq = 1n;
  private readonly seenNonces = new Set<string>();
  private readonly seenMids = new Set<string>();
  /** Peer's ack watermark: how far our sent seqs are confirmed. */
  private upto = 0;
  /** Last app-frame seq received from the peer (envelope sendSeq / frame.seq). */
  private lastRecvSeq = 0;
  private sinceAck = 0;
  private lastAckAt: number;
  private ackTimer: NodeJS.Timeout | null = null;
  private readonly handlers: Array<(frame: RoomFrame) => void> = [];
  private closed = false;

  constructor(opts: RoomConnectionOpts) {
    this.opts = opts;
    this.lastAckAt = Date.now();
    opts.ws.on("message", (data) => this.onMessage(String(data)));
  }

  get peerFp(): string {
    return this.opts.peerFp;
  }

  get kid(): string {
    return this.opts.kid;
  }

  get peerUpto(): number {
    return this.upto;
  }

  onFrame(handler: (frame: RoomFrame) => void): void {
    this.handlers.push(handler);
  }

  sendFrame(frame: RoomFrame): void {
    if (this.closed) return;
    if (!this.opts.encrypt) {
      this.opts.ws.send(JSON.stringify(frame));
      return;
    }
    const env = sealEnvelope({
      key: this.opts.key,
      kid: this.opts.kid,
      sendSeq: this.sendSeq,
      fromFp: this.opts.selfFp,
      plain: Buffer.from(JSON.stringify(frame), "utf8"),
    });
    this.sendSeq += 1n;
    this.opts.ws.send(JSON.stringify(env));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    try {
      this.opts.ws.close();
    } catch {
      // already closed
    }
  }

  private onMessage(raw: string): void {
    if (this.closed) return;
    const pdu = parsePdu(raw);
    if (!pdu) return;
    switch (pdu.kind) {
      case "hs":
        return; // handshake already completed by RoomService
      case "ack":
        if (pdu.kid === this.opts.kid) {
          this.upto = Math.max(this.upto, pdu.upto);
        }
        return;
      case "env":
        this.onEnvelope(pdu.env);
        return;
      case "frame":
        // Plaintext app frames are only accepted on plaintext connections.
        if (this.opts.encrypt) return;
        this.onAppFrame(`${this.opts.peerFp}:${pdu.frame.seq}`, pdu.frame.seq, pdu.frame);
        return;
    }
  }

  private onEnvelope(env: AeadEnvelope): void {
    if (!this.opts.encrypt) return;
    let opened: { plain: Buffer; sendSeq: bigint };
    try {
      opened = openEnvelope({
        key: this.opts.key,
        env,
        expectKid: this.opts.kid,
        seenNonces: this.seenNonces,
      });
    } catch {
      return; // tamper / nonce replay / wrong kid
    }
    const frame = parseRoomFrame(opened.plain.toString("utf8"));
    if (!frame) return;
    this.onAppFrame(env.mid, Number(opened.sendSeq), frame);
  }

  private onAppFrame(mid: string, seq: number, frame: RoomFrame): void {
    if (this.seenMids.has(mid)) return;
    this.seenMids.add(mid);
    this.lastRecvSeq = seq;
    this.maybeAck();
    for (const h of this.handlers) {
      try {
        h(frame);
      } catch {
        // a broken handler must not tear down the transport
      }
    }
  }

  private maybeAck(): void {
    this.sinceAck += 1;
    if (this.sinceAck >= ACK_EVERY || Date.now() - this.lastAckAt > ACK_INTERVAL_MS) {
      this.flushAck();
      return;
    }
    if (!this.ackTimer) {
      this.ackTimer = setTimeout(() => this.flushAck(), ACK_INTERVAL_MS);
      this.ackTimer.unref?.();
    }
  }

  private flushAck(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.sinceAck === 0) return;
    this.sinceAck = 0;
    this.lastAckAt = Date.now();
    if (this.closed || this.lastRecvSeq <= 0) return;
    try {
      this.opts.ws.send(
        JSON.stringify({
          kind: "ack",
          tv: ROOM_TRANSPORT_VERSION,
          kid: this.opts.kid,
          upto: this.lastRecvSeq,
        }),
      );
    } catch {
      // socket already gone
    }
  }
}
