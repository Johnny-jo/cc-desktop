/**
 * Room transport limits — frame size caps, per-connection token bucket,
 * half-open handshake watchdog. Pure functions/classes only; wiring into
 * RoomService (dropping oversized frames, throttling reconnects) is a
 * later task.
 */
import { ROOM_FRAME_LIMITS } from "@claude-desktop/shared";

export type TokenBucketOptions = {
  /** Tokens refilled per second. */
  ratePerSec: number;
  /** Max tokens held; the bucket starts full. */
  burst: number;
  /** Clock in ms; defaults to Date.now. */
  now?: () => number;
};

/** Leaky bucket: starts full, refills at ratePerSec, take() spends one. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    this.ratePerSec = opts.ratePerSec;
    this.burst = opts.burst;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.burst;
    this.last = this.now();
  }

  /** Consume one token. true = allowed, false = throttled. */
  take(): boolean {
    const t = this.now();
    const elapsedMs = t - this.last;
    if (elapsedMs > 0) {
      this.tokens = Math.min(
        this.burst,
        this.tokens + (elapsedMs / 1000) * this.ratePerSec,
      );
      this.last = t;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Max byte size accepted for a frame of the given type (default for unknown). */
export function frameLimit(type: string): number {
  return (
    (ROOM_FRAME_LIMITS as Record<string, number>)[type] ??
    ROOM_FRAME_LIMITS.default
  );
}

/**
 * Times out half-open connections: fires onTimeout unless cancel() runs
 * within timeoutMs of start(). start() re-arms the timer.
 */
export class HandshakeWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {}

  start(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onTimeout();
    }, this.timeoutMs);
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** Ping idle WebSocket hops so a relay / proxy / NAT does not drop them. */
export const ROOM_WS_HEARTBEAT_MS = 15_000;

type HeartbeatWs = {
  readyState: number;
  ping: (data?: unknown) => void;
  terminate: () => void;
  on: (event: string, listener: () => void) => unknown;
  off: (event: string, listener: () => void) => unknown;
};

const WS_OPEN = 1;

/**
 * Send a ping every intervalMs. Any pong or message marks the socket alive;
 * a missed round trips terminate() so the caller reconnects instead of
 * hanging on a half-dead hop (the approval wait is the common idle case).
 */
export function startWsHeartbeat(
  ws: HeartbeatWs,
  intervalMs = ROOM_WS_HEARTBEAT_MS,
): () => void {
  let alive = true;
  const markAlive = () => {
    alive = true;
  };
  ws.on("pong", markAlive);
  ws.on("message", markAlive);
  const timer = setInterval(() => {
    if (ws.readyState !== WS_OPEN) return;
    if (!alive) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    ws.off("pong", markAlive);
    ws.off("message", markAlive);
  };
}

/** Reconnect throttle: 3 attempts per 30 s per device fingerprint. */
export const ROOM_RECONNECT_RATE_PER_SEC = 3 / 30;
export const ROOM_RECONNECT_BURST = 3;

export function makeReconnectBucket(now?: () => number): TokenBucket {
  return new TokenBucket({
    ratePerSec: ROOM_RECONNECT_RATE_PER_SEC,
    burst: ROOM_RECONNECT_BURST,
    ...(now ? { now } : {}),
  });
}
