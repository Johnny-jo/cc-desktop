import { ROOM_TRANSPORT_VERSION, type AeadEnvelope } from "./room-crypto";
import { parseHandshake, type Handshake } from "./room-handshake";
import type { RoomFrame } from "./room-protocol";

export type Pdu =
  | { kind: "hs"; hs: Handshake }
  | { kind: "ack"; tv: number; kid: string; upto: number }
  | { kind: "env"; env: AeadEnvelope }
  | { kind: "frame"; frame: RoomFrame };

export function parsePdu(raw: string): Pdu | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (obj.kind === "hs" && obj.v === 1) {
    const hs = parseHandshake(raw);
    return hs ? { kind: "hs", hs } : null;
  }
  if (obj.kind === "ack") {
    if (typeof obj.tv !== "number" || typeof obj.kid !== "string" || typeof obj.upto !== "number") {
      return null;
    }
    return { kind: "ack", tv: obj.tv, kid: obj.kid, upto: obj.upto };
  }
  if (
    obj.tv === ROOM_TRANSPORT_VERSION &&
    typeof obj.kid === "string" &&
    typeof obj.n === "string" &&
    typeof obj.c === "string"
  ) {
    return { kind: "env", env: obj as unknown as AeadEnvelope };
  }
  if (obj.v === 1 && typeof obj.type === "string" && typeof obj.roomId === "string") {
    return { kind: "frame", frame: obj as unknown as RoomFrame };
  }
  return null;
}
