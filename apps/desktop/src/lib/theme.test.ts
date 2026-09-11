import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function surface(reduced = false) {
  const classes = new Set<string>();
  const root = {
    dataset: { theme: "dark" },
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
  };
  vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600, matchMedia: () => ({ matches: reduced }) });
  const updates: Array<() => void> = [];
  const transitions: Array<{ ready: Promise<void>; finished: Promise<void>; skipTransition: ReturnType<typeof vi.fn>; finish: () => void }> = [];
  const doc = { documentElement: root, startViewTransition: vi.fn((update: () => void) => {
    updates.push(update);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const transition = { ready: Promise.resolve(), finished, skipTransition: vi.fn(), finish };
    transitions.push(transition);
    return transition;
  }) };
  vi.stubGlobal("document", doc);
  return { root, classes, doc, updates, transitions };
}

it("reveals to the full window diagonal and releases the snapshot styling", async () => {
  const s = surface();
  const { applyTheme } = await import("./theme");
  applyTheme("light");
  expect(s.root.style.setProperty).toHaveBeenCalledWith("--theme-reveal-radius", "1000px");
  expect(s.classes.has("theme-reveal")).toBe(true);
  s.updates[0]();
  expect(s.root.dataset.theme).toBe("light");
  s.transitions[0].finish();
  await s.transitions[0].finished;
  await Promise.resolve();
  expect(s.classes.has("theme-reveal")).toBe(false);
});

it("does not let an older deferred capture overwrite a rapid second choice", async () => {
  const s = surface();
  const { applyTheme } = await import("./theme");
  applyTheme("light");
  applyTheme("dark");
  s.updates[0]();
  expect(s.transitions[0].skipTransition).toHaveBeenCalledOnce();
  expect(s.root.dataset.theme).toBe("dark");
  s.transitions[0].finish();
});

it("applies immediately with reduced motion or failed snapshot capture", async () => {
  const s = surface(true);
  const { applyTheme } = await import("./theme");
  applyTheme("light");
  expect(s.root.dataset.theme).toBe("light");
  expect(s.doc.startViewTransition).not.toHaveBeenCalled();
  window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
  s.doc.startViewTransition.mockImplementation(() => { throw new Error("capture unavailable"); });
  applyTheme("dark");
  expect(s.root.dataset.theme).toBe("dark");
  expect(s.classes.has("theme-reveal")).toBe(false);
});
