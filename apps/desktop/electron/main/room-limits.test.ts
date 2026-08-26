import { describe, expect, it } from "vitest";
import {
  MOD_BUNDLE_MAX_BYTES,
  ROOM_FRAME_LIMITS,
  ROOM_HANDSHAKE_TIMEOUT_MS,
  ROOM_HANDSHAKE_OPEN_TIMEOUT_MS,
} from "@claude-desktop/shared";
import {
  HandshakeWatchdog,
  makeReconnectBucket,
  frameLimit,
  ROOM_RECONNECT_BURST,
  ROOM_RECONNECT_RATE_PER_SEC,
  TokenBucket,
} from "./room-limits";

describe("room protocol limit constants", () => {
  it("exports handshake timeout and the frame limit table", () => {
    expect(ROOM_HANDSHAKE_TIMEOUT_MS).toBe(10_000);
    expect(ROOM_HANDSHAKE_OPEN_TIMEOUT_MS).toBe(20_000);
    expect(ROOM_FRAME_LIMITS.handshake).toBe(8 * 1024);
    expect(ROOM_FRAME_LIMITS["chat.user"]).toBe(64 * 1024);
    expect(ROOM_FRAME_LIMITS["chat.event"]).toBe(64 * 1024);
    expect(ROOM_FRAME_LIMITS["state.snapshot"]).toBe(2 * 1024 * 1024);
    expect(ROOM_FRAME_LIMITS["mod.bundle"]).toBe(MOD_BUNDLE_MAX_BYTES);
    expect(ROOM_FRAME_LIMITS.envelope).toBe(2 * 1024 * 1024 + 256);
    expect(ROOM_FRAME_LIMITS.default).toBe(256 * 1024);
  });
});

describe("TokenBucket", () => {
  it("allows burst then denies", () => {
    const t = 1000;
    const b = new TokenBucket({ ratePerSec: 30, burst: 3, now: () => t });
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it("refills with elapsed time", () => {
    let t = 1000;
    const b = new TokenBucket({ ratePerSec: 30, burst: 3, now: () => t });
    b.take();
    b.take();
    b.take();
    expect(b.take()).toBe(false);
    t += 100; // 30 tokens/s => 3 tokens after 100ms
    expect(b.take()).toBe(true);
  });

  it("caps refill at burst", () => {
    let t = 0;
    const b = new TokenBucket({ ratePerSec: 1, burst: 2, now: () => t });
    t += 60_000;
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
});

describe("frameLimit", () => {
  it("uses type table and default", () => {
    expect(frameLimit("chat.user")).toBe(64 * 1024);
    expect(frameLimit("seat.claim")).toBe(256 * 1024);
    expect(frameLimit("handshake")).toBe(8 * 1024);
  });
});

describe("HandshakeWatchdog", () => {
  it("fires onTimeout when not cancelled in time", async () => {
    let fired = 0;
    const w = new HandshakeWatchdog(50, () => {
      fired += 1;
    });
    w.start();
    await new Promise((r) => setTimeout(r, 90));
    expect(fired).toBe(1);
  });

  it("cancel prevents onTimeout", async () => {
    let fired = 0;
    const w = new HandshakeWatchdog(50, () => {
      fired += 1;
    });
    w.start();
    w.cancel();
    await new Promise((r) => setTimeout(r, 90));
    expect(fired).toBe(0);
  });

  it("start re-arms the timer", async () => {
    let fired = 0;
    const w = new HandshakeWatchdog(60, () => {
      fired += 1;
    });
    w.start();
    await new Promise((r) => setTimeout(r, 30));
    w.start();
    await new Promise((r) => setTimeout(r, 45)); // 75ms from first start, 45 from re-arm
    expect(fired).toBe(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(1);
  });
});

describe("makeReconnectBucket", () => {
  it("throttles to 3 reconnects per 30s per fingerprint", () => {
    let t = 0;
    expect(ROOM_RECONNECT_RATE_PER_SEC).toBeCloseTo(3 / 30);
    expect(ROOM_RECONNECT_BURST).toBe(3);
    const b = makeReconnectBucket(() => t);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    t += 10_000; // one token every 10s
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
});
