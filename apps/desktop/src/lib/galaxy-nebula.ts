import { spiralAngle } from "./galaxy-particles";

// Smooth, deterministic density: generated once, never re-seeded during animation.
function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const hash = (a: number, b: number) => {
    let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const a = hash(ix, iy), b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** CPU approximation for star attenuation and the software rendering fallback. */
export function galaxyMediumAt(x: number, y: number) {
  const radius = Math.hypot(x, y);
  const coarse = noise(x * 14 + 31, y * 14 + 53);
  const detail = noise(x * 110, y * 110);
  const filaments = noise(x * 240 + 11, y * 240 + 7);
  const clouds = coarse * 0.4 + noise(x * 39 + 17, y * 39 + 27) * 0.35
    + detail * 0.25;
  const angle = Math.atan2(y, x) - spiralAngle(radius);
  const warped = angle + (coarse - 0.5) * 0.7 + (detail - 0.5) * 0.12;
  const arm = Math.exp(-((Math.sin(warped) / (0.17 + clouds * 0.19)) ** 2));
  const dustLane = Math.exp(-((Math.sin(warped + 0.17 + (detail - 0.5) * 0.16) / (0.04 + clouds * 0.1)) ** 2));
  const edge = Math.max(0, Math.min(1, (1 - radius) / 0.22));
  const dust = dustLane * Math.min(1, (radius / 0.18) ** 2)
    * Math.max(0, Math.min(1, (clouds - 0.28) * 2.8)) * (0.4 + filaments * 0.6) * edge;
  const transmission = Math.exp(-dust * 2.1);
  const bulge = Math.exp(-((radius / 0.115) ** 0.85));
  const disc = Math.exp(-radius * 3.1) * 0.045;
  const wisps = arm * (0.025 + clouds ** 3 * 1.2) * (0.55 + filaments * 0.9) * Math.exp(-radius * 1.5);
  return {
    light: (bulge * 0.68 * (0.85 + clouds * 0.3) + disc + wisps) * transmission * edge,
    warmth: Math.min(1, bulge * 1.8 + 0.1),
    transmission,
  };
}

let cachedTexture: HTMLCanvasElement | undefined;

/** Cache the unresolved starlight and dust, while resolved stars remain live. */
export function createGalaxyNebula(): HTMLCanvasElement {
  if (cachedTexture) return cachedTexture;
  const texture = document.createElement("canvas");
  const size = 1024;
  texture.width = texture.height = size;
  const context = texture.getContext("2d")!;
  const pixels = context.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const medium = galaxyMediumAt((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
      const i = (y * size + x) * 4;
      pixels.data[i] = 179 + medium.warmth * 76;
      pixels.data[i + 1] = 192 + medium.warmth * 39;
      pixels.data[i + 2] = 215 - medium.warmth * 20;
      pixels.data[i + 3] = Math.round(Math.min(1, medium.light) * 255);
    }
  }
  context.putImageData(pixels, 0, 0);
  cachedTexture = texture;
  return texture;
}
