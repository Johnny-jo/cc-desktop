import { describe, expect, it } from "vitest";
import { createPhotoFlowMotion, createPhotoFlowPath, photoFlowImageIndex } from "./photo-flow";

it("cycles the full photo collection through fewer slots in either direction", () => {
  for (const slots of [8, 10, 13]) {
    const seen = new Set<number>();
    for (let cycle = -3; cycle <= 3; cycle++) {
      for (let slot = 0; slot < slots; slot++) {
        const index = photoFlowImageIndex(slot, cycle, slots, 16);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(16);
        seen.add(index);
      }
    }
    expect(seen.size).toBe(16);
  }
});

describe("photo ribbon motion", () => {
  it("eases into wheel input and settles instead of jumping on the first frame", () => {
    const motion = createPhotoFlowMotion();
    motion.push(120);
    const steps = Array.from({ length: 240 }, () => motion.step(1 / 60, false));
    expect(steps[0]).toBeGreaterThan(0);
    expect(steps[0]).toBeLessThan(0.2);
    expect(Math.max(...steps)).toBeGreaterThan(steps[0] * 3);
    expect(steps.reduce((sum, step) => sum + step, 0)).toBeLessThan(45);
    expect(steps.at(-1)).toBeLessThan(0.001);
  });

  it("caps a burst from a high-resolution wheel and can reverse direction", () => {
    const motion = createPhotoFlowMotion();
    const steps = Array.from({ length: 120 }, () => {
      motion.push(2000);
      return motion.step(1 / 60, true);
    });
    expect(Math.max(...steps)).toBeLessThan(190 / 60);
    for (let i = 0; i < 90; i++) { motion.push(-120); motion.step(1 / 60, true); }
    expect(motion.step(1 / 60, true)).toBeLessThan(0);
  });

  it("returns to a slow drift after manual input and resets when paused", () => {
    const motion = createPhotoFlowMotion();
    motion.push(-120);
    for (let i = 0; i < 480; i++) motion.step(1 / 60, true);
    expect(motion.step(1 / 60, true)).toBeCloseTo(10 / 60, 3);
    motion.reset();
    expect(motion.step(1 / 60, false)).toBe(0);
    expect(motion.moving()).toBe(false);
  });

  it("keeps the same damping at different refresh rates", () => {
    const travel = (fps: number) => {
      const motion = createPhotoFlowMotion();
      motion.push(120);
      return Array.from({ length: fps * 3 }, () => motion.step(1 / fps, false))
        .reduce((sum, step) => sum + step, 0);
    };
    expect(Math.abs(travel(60) - travel(144))).toBeLessThan(1);
  });
});

describe("photo ribbon geometry", () => {
  it.each([[1230, 757], [640, 700], [420, 650]])("rotates continuously across curve samples in a %s by %s pane", (width, height) => {
    const path = createPhotoFlowPath(width, height);
    for (const sample of path.samples.slice(1, -1)) {
      const before = path.at(sample.distance - 0.0001);
      const after = path.at(sample.distance + 0.0001);
      expect(Math.abs(after.tilt - before.tilt)).toBeLessThan(0.001);
    }
  });

  it.each([[1230, 757], [640, 700], [420, 650]])("loops outside a %s by %s pane with even spacing", (width, height) => {
    const path = createPhotoFlowPath(width, height);
    expect(path.at(0).y).toBeLessThan(-100);
    expect(path.at(path.length - 1).y).toBeGreaterThan(height + 100);
    expect(path.at(-25)).toEqual(path.at(path.length - 25));
    for (let distance = 10; distance < path.length - 10; distance += 20) {
      const a = path.at(distance);
      const b = path.at(distance + 2);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(2, 1);
      expect(Math.abs(a.tilt)).toBeLessThanOrEqual(18);
      const opposite = path.at(path.length - distance);
      expect(a.x + opposite.x).toBeCloseTo(width, 4);
      expect(a.y + opposite.y).toBeCloseTo(height, 4);
    }
  });
});
