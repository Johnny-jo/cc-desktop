type PlanetKind = "rocky" | "gas" | "ice";
const PLANETS = [
  { kind: "rocky", x: 0.13, y: 0.68, size: 0.032, depth: 0.8, phase: 0.6 },
  { kind: "gas", x: 0.83, y: 0.54, size: 0.054, depth: 1.3, phase: 2.2 },
  { kind: "ice", x: 0.65, y: 0.86, size: 0.022, depth: 0.55, phase: 4.1 },
] as const;

/** A separate cinematic foreground distance layer, not galaxy-scale planets. */
export function foregroundPlanetsAt(seconds: number, journey: number, width: number, height: number) {
  const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const progress = Math.max(0, Math.min(1, (journey - 0.24) / 0.76));
  const reveal = progress * progress * (3 - 2 * progress);
  const scale = Math.min(width, height, 1000);
  return PLANETS.map(planet => ({
    kind: planet.kind,
    x: width * (planet.x + Math.sin(time * 0.018 + planet.phase) * 0.025 * planet.depth * reveal),
    y: height * (planet.y + Math.cos(time * 0.014 + planet.phase) * 0.018 * planet.depth * reveal),
    radius: scale * planet.size * (0.35 + reveal * 0.65),
    opacity: reveal * 0.94,
  }));
}

function surfaceNoise(x: number, y: number, z: number) {
  return Math.sin(x * 11 + Math.sin(z * 13) * 2 + y * 7) * 0.5
    + Math.sin(y * 27 + Math.sin(x * 19) + z * 23) * 0.25
    + Math.sin(z * 61 + y * 49 + x * 37) * 0.125;
}

/** Bake detailed spherical surfaces once, with a lit limb and a dark night side. */
function planetTexture(kind: PlanetKind): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 192;
  const context = canvas.getContext("2d")!;
  const pixels = context.createImageData(192, 192);
  for (let row = 0; row < 192; row++) {
    for (let col = 0; col < 192; col++) {
      const x = (col + 0.5 - 96) / 91;
      const y = (row + 0.5 - 96) / 91;
      const r = Math.hypot(x, y);
      const index = (row * 192 + col) * 4;
      const atmosphere = kind === "rocky" ? [224, 150, 96] : kind === "gas" ? [183, 183, 237] : [113, 207, 248];
      if (r > 1) {
        const rim = Math.max(0, 1 - (r - 1) / 0.035);
        pixels.data.set([...atmosphere, Math.round(rim * rim * 65)], index);
        continue;
      }
      const z = Math.sqrt(1 - r * r);
      const longitude = Math.atan2(x, z);
      const latitude = Math.asin(y);
      const terrain = surfaceNoise(x, y, z);
      let base: number[];
      if (kind === "gas") {
        const bands = Math.sin(latitude * 36 + Math.sin(longitude * 7 + latitude * 9) * 0.7 + terrain * 0.6);
        const streaks = Math.sin(latitude * 113 + terrain * 2) * 0.1;
        const band = bands * 0.5 + 0.5 + streaks;
        const storm = Math.exp(-((longitude + 0.3) ** 2 * 65 + (latitude - 0.2) ** 2 * 480));
        base = [145 + band * 65 + storm * 30, 116 + band * 64 - storm * 22, 101 + band * 54 - storm * 20];
      } else if (kind === "ice") {
        const frost = Math.max(0, terrain + Math.abs(y) * 0.35);
        base = [69 + frost * 116, 140 + frost * 83, 178 + frost * 65];
      } else {
        const stone = terrain * 0.5 + 0.5;
        const ridges = Math.exp(-Math.abs(terrain - 0.12) * 25);
        base = [108 + stone * 74 + ridges * 13, 66 + stone * 54, 44 + stone * 38];
      }
      const sunlight = Math.max(0, -x * 0.64 - y * 0.48 + z * 0.6);
      const illumination = 0.045 + sunlight * 0.955;
      const rim = (1 - z) ** 5 * Math.max(0, sunlight) * 0.65;
      for (let channel = 0; channel < 3; channel++) {
        pixels.data[index + channel] = Math.min(255, base[channel] * illumination + atmosphere[channel] * rim);
      }
      pixels.data[index + 3] = Math.round(Math.min(1, (1 - r) * 91) * 255);
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

/** Lazy, bounded texture cache; only drawImage and ring paths run each frame. */
export function createGalaxyPlanetRenderer() {
  const textures = new Map<PlanetKind, HTMLCanvasElement>();
  const rings = (context: CanvasRenderingContext2D, front: boolean) => {
    for (let band = 0; band < 10; band++) {
      const radius = 1.38 + band * 0.064;
      context.beginPath();
      context.ellipse(0, 0, radius, radius * 0.32, -0.38,
        front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
      context.lineWidth = band === 5 ? 0.012 : 0.047;
      context.strokeStyle = `rgba(197,177,149,${band === 5 ? 0.15 : 0.48 - band * 0.024})`;
      context.stroke();
    }
  };
  return {
    draw(context: CanvasRenderingContext2D, seconds: number, journey: number, width: number, height: number) {
      for (const planet of foregroundPlanetsAt(seconds, journey, width, height)) {
        if (planet.opacity < 0.002) continue;
        let texture = textures.get(planet.kind);
        if (!texture) { texture = planetTexture(planet.kind); textures.set(planet.kind, texture); }
        context.save();
        // Planets occlude distant light; additive blending would erase the night side.
        context.globalCompositeOperation = "source-over";
        context.globalAlpha = planet.opacity;
        context.translate(planet.x, planet.y);
        context.scale(planet.radius, planet.radius);
        if (planet.kind === "gas") rings(context, false);
        const extent = 96 / 91;
        context.drawImage(texture, -extent, -extent, extent * 2, extent * 2);
        if (planet.kind === "gas") rings(context, true);
        context.restore();
      }
    },
    dispose() { textures.clear(); },
  };
}
