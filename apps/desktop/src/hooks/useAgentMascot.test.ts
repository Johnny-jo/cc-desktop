import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentMascot } from "./useAgentMascot";

const lifecycle = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  expression: "normal",
  changes: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => { lifecycle.cleanup = effect() || undefined; },
  useState: (initial: string) => {
    lifecycle.expression = initial;
    return [initial, (next: string) => {
      lifecycle.expression = next;
      lifecycle.changes(next);
    }];
  },
}));

// The hook only needs event targets and a few element properties, not layout or React rendering.
class TestElement extends EventTarget {
  children: TestElement[] = [];
  classes = new Set<string>();
  classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
  };
  style = { setProperty: vi.fn() };

  constructor(private selector: string, private parent?: TestElement) {
    super();
    parent?.children.push(this);
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    // Node requires an options object to remove capture listeners; browsers accept the boolean too.
    super.removeEventListener(type, callback, typeof options === "boolean" ? { capture: options } : options);
  }

  matches(selector: string) { return selector === this.selector; }
  closest(selector: string): TestElement | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
  }
  querySelector(selector: string): TestElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
}

class TestTextarea extends TestElement { value = ""; }

function dispatch(destination: EventTarget, type: string, target?: TestElement, properties = {}) {
  const event = new Event(type);
  if (target) Object.defineProperty(event, "target", { value: target });
  Object.assign(event, properties);
  destination.dispatchEvent(event);
}

function mount() {
  const panel = new TestElement(".chat-panel");
  const button = new TestElement(".agent-wordmark", panel);
  const orbit = new TestElement(".agent-orbit", button);
  const face = new TestElement(".agent-face", orbit);
  const composer = new TestTextarea(".composer-input", panel);
  const document = Object.assign(new EventTarget(), { hidden: false });
  const reducedMotion = Object.assign(new EventTarget(), { matches: false });
  const window = Object.assign(new EventTarget(), { matchMedia: () => reducedMotion });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("HTMLTextAreaElement", TestTextarea);
  useAgentMascot({ current: button as unknown as HTMLButtonElement });
  return { panel, button, face, composer, document, window };
}

beforeEach(() => {
  vi.useFakeTimers();
  lifecycle.changes.mockClear();
  // Choose double blinking so idle activity is observable on the animation class.
  vi.spyOn(Math, "random").mockReturnValue(0.99);
});

afterEach(() => {
  lifecycle.cleanup?.();
  lifecycle.cleanup = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useAgentMascot lifecycle", () => {
  it("keeps the current idle deadline when a visible window loses focus", () => {
    const { button, window } = mount();
    vi.advanceTimersByTime(3000);
    dispatch(window, "blur");
    vi.advanceTimersByTime(1000);
    expect(button.classes.has("is-idle-double-blinking")).toBe(true);

    // The idle cycle also continues without needing a focus event to restart it.
    vi.advanceTimersToNextTimer();
    expect(lifecycle.expression).toBe("normal");
    expect(button.classes.has("is-idle-double-blinking")).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersToNextTimer();
    expect(button.classes.has("is-idle-blinking")).toBe(true);
  });

  it("pauses all reactions while hidden and resumes idle activity when visible", () => {
    const { panel, button, composer, document } = mount();
    composer.value = "hello";
    dispatch(panel, "input", composer);
    expect(lifecycle.expression).toBe("stars");

    document.hidden = true;
    dispatch(document, "visibilitychange");
    expect(lifecycle.expression).toBe("normal");
    expect(vi.getTimerCount()).toBe(0);
    lifecycle.changes.mockClear();
    dispatch(panel, "input", composer);
    vi.advanceTimersByTime(60000);
    expect(lifecycle.changes).not.toHaveBeenCalled();

    document.hidden = false;
    dispatch(document, "visibilitychange");
    vi.advanceTimersToNextTimer();
    expect(button.classes.has("is-idle-double-blinking")).toBe(true);
  });

  it("clears double blinking when interrupted and when unmounted", () => {
    const { panel, button } = mount();
    vi.advanceTimersByTime(4000);
    expect(button.classes.has("is-idle-double-blinking")).toBe(true);
    dispatch(panel, "pointerdown");
    expect(button.classes.size).toBe(0);

    vi.advanceTimersToNextTimer();
    vi.advanceTimersToNextTimer();
    vi.advanceTimersToNextTimer();
    expect(button.classes.has("is-idle-double-blinking")).toBe(true);
    lifecycle.cleanup?.();
    lifecycle.cleanup = undefined;
    expect(button.classes.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses star eyes for typing and reserves blush for clicks on the mascot", () => {
    const { panel, button, face, composer } = mount();
    composer.value = "an idea";
    for (let i = 0; i < 4; i++) {
      dispatch(panel, "input", composer);
      expect(lifecycle.expression).toBe("stars");
      vi.advanceTimersByTime(300);
    }
    expect(lifecycle.changes).not.toHaveBeenCalledWith("blush");
    vi.advanceTimersByTime(2000);
    expect(lifecycle.expression).toBe("normal");

    dispatch(button, "click", button, { detail: 1 });
    expect(lifecycle.expression).toBe("normal");
    dispatch(button, "click", face, { detail: 1 });
    expect(lifecycle.expression).toBe("blush");
    vi.advanceTimersToNextTimer();
    expect(lifecycle.expression).toBe("normal");
  });

  it("allows keyboard activation of the wordmark to pet the mascot", () => {
    const { button } = mount();
    dispatch(button, "click", button, { detail: 0 });
    expect(lifecycle.expression).toBe("blush");
  });

  it("removes timers and event listeners when unmounted during a reaction", () => {
    const { panel, button, face, composer, document, window } = mount();
    dispatch(button, "click", face, { detail: 1 });
    expect(lifecycle.expression).toBe("blush");
    lifecycle.cleanup?.();
    lifecycle.cleanup = undefined;
    expect(vi.getTimerCount()).toBe(0);
    lifecycle.changes.mockClear();
    button.style.setProperty.mockClear();

    composer.value = "after unmount";
    dispatch(panel, "input", composer);
    dispatch(panel, "pointerdown");
    dispatch(panel, "pointerleave");
    dispatch(panel, "keydown");
    dispatch(panel, "pointermove", face, { pointerType: "mouse", clientX: 50, clientY: 50 });
    dispatch(button, "click", face, { detail: 1 });
    dispatch(document, "visibilitychange");
    dispatch(window, "blur");
    vi.advanceTimersByTime(60000);
    expect(lifecycle.changes).not.toHaveBeenCalled();
    expect(button.style.setProperty).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
