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
