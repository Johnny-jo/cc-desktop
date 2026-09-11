export type StellarKind = "red-dwarf" | "white-dwarf" | "sunlike" | "red-giant" | "blue-star";

/** Apparent point sizes, not physical radii: even giants are unresolved here. */
export const STELLAR_PALETTE = {
  "red-dwarf": { hue: 18, saturation: 55, lightness: 64, size: 0.38, alpha: 0.065 },
  "white-dwarf": { hue: 212, saturation: 5, lightness: 96, size: 0.7, alpha: 0.34 },
  sunlike: { hue: 43, saturation: 75, lightness: 77, size: 0.7, alpha: 0.3 },
  "red-giant": { hue: 12, saturation: 68, lightness: 73, size: 0.85, alpha: 0.36 },
  "blue-star": { hue: 215, saturation: 62, lightness: 82, size: 0.8, alpha: 0.34 },
} satisfies Record<StellarKind, object>;

/** Stable stars in a rotating spiral density wave, independent of frame rate. */
export type GalaxyParticle = {
  kind: StellarKind;
  /** Artistic violet halo around a small subset of hot blue stars. */
  violetHalo: boolean;
  radius: number;
  angle: number;
  speed: number;
  jitter: number;
  size: number;
  alpha: number;
  hue: number;
  phase: number;
  height: number;
  /** -1 is the central star cluster; 0 and 1 are the two spiral arms. */
  arm: number;
};

const TAU = Math.PI * 2;
export const PATTERN_SPEED = 0.105;
export const INCLINATION_COS = 0.59;
const INCLINATION_SIN = Math.sqrt(1 - INCLINATION_COS ** 2);
export const POSITION_ANGLE = -0.32;

function smoothUnit(value: number): number {
  const unit = Math.min(1, Math.max(0, value));
  return unit ** 3 * (unit * (unit * 6 - 15) + 10);
}

/** Camera in CSS pixels: approach the wordmark galaxy off-centre, then roam. */
export function galaxyCameraAt(
  seconds: number,
  width: number,
  height: number,
  origin: { x: number; y: number },
  glyphRadius = 32,
): { x: number; y: number; radius: number; journey: number; approach: number } {
  const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const paneWidth = Number.isFinite(width) ? Math.max(1, width) : 1;
  const paneHeight = Number.isFinite(height) ? Math.max(1, height) : 1;
  const startX = Number.isFinite(origin.x) ? origin.x : paneWidth / 2;
  const startY = Number.isFinite(origin.y) ? origin.y : paneHeight / 2;
  const shortEdge = Math.min(paneWidth, paneHeight);
  const validGlyphRadius = Number.isFinite(glyphRadius) && glyphRadius > 0 ? glyphRadius : 32;
  const initialRadius = Math.min(validGlyphRadius, shortEdge * 0.16);
  const fullRadius = Math.hypot(paneWidth, paneHeight) * 1.4;
  const approach = smoothUnit(time / 34);
  // Projected size is inverse distance. Ease in log distance to avoid spending
  // almost the entire approach as a dot followed by a sudden enormous zoom.
  const depth = (fullRadius / initialRadius) ** (1 - approach);
  const radius = fullRadius / depth;
  // Offset and size share one projection: stars expand from a fixed vanishing
  // point as the camera approaches an off-centre part of the disc. There is no
  // separate translation that would make the galaxy appear to fly across UI.
  const journey = (radius - initialRadius) / (fullRadius - initialRadius);
  const roamTime = Math.max(0, time - 34);
  const roam = smoothUnit(roamTime / 12);
  return {
    x: startX + (paneWidth * 0.96 - startX) * journey
      + paneWidth * 0.012 * Math.sin(roamTime * 0.06) * roam,
    y: startY + (paneHeight * 0.07 - startY) * journey
      + paneHeight * 0.014 * Math.sin(roamTime * 0.045) * roam,
    radius: radius * (1 + Math.sin(roamTime * 0.035) * 0.012 * roam),
    journey,
    approach,
  };
}

export function spiralAngle(radius: number): number {
  return -1.3 + 3.05 * Math.log1p(radius * 4.5);
}

export function createGalaxyParticles(count: number): GalaxyParticle[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  let seed = 0x41a9e17;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  // A bounded bell-shaped sample avoids unusually remote outliers.
  const scatter = () => (random() + random() + random() - 1.5) / 1.5;
  return Array.from({ length: Math.floor(count) }, () => {
    const core = random() < 0.32;
    const arm = core ? -1 : random() < 0.5 ? 0 : 1;
    // The central SMBH's horizon is subpixel at galactic scale. Populate its
    // surrounding nuclear cluster instead of carving out a visible black disc.
    const radius = core
      ? 0.0004 + 0.275 * random() ** 1.65
      : 0.065 + 0.875 * random() ** 0.88;
    // Continuous scatter avoids regularly spaced, overexposed knots on the arms.
    const jitter = scatter() * (0.2 + radius * 0.42);
    const population = random();
    // Visual mix: white first, yellow second, with isolated red/blue accents.
    const kind: StellarKind = population < 0.7 ? "white-dwarf"
      : population < 0.92 ? "sunlike"
      : population < 0.96 ? "red-dwarf"
      : population < 0.98 ? "red-giant" : "blue-star";
    const palette = STELLAR_PALETTE[kind];
    const violetHalo = kind === "blue-star" && random() < 0.12;
    const phase = random() * TAU;
    return {
      kind,
      violetHalo,
      radius,
      angle: core ? random() * TAU : spiralAngle(radius) + arm * Math.PI + jitter,
      speed: 0.12 + 0.32 / (0.22 + radius),
      jitter,
      size: palette.size * (0.75 + random() ** 2 * 0.9),
      alpha: Math.min(1, palette.alpha * (0.65 + random() * 0.8)),
      hue: palette.hue + (random() - 0.5) * 12,
      phase,
      height: scatter() * (core ? 0.048 : 0.02) * (1 - radius * 0.55),
      arm,
    };
  });
}

export function galaxyParticlePosition(
  particle: GalaxyParticle,
  timeSeconds: number,
): { x: number; y: number; depth: number } {
  const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
  const orbit = time * particle.speed + particle.phase;
  // Epicyclic motion lets individual stars drift at different rates without
  // winding the two arms into a featureless disc after a few seconds.
  const radius = particle.radius + Math.sin(orbit) * 0.016 * particle.radius;
  const angle = particle.arm < 0
    ? particle.angle + time * particle.speed * 0.34
    : particle.angle + time * PATTERN_SPEED
      + spiralAngle(radius) - spiralAngle(particle.radius)
      + Math.sin(orbit * 0.73) * (0.035 + particle.radius * 0.045);
  const discX = Math.cos(angle) * radius;
  const discY = Math.sin(angle) * radius;
  const height = particle.height + Math.sin(orbit * 0.61) * 0.004;
  const projectedY = discY * INCLINATION_COS - height * INCLINATION_SIN;
  return {
    x: discX * Math.cos(POSITION_ANGLE) - projectedY * Math.sin(POSITION_ANGLE),
    y: discX * Math.sin(POSITION_ANGLE) + projectedY * Math.cos(POSITION_ANGLE),
    depth: discY * INCLINATION_SIN + height * INCLINATION_COS,
  };
}
