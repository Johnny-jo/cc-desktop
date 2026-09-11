import { afterEach, describe, expect, it, vi } from "vitest";
import { attachGalaxyCanvas } from "./galaxy-canvas";
import * as particles from "./galaxy-particles";

// Pixel appearance is verified with the real browser canvas; keep lifecycle tests small.
vi.mock("./galaxy-nebula-renderer", () => ({
  createGalaxyNebulaRenderer: () => ({ draw() {}, dispose() {} }),
}));

class TestElement extends EventTarget {
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  properties = new Map<string, string>();
  style = {
    setProperty: (name: string, value: string) => { this.properties.set(name, value); },
    getPropertyValue: (name: string) => this.properties.get(name) ?? "",
    removeProperty: (name: string) => this.properties.delete(name),
  };
  classList = {
    toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name),
    remove: (name: string) => this.classes.delete(name),
  };
  getBoundingClientRect() { return { left: 0, top: 0, width: 20, height: 30 }; }
  closest() { return null; }
  removeAttribute(name: string) {
    if (name === "data-galaxy-active") delete this.dataset.galaxyActive;
  }
}

class TestObserver {
  static all: TestObserver[] = [];
  disconnected = false;
  constructor(private notify: () => void) { TestObserver.all.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
  flush() { if (!this.disconnected) this.notify(); }
}

function drawingContext() {
  return {
    setTransform() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    clearRect: vi.fn(),
    fillRect() {},
    drawImage() {},
    beginPath() {},
    arc() {},
    fill() {},
    createRadialGradient: () => ({ addColorStop() {} }),
  };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TestObserver.all = [];
});

function mount({ theme = "dark", reduced = false } = {}) {
  // Rendering math has its own tests; one real particle is enough to exercise the scheduler.
  const oneStar = particles.createGalaxyParticles(1);
  vi.spyOn(particles, "createGalaxyParticles").mockReturnValue(oneStar);
  const camera = vi.spyOn(particles, "galaxyCameraAt");
  const root = new TestElement();
  const glyph = new TestElement();
  const panel = new TestElement();
  const page = new TestElement();
  page.dataset.theme = theme;
  const context = drawingContext();
  const canvas = Object.assign(new TestElement(), { width: 800, height: 600, getContext: () => context });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  const reducedMotion = Object.assign(new EventTarget(), { matches: reduced });
  const systemLight = Object.assign(new EventTarget(), { matches: false });
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    documentElement: page,
    createElement: () => ({ width: 0, height: 0, getContext: () => drawingContext() }),
  });
  const window = Object.assign(new EventTarget(), {
    devicePixelRatio: 1,
    matchMedia: (query: string) => query.includes("reduced-motion") ? reducedMotion : systemLight,
  });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  let now = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
  vi.stubGlobal("getComputedStyle", () => ({ fontWeight: "650", fontSize: "64px", fontFamily: "sans-serif" }));
  vi.stubGlobal("ResizeObserver", TestObserver);
  vi.stubGlobal("MutationObserver", TestObserver);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  cleanup = attachGalaxyCanvas(
    root as unknown as HTMLElement,
    canvas as unknown as HTMLCanvasElement,
    glyph as unknown as HTMLElement,
    panel as unknown as HTMLElement,
  );
  const step = (milliseconds = 100) => {
    now += milliseconds;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  };
  const cameraTime = () => camera.mock.lastCall?.[0];
  const setTheme = (value: string) => {
    page.dataset.theme = value;
    TestObserver.all.at(-1)?.flush();
  };
  return { root, panel, document, window, context, reducedMotion, systemLight, frames, step, camera, cameraTime, setTheme };
}

describe("galaxy canvas lifecycle", () => {
  it("draws the galaxy immediately at night and hides the original S before the first frame", () => {
    const s = mount();
    expect(s.cameraTime()).toBe(0);
    expect(s.root.style.getPropertyValue("--galaxy-letter-opacity")).toBe("0");
    expect(s.panel.classes.has("has-galaxy")).toBe(true);
    expect(s.frames.size).toBe(1);
  });

  it.each([
    { theme: "light", reduced: false },
    { theme: "dark", reduced: true },
  ])("does not schedule particles for $theme mode with reduced=$reduced", (options) => {
    const s = mount(options);
    expect(s.frames.size).toBe(0);
    expect(s.panel.classes.has("has-galaxy")).toBe(false);
    s.step(60_000);
    expect(s.camera).not.toHaveBeenCalled();
  });

  it("stops immediately when theme or reduced-motion preference disables the scene", () => {
    const s = mount();
    s.step();
    expect(s.frames.size).toBe(1);
    s.setTheme("light");
    expect(s.frames.size).toBe(0);
    expect(s.root.dataset.galaxyActive).toBe("false");
    s.setTheme("dark");
    expect(s.frames.size).toBe(1);
    s.reducedMotion.matches = true;
    s.reducedMotion.dispatchEvent(new Event("change"));
    expect(s.frames.size).toBe(0);
    expect(s.panel.classes.has("has-galaxy")).toBe(false);
  });

  it("pauses while hidden and resumes the same camera progress without counting background time", () => {
    const s = mount();
    for (let i = 0; i < 40; i++) s.step();
    const progress = s.cameraTime();
    expect(progress).toBeGreaterThan(3);
    s.document.hidden = true;
    s.document.dispatchEvent(new Event("visibilitychange"));
    expect(s.frames.size).toBe(0);
    s.camera.mockClear();
    s.step(60_000);
    expect(s.camera).not.toHaveBeenCalled();
    s.document.hidden = false;
    s.document.dispatchEvent(new Event("visibilitychange"));
    s.step();
    expect(s.cameraTime()).toBe(progress);
    s.step();
    expect(s.cameraTime()).toBeCloseTo(progress! + 0.1);
  });

  it("keeps the camera running independently of wordmark clicks, typing and window focus", () => {
    const s = mount();
    for (let i = 0; i < 40; i++) s.step();
    const progress = s.cameraTime();
    const pendingFrame = [...s.frames.keys()];
    s.root.dispatchEvent(new Event("click"));
    s.panel.dispatchEvent(new Event("click"));
    s.panel.dispatchEvent(new Event("input"));
    s.window.dispatchEvent(new Event("blur"));
    expect([...s.frames.keys()]).toEqual(pendingFrame);
    s.step();
    expect(s.cameraTime()).toBeCloseTo(progress! + 0.1);
  });

  it("cancels pending work and releases event listeners, observers and glyph styling on disposal", () => {
    const s = mount();
    s.step();
    cleanup?.();
    cleanup = undefined;
    expect(s.frames.size).toBe(0);
    expect(s.panel.classes.has("has-galaxy")).toBe(false);
    expect(s.root.dataset.galaxyActive).toBeUndefined();
    expect(s.root.style.getPropertyValue("--galaxy-letter-opacity")).toBe("");
    expect(TestObserver.all.every((observer) => observer.disconnected)).toBe(true);
    s.context.clearRect.mockClear();
    s.document.dispatchEvent(new Event("visibilitychange"));
    s.window.dispatchEvent(new Event("resize"));
    s.reducedMotion.dispatchEvent(new Event("change"));
    s.systemLight.dispatchEvent(new Event("change"));
    s.setTheme("light");
    expect(s.frames.size).toBe(0);
    expect(s.context.clearRect).not.toHaveBeenCalled();
    expect(s.root.dataset.galaxyActive).toBeUndefined();
  });
});
