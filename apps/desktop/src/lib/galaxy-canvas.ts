import { createGalaxyParticles, galaxyParticlePosition, galaxyCameraAt, STELLAR_PALETTE } from "./galaxy-particles";
import { galaxyMediumAt } from "./galaxy-nebula";
import { createGalaxyNebulaRenderer } from "./galaxy-nebula-renderer";

type Point = { x: number; y: number };

/** Live stars replace S at night; a perspective camera approaches their spiral. */
export function attachGalaxyCanvas(root: HTMLElement, canvas: HTMLCanvasElement, glyph: HTMLElement, panel: HTMLElement) {
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) return () => {};
  const stars = createGalaxyParticles(16000);
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const systemLight = window.matchMedia("(prefers-color-scheme: light)");
  const colors = stars.map((star) => {
    const palette = STELLAR_PALETTE[star.kind];
    return `hsl(${star.hue} ${palette.saturation}% ${palette.lightness}%)`;
  });
  const extinction = stars.map((star) => star.arm < 0 ? 1 : galaxyMediumAt(
    Math.cos(star.angle) * star.radius, Math.sin(star.angle) * star.radius,
  ).transmission);
  let nebula: ReturnType<typeof createGalaxyNebulaRenderer> | undefined;
  const glows = new Map<string, HTMLCanvasElement>();
  for (const [kind, palette] of [...Object.entries(STELLAR_PALETTE), ["violet", { hue: 270, saturation: 82 }]] as const) {
    const glow = document.createElement("canvas");
    glow.width = glow.height = 64;
    const glowContext = glow.getContext("2d")!;
    const light = glowContext.createRadialGradient(32, 32, 0, 32, 32, 32);
    light.addColorStop(0, `hsl(${palette.hue} ${palette.saturation}% 83% / 0.85)`);
    light.addColorStop(0.13, `hsl(${palette.hue} ${palette.saturation}% 69% / 0.45)`);
    light.addColorStop(0.4, `hsl(${palette.hue} ${palette.saturation}% 59% / 0.1)`);
    light.addColorStop(1, `hsl(${palette.hue} ${palette.saturation}% 50% / 0)`);
    glowContext.fillStyle = light;
    glowContext.fillRect(0, 0, 64, 64);
    glows.set(kind, glow);
  }

  let center: Point = { x: 0, y: 0 };
  let width = 0;
  let height = 0;
  let fontSize = 64;
  let dpr = 1;
  let frame = 0;
  let elapsed = 0;
  let previous = 0;
  let lastDraw = 0;
  let active = false;
  let disposed = false;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const letter = glyph.getBoundingClientRect();
    const style = getComputedStyle(glyph);
    // Keep fine stars at native display resolution, including Retina/HiDPI panes.
    const nextDpr = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(8_000_000 / Math.max(1, rect.width * rect.height)));
    // Once in orbit, typing/reflow must not move or restart the independent scene.
    if (elapsed >= 8000 && rect.width === width && rect.height === height && nextDpr === dpr) return;
    width = rect.width;
    height = rect.height;
    fontSize = parseFloat(style.fontSize) || 64;
    dpr = nextDpr;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    center = {
      x: letter.left - rect.left + letter.width / 2 + fontSize * 0.14,
      y: letter.top - rect.top + letter.height * 0.54 - fontSize * 0.13,
    };
  };

  const draw = (seconds: number) => {
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.globalCompositeOperation = "lighter";
    const camera = galaxyCameraAt(seconds, width, height, center, fontSize * 1.4);
    const orbitRadius = camera.radius;
    const galaxyCenter = { x: camera.x, y: camera.y };
    nebula ??= createGalaxyNebulaRenderer();
    context.globalAlpha = 0.85;
    nebula.draw(context, { ...camera, width, height, dpr, seconds });
    // Keep the letter-sized spiral legible without overexposing its dense core.
    const resolved = Math.min(1, (orbitRadius / 260) ** 1.35);
    for (let i = 0; i < stars.length; i++) {
      const particle = stars[i];
      // Start with the upright S-shaped arms from the reference, then keep orbiting.
      const position = galaxyParticlePosition(particle, seconds + 14.42);
      const perspective = 1 + position.depth * camera.journey * 0.14;
      const x = galaxyCenter.x + position.x * orbitRadius * perspective;
      const y = galaxyCenter.y + position.y * orbitRadius * perspective;
      if (x < -70 || x > width + 70 || y < -70 || y > height + 70) continue;
      const twinkle = 0.97 + Math.sin(seconds * 0.6 + particle.phase) * 0.03;
      const alpha = particle.alpha * twinkle * (0.7 + position.depth * 0.12) * resolved
        * (0.2 + extinction[i] * 0.8);
      const size = Math.max(0.35, particle.size * Math.min(1.4, fontSize / 60) * (0.55 + camera.journey * 0.55));
      const glow = glows.get(particle.violetHalo ? "violet" : particle.kind)!;
      // Only luminous stars get broad, color-matched halos. Most stay small and dim.
      if (particle.kind === "red-giant" || particle.kind === "blue-star") {
        const spread = size * (particle.violetHalo ? 6 : 5);
        context.globalAlpha = alpha * 0.3;
        context.drawImage(glow, x - spread / 2, y - spread / 2, spread, spread);
      }
      context.globalAlpha = Math.min(1, alpha);
      context.fillStyle = colors[i];
      context.fillRect(x - size / 2, y - size / 2, size, size);
      if (size > 1.2) {
        context.globalAlpha = alpha * 0.45;
        context.drawImage(glow, x - size * 2, y - size * 2, size * 4, size * 4);
        if (alpha > 0.5 && i % 11 === 0) {
          context.globalAlpha = alpha * 0.32;
          context.fillRect(x - size * 1.8, y - 0.25, size * 3.6, 0.5);
          context.fillRect(x - 0.25, y - size * 1.8, 0.5, size * 3.6);
        }
      }
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  };

  const tick = (now: number) => {
    if (disposed || !active || document.hidden) return;
    elapsed += previous ? Math.min(now - previous, 100) : 0;
    previous = now;
    if (now - lastDraw >= 1000 / 30) {
      draw(elapsed / 1000);
      lastDraw = now;
    }
    frame = requestAnimationFrame(tick);
  };
  const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
  const refresh = () => {
    stop();
    const theme = document.documentElement.dataset.theme;
    const night = theme === "dark" || (theme !== "light" && !systemLight.matches);
    const next = night && !reduced.matches;
    if (next !== active) {
      elapsed = 0;
      lastDraw = 0;
      root.style.setProperty("--galaxy-letter-opacity", "1");
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    active = next;
    root.dataset.galaxyActive = String(active);
    root.style.setProperty("--galaxy-letter-opacity", active ? "0" : "1");
    panel.classList.toggle("has-galaxy", active);
    if (active && !document.hidden) {
      draw(elapsed / 1000);
      frame = requestAnimationFrame(tick);
    }
  };
  resize();
  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(panel);
  sizeObserver.observe(root);
  const composer = glyph.closest(".chat-composer");
  if (composer) sizeObserver.observe(composer);
  const themeObserver = new MutationObserver(refresh);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("resize", resize);
  reduced.addEventListener("change", refresh);
  systemLight.addEventListener("change", refresh);
  refresh();
  return () => {
    disposed = true;
    stop();
    nebula?.dispose();
    sizeObserver.disconnect();
    themeObserver.disconnect();
    document.removeEventListener("visibilitychange", refresh);
    window.removeEventListener("resize", resize);
    reduced.removeEventListener("change", refresh);
    systemLight.removeEventListener("change", refresh);
    root.removeAttribute("data-galaxy-active");
    panel.classList.remove("has-galaxy");
    root.style.removeProperty("--galaxy-letter-opacity");
    context.clearRect(0, 0, canvas.width, canvas.height);
  };
}
