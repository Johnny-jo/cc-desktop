/**
 * Room transport observability (S1 task 12). Process-local integer counters
 * for the T0/T1/T2 path race, handshake outcomes, guest reconnect latency,
 * and host fan-out bytes. Every record() also emits one compact single-line
 * `console.info("[room-metrics]", json)` log so the counters can be grepped
 * out of a log capture — S1 ships no metrics UI.
 */
import type { RoomMetricsSnapshot, RoomPath } from "@claude-desktop/shared";
import type { HandshakeReject } from "@claude-desktop/shared/room-handshake";

export type MetricEvent =
  | { type: "connect"; path: RoomPath; ok: boolean }
  | { type: "handshake"; reason: "ok" | HandshakeReject }
  | { type: "reconnect"; ms: number; ok: boolean }
  | { type: "fanout"; bytes: number };

/** Reconnect latency samples kept for the P50 (ring buffer). */
export const ROOM_METRICS_RECONNECT_SAMPLES = 64;

const HANDSHAKE_REASONS = [
  "ok",
  "password",
  "fingerprint",
  "denied",
  "timeout",
  "blacklist",
] as const;

export type RoomMetricsLogger = (tag: string, json: string) => void;

export class RoomMetrics {
  private readonly connect: Record<RoomPath, { ok: number; fail: number }> = {
    T0: { ok: 0, fail: 0 },
    T1: { ok: 0, fail: 0 },
    T2: { ok: 0, fail: 0 },
  };
  private readonly handshake: Record<"ok" | HandshakeReject, number> = {
    ok: 0,
    password: 0,
    fingerprint: 0,
    denied: 0,
    timeout: 0,
    blacklist: 0,
  };
  /** Ring buffer of the latest reconnect durations (ms), oldest overwritten. */
  private readonly reconnectRing: number[] = [];
  private reconnectHead = 0;
  private fanoutBytes = 0;
  private readonly log: RoomMetricsLogger;

  constructor(log?: RoomMetricsLogger) {
    this.log = log ?? ((tag, json) => console.info(tag, json));
  }

  record(event: MetricEvent): void {
    switch (event.type) {
      case "connect": {
        const slot = this.connect[event.path];
        if (event.ok) slot.ok += 1;
        else slot.fail += 1;
        break;
      }
      case "handshake": {
        this.handshake[event.reason] += 1;
        break;
      }
      case "reconnect": {
        const ms = Math.max(0, Math.round(event.ms));
        if (this.reconnectRing.length < ROOM_METRICS_RECONNECT_SAMPLES) {
          this.reconnectRing.push(ms);
        } else {
          this.reconnectRing[this.reconnectHead] = ms;
          this.reconnectHead = (this.reconnectHead + 1) % ROOM_METRICS_RECONNECT_SAMPLES;
        }
        break;
      }
      case "fanout": {
        this.fanoutBytes += Math.max(0, Math.round(event.bytes));
        break;
      }
    }
    this.log("[room-metrics]", JSON.stringify(event));
  }

  /** Current counters; a fresh copy on every call. */
  snapshot(): RoomMetricsSnapshot {
    const sorted = [...this.reconnectRing].sort((a, b) => a - b);
    const reconnectMsP50 = sorted.length
      ? sorted[Math.floor((sorted.length - 1) / 2)]!
      : 0;
    return {
      connect: {
        T0: { ...this.connect.T0 },
        T1: { ...this.connect.T1 },
        T2: { ...this.connect.T2 },
      },
      handshake: { ...this.handshake },
      reconnectMsP50,
      fanoutBytes: this.fanoutBytes,
    };
  }
}

/** Guard used when mapping a wire reject reason string onto the counter slots. */
export function isHandshakeReason(
  reason: string | undefined,
): reason is "ok" | HandshakeReject {
  return (HANDSHAKE_REASONS as readonly string[]).includes(reason ?? "");
}
