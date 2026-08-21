import { describe, expect, it } from "vitest";
import { RoomMetrics } from "./room-metrics";

/** Metrics with a silent logger that captures the emitted lines. */
function quiet(): { m: RoomMetrics; lines: string[] } {
  const lines: string[] = [];
  const m = new RoomMetrics((tag, json) => lines.push(`${tag} ${json}`));
  return { m, lines };
}

describe("RoomMetrics counters", () => {
  it("puts a T0 connect ok and a password handshake failure in different slots", () => {
    const { m } = quiet();
    m.record({ type: "connect", path: "T0", ok: true });
    m.record({ type: "handshake", reason: "password" });
    const s = m.snapshot();
    expect(s.connect.T0).toEqual({ ok: 1, fail: 0 });
    expect(s.handshake.password).toBe(1);
    expect(s.handshake.ok).toBe(0);
  });

  it("buckets connect per path with ok/fail", () => {
    const { m } = quiet();
    m.record({ type: "connect", path: "T0", ok: true });
    m.record({ type: "connect", path: "T0", ok: false });
    m.record({ type: "connect", path: "T1", ok: true });
    m.record({ type: "connect", path: "T2", ok: false });
    const s = m.snapshot();
    expect(s.connect.T0).toEqual({ ok: 1, fail: 1 });
    expect(s.connect.T1).toEqual({ ok: 1, fail: 0 });
    expect(s.connect.T2).toEqual({ ok: 0, fail: 1 });
  });

  it("counts every handshake reason in its own slot", () => {
    const { m } = quiet();
    m.record({ type: "handshake", reason: "ok" });
    m.record({ type: "handshake", reason: "ok" });
    m.record({ type: "handshake", reason: "fingerprint" });
    m.record({ type: "handshake", reason: "denied" });
    m.record({ type: "handshake", reason: "timeout" });
    m.record({ type: "handshake", reason: "blacklist" });
    expect(m.snapshot().handshake).toEqual({
      ok: 2,
      password: 0,
      fingerprint: 1,
      denied: 1,
      timeout: 1,
      blacklist: 1,
    });
  });

  it("accumulates fanout bytes", () => {
    const { m } = quiet();
    m.record({ type: "fanout", bytes: 100 });
    m.record({ type: "fanout", bytes: 23 });
    expect(m.snapshot().fanoutBytes).toBe(123);
  });
});

describe("RoomMetrics reconnect P50", () => {
  it("is 0 with no samples", () => {
    const { m } = quiet();
    expect(m.snapshot().reconnectMsP50).toBe(0);
  });

  it("computes the median of the recorded samples", () => {
    const { m } = quiet();
    for (const ms of [50, 10, 30, 20, 40]) {
      m.record({ type: "reconnect", ms, ok: true });
    }
    expect(m.snapshot().reconnectMsP50).toBe(30);
  });

  it("keeps only the latest 64 samples in the ring buffer", () => {
    const { m } = quiet();
    for (let i = 1; i <= 100; i++) {
      m.record({ type: "reconnect", ms: i, ok: i % 2 === 0 });
    }
    // Ring holds samples 37..100; sorted, the median index is 31 → 68.
    expect(m.snapshot().reconnectMsP50).toBe(68);
  });
});

describe("RoomMetrics logging", () => {
  it("emits one compact single-line JSON per record", () => {
    const { m, lines } = quiet();
    m.record({ type: "connect", path: "T1", ok: true });
    m.record({ type: "fanout", bytes: 5 });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.startsWith("[room-metrics] ")).toBe(true);
      expect(line).not.toContain("\n");
    }
    expect(JSON.parse(lines[0]!.slice("[room-metrics] ".length))).toEqual({
      type: "connect",
      path: "T1",
      ok: true,
    });
  });
});

describe("RoomMetrics snapshot", () => {
  it("has a stable zeroed shape before any event", () => {
    const { m } = quiet();
    expect(m.snapshot()).toEqual({
      connect: {
        T0: { ok: 0, fail: 0 },
        T1: { ok: 0, fail: 0 },
        T2: { ok: 0, fail: 0 },
      },
      handshake: {
        ok: 0,
        password: 0,
        fingerprint: 0,
        denied: 0,
        timeout: 0,
        blacklist: 0,
      },
      reconnectMsP50: 0,
      fanoutBytes: 0,
    });
  });

  it("returns copies — mutating a snapshot does not touch the counters", () => {
    const { m } = quiet();
    m.record({ type: "connect", path: "T0", ok: true });
    const s = m.snapshot();
    s.connect.T0.ok = 999;
    s.handshake.ok = 999;
    expect(m.snapshot().connect.T0.ok).toBe(1);
    expect(m.snapshot().handshake.ok).toBe(0);
  });
});
