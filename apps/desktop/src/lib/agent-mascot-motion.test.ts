import { describe, expect, it } from "vitest";
import { createDizzyDetector } from "./agent-mascot-motion";

/** Four alternating strokes, with controllable event frequency, speed and size. */
function shake(interval: number, speed = 2, vertical = false, strokeLength = 120) {
  const detector = createDizzyDetector();
  let triggered = false;
  const duration = strokeLength / speed;
  for (let time = 0; time <= duration * 4; time += interval) {
    const stroke = Math.floor(time / duration);
    const progress = (time % duration) * speed;
    const coordinate = stroke % 2 ? strokeLength - progress : progress;
    triggered ||= vertical
      ? detector.sample(0, coordinate, time)
      : detector.sample(coordinate, 0, time);
  }
  return triggered;
}

describe("createDizzyDetector", () => {
  it.each([1, 4, 8, 16, 30])("recognizes repeated fast shakes at %i ms sampling", (interval) => {
    expect(shake(interval)).toBe(true);
  });

  it("recognizes vertical shaking too", () => {
    expect(shake(8, 2, true)).toBe(true);
  });

  it.each([1, 8, 16, 30, 50])("recognizes smaller, gentler deliberate shakes at %i ms sampling", (interval) => {
    expect(shake(interval, 0.55, false, 80)).toBe(true);
  });

  it("recognizes two clear reversals once the pointer has travelled 200 px", () => {
    const detector = createDizzyDetector();
    expect([[0, 0], [70, 120], [0, 240], [60, 350]].map(([x, time]) => detector.sample(x, 0, time))).toEqual([false, false, false, true]);
  });

  it("allows natural deceleration when the pointer turns around", () => {
    const detector = createDizzyDetector();
    const results: boolean[] = [];
    for (let time = 0; time <= 850; time += 8) {
      results.push(detector.sample(Math.cos(time / 1000 * Math.PI * 6) * 80, 0, time));
    }
    expect(results).toContain(true);
  });

  it("does not react to a single fast sweep or one reversal", () => {
    const detector = createDizzyDetector();
    const results = [0, 120, 240, 360, 240, 120, 0].map((x, i) => detector.sample(x, 0, i * 50));
    expect(results).not.toContain(true);
  });

  it("does not react to slow back-and-forth motion", () => {
    expect(shake(16, 0.4)).toBe(false);
  });

  it("ignores rapid small coordinate jitter", () => {
    const detector = createDizzyDetector();
    const results = Array.from({ length: 150 }, (_, i) => detector.sample(i % 2 ? 24 : 0, 0, i * 5));
    expect(results).not.toContain(true);
  });

  it("ignores tiny strokes even when they contain several samples", () => {
    const detector = createDizzyDetector();
    const results = [0, 14, 28, 14, 0, 14, 28, 14, 0, 14, 28].map((x, i) => detector.sample(x, 0, i * 10));
    expect(results).not.toContain(true);
  });

  it("requires 200 px of travel even with two clear reversals", () => {
    const detector = createDizzyDetector();
    expect([0, 60, 0, 60].map((x, i) => detector.sample(x, 0, i * 75))).not.toContain(true);
  });

  it("does not join fast strokes across sustained slow movement", () => {
    const detector = createDizzyDetector();
    const points = [[0, 0], [80, 100], [0, 200], [10, 250], [20, 300], [30, 350], [40, 400], [100, 480], [40, 560]];
    expect(points.map(([x, time]) => detector.sample(x, 0, time))).not.toContain(true);
  });

  it("does not combine separate gestures across a pause", () => {
    const detector = createDizzyDetector();
    const points = [[0, 0], [120, 50], [0, 100], [120, 500], [0, 550], [120, 600]];
    expect(points.map(([x, time]) => detector.sample(x, 0, time))).not.toContain(true);
  });

  it("expires reversals outside the rolling gesture window", () => {
    const detector = createDizzyDetector();
    const results: boolean[] = [];
    // Long fast strokes keep moving continuously, but reverse too infrequently.
    for (let time = 0; time <= 4000; time += 25) {
      const stroke = Math.floor(time / 1100);
      const progress = (time % 1100) * 2;
      results.push(detector.sample(stroke % 2 ? 2200 - progress : progress, 0, time));
    }
    expect(results).not.toContain(true);
  });

  it("ignores duplicate/non-increasing timestamps and clears invalid samples", () => {
    const detector = createDizzyDetector();
    expect(detector.sample(0, 0, 0)).toBe(false);
    expect(detector.sample(120, 0, 50)).toBe(false);
    expect(detector.sample(-120, 0, 50)).toBe(false);
    expect(detector.sample(-120, 0, 20)).toBe(false);
    expect(detector.sample(0, 0, 100)).toBe(false);
    expect(detector.sample(NaN, 0, 110)).toBe(false);
    expect(detector.sample(120, 0, 120)).toBe(false);
    expect(detector.sample(0, 0, 170)).toBe(false);
  });

  it("clears accumulated motion after triggering and when explicitly reset", () => {
    const detector = createDizzyDetector();
    expect([0, 120, 0, 120, 0].map((x, i) => detector.sample(x, 0, i * 50))).toEqual([false, false, false, true, false]);
    expect(detector.sample(120, 0, 250)).toBe(false);
    expect(detector.sample(0, 0, 300)).toBe(false);
    detector.reset();
    expect(detector.sample(120, 0, 350)).toBe(false);
    expect(detector.sample(0, 0, 400)).toBe(false);
  });
});
