import { describe, expect, it } from "vitest";
import { createGalaxyParticles, galaxyCameraAt, galaxyParticlePosition } from "./galaxy-particles";

describe("galaxy camera", () => {
  const width = 1000;
  const height = 700;
  const origin = { x: 570, y: 310 };

  it("starts at wordmark size and finishes closer to the visible upper-right core", () => {
    expect(galaxyCameraAt(0, width, height, origin)).toEqual({ ...origin, radius: 32, journey: 0, approach: 0 });
    const arrived = galaxyCameraAt(34, width, height, origin);
    expect(arrived.x).toBeCloseTo(width * 0.96);
    expect(arrived.y).toBeCloseTo(height * 0.07);
    expect(arrived.radius).toBeCloseTo(Math.hypot(width, height) * 1.4);
    expect(arrived.journey).toBe(1);
  });

  it("matches the requested glyph radius without moving its starting position", () => {
    for (const glyphRadius of [21, 30, 42]) {
      const camera = galaxyCameraAt(0, width, height, origin, glyphRadius);
      expect(camera.radius).toBeCloseTo(glyphRadius);
      expect(camera.x).toBeCloseTo(origin.x);
      expect(camera.y).toBeCloseTo(origin.y);
    }
    for (const glyphRadius of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(galaxyCameraAt(0, width, height, origin, glyphRadius).radius).toBeCloseTo(32);
    }
  });

  it("binds every change of centre to enlargement instead of flying separately", () => {
    const first = galaxyCameraAt(0, width, height, origin);
    const last = galaxyCameraAt(34, width, height, origin);
    let previous = first;
    for (let time = 0.25; time <= 34; time += 0.25) {
      const current = galaxyCameraAt(time, width, height, origin);
      expect(current.radius).toBeGreaterThan(previous.radius);
      expect(current.journey).toBeGreaterThanOrEqual(previous.journey);
      const enlargement = (current.radius - first.radius) / (last.radius - first.radius);
      expect((current.x - first.x) / (last.x - first.x)).toBeCloseTo(enlargement, 10);
      expect((current.y - first.y) / (last.y - first.y)).toBeCloseTo(enlargement, 10);
      expect(current.journey).toBeCloseTo(enlargement, 10);
      previous = current;
    }
  });

  it("joins the slow roam without a jump or velocity spike", () => {
    const before = galaxyCameraAt(34 - 0.001, width, height, origin);
    const after = galaxyCameraAt(34 + 0.001, width, height, origin);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(0.001);
    expect(Math.abs(after.radius - before.radius)).toBeLessThan(0.001);
  });

  it("keeps the dense core just inside the upper-right corner during a bounded roam", () => {
    const first = galaxyCameraAt(34, width, height, origin);
    expect(galaxyCameraAt(55, width, height, origin)).not.toEqual(first);
    for (const time of [35, 50, 120, 600, 3600, 36000]) {
      const camera = galaxyCameraAt(time, width, height, origin);
      expect(camera.x).toBeGreaterThan(width * 0.94);
      expect(camera.x).toBeLessThan(width * 0.98);
      expect(camera.y).toBeGreaterThan(height * 0.05);
      expect(camera.y).toBeLessThan(height * 0.09);
      expect(camera.radius / Math.hypot(width, height)).toBeGreaterThan(1.35);
      expect(camera.radius / Math.hypot(width, height)).toBeLessThan(1.45);
      expect(camera.journey).toBe(1);
    }
  });

  it("scales the initial galaxy for small panes and remains finite before layout", () => {
    expect(galaxyCameraAt(0, 160, 100, { x: 80, y: 50 }, 42).radius).toBeCloseTo(16);
    expect(galaxyCameraAt(-4, width, height, origin)).toEqual(galaxyCameraAt(0, width, height, origin));
    for (const time of [0, 5, 10, 34, 100]) {
      const camera = galaxyCameraAt(time, 0, Number.NaN, { x: Number.NaN, y: Number.NaN });
      expect(Object.values(camera).every(Number.isFinite)).toBe(true);
      expect(camera.radius).toBeGreaterThan(0);
    }
  });
});

describe("galaxy particles", () => {
  it("uses the same stars when a scene is recreated or its quality is changed", () => {
    const stars = createGalaxyParticles(80);
    expect(createGalaxyParticles(80)).toEqual(stars);
    expect(createGalaxyParticles(120).slice(0, 80)).toEqual(stars);
    expect(createGalaxyParticles(0)).toEqual([]);
    expect(createGalaxyParticles(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("keeps a dense centre, a tiny dark core, and two populated arms", () => {
    const stars = createGalaxyParticles(2000);
    expect(stars.filter((star) => star.radius < 0.3).length).toBeGreaterThan(750);
    expect(stars.filter((star) => star.arm === -1).length).toBeGreaterThan(580);
    expect(stars.every((star) => star.radius >= 0.028)).toBe(true);
    expect(stars.filter((star) => star.arm === 0).length).toBeGreaterThan(600);
    expect(stars.filter((star) => star.arm === 1).length).toBeGreaterThan(600);
    expect(stars.some((star) => star.radius > 0.85)).toBe(true);
  });

  it("stays finite and inside a stable drawing area over long runtimes", () => {
    const stars = createGalaxyParticles(500);
    for (const time of [0, 1, 5, 60, 600, 36000]) {
      for (const star of stars) {
        const position = galaxyParticlePosition(star, time);
        for (const coordinate of Object.values(position)) {
          expect(Number.isFinite(coordinate)).toBe(true);
          expect(Math.abs(coordinate)).toBeLessThan(1);
        }
      }
    }
  });

  it("moves every star with time rather than rotating a static image", () => {
    const stars = createGalaxyParticles(50);
    for (const star of stars) {
      const start = galaxyParticlePosition(star, 0);
      const later = galaxyParticlePosition(star, 2);
      expect(Math.hypot(later.x - start.x, later.y - start.y)).toBeGreaterThan(0.001);
      // The varying depth is used by the renderer as stars cross the disc.
      expect(later.depth).not.toBe(start.depth);
    }
    expect(galaxyParticlePosition(stars[0], 5)).toEqual(galaxyParticlePosition(stars[0], 5));
  });

  it("preserves spiral density after many rotations", () => {
    const stars = createGalaxyParticles(500).filter((star) => star.arm >= 0);
    const cos = Math.cos(-0.32);
    const sin = Math.sin(-0.32);
    const inclinationSin = Math.sqrt(1 - 0.59 ** 2);
    for (const time of [0, 5, 120, 3600]) {
      for (const star of stars) {
        const position = galaxyParticlePosition(star, time);
        const discX = position.x * cos + position.y * sin;
        const projectedY = -position.x * sin + position.y * cos;
        const discY = projectedY * 0.59 + position.depth * inclinationSin;
        const actualAngle = Math.atan2(discY, discX);
        const armAngle = star.angle + time * 0.105;
        const difference = Math.atan2(Math.sin(actualAngle - armAngle), Math.cos(actualAngle - armAngle));
        expect(Math.abs(difference)).toBeLessThan(0.13);
      }
    }
  });
});
