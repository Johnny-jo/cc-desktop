import { describe, expect, it } from "vitest";
import { foregroundPlanetsAt } from "./galaxy-planets";

describe("foreground planets", () => {
  it("resolves varied planets only as the camera approaches", () => {
    const distant = foregroundPlanetsAt(0, 0, 1000, 700);
    expect(distant.every(planet => planet.opacity === 0)).toBe(true);
    const close = foregroundPlanetsAt(40, 1, 1000, 700);
    expect(new Set(close.map(planet => planet.kind))).toEqual(new Set(["rocky", "gas", "ice"]));
    expect(close.every(planet => planet.opacity > 0.8 && planet.radius > 10)).toBe(true);
    expect(Math.max(...close.map(planet => planet.radius)) / Math.min(...close.map(planet => planet.radius))).toBeGreaterThan(2);
    const emerging = foregroundPlanetsAt(20, 0.5, 1000, 700);
    expect(emerging.every((planet, index) => planet.opacity > 0 && planet.opacity < close[index].opacity)).toBe(true);
  });

  it("keeps parallax continuous, deterministic and bounded through long sessions and resizes", () => {
    const first = foregroundPlanetsAt(40, 1, 1000, 700);
    expect(foregroundPlanetsAt(40, 1, 1000, 700)).toEqual(first);
    const next = foregroundPlanetsAt(40.001, 1, 1000, 700);
    expect(next.every((planet, index) => Math.hypot(planet.x - first[index].x, planet.y - first[index].y) < 0.01)).toBe(true);
    expect(foregroundPlanetsAt(120, 1, 1000, 700)).not.toEqual(first);
    for (const [width, height] of [[1000, 700], [320, 480], [2400, 1600]]) {
      for (const seconds of [0, 34, 120, 36000]) {
        for (const planet of foregroundPlanetsAt(seconds, 1, width, height)) {
          expect(planet.x - planet.radius).toBeGreaterThan(0);
          expect(planet.x + planet.radius).toBeLessThan(width);
          expect(planet.y - planet.radius).toBeGreaterThan(0);
          expect(planet.y + planet.radius).toBeLessThan(height);
        }
      }
    }
  });
});
