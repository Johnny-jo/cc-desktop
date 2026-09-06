import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatScrollController } from "./chat-scroll-controller";

function fixture() {
  let baseHeight = 956;
  let statusTop = 900;
  const frameQueue = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { frameQueue.set(++frameId, fn); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frameQueue.delete(id));
  const windowEvents = new EventTarget();
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("getComputedStyle", () => ({ paddingTop: "20px", paddingBottom: "224px" }));
  const observers: Array<() => void> = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(fn: () => void) { observers.push(fn); }
    observe() {}
    disconnect() {}
  });
  const content = { style: { paddingTop: "" }, get offsetHeight() { return baseHeight + (parseFloat(this.style.paddingTop) || 0); } };
  const spacer = { style: { height: "" } };
  const composer = { getBoundingClientRect: () => ({ top: 800, height: 200 }) };
  const scrolls: number[] = [];
  const list = Object.assign(new EventTarget(), {
    clientHeight: 1000,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, right: 1000 }),
    closest: () => ({ querySelector: () => composer }),
    querySelector: () => ({ getBoundingClientRect: () => ({ top: statusTop + (parseFloat(content.style.paddingTop) || 0) - list.scrollTop }) }),
    scrollTo: (options: ScrollToOptions) => { list.scrollTop = options.top ?? 0; scrolls.push(list.scrollTop); },
  });
  let nativeTop = 0;
  // Browsers clamp scrollTop synchronously when reserve removal shortens the page.
  Object.defineProperty(list, "scrollTop", {
    get() { nativeTop = Math.min(nativeTop, Math.max(0, content.offsetHeight + 244 + (parseFloat(spacer.style.height) || 0) - list.clientHeight)); return nativeTop; },
    set(value: number) { nativeTop = Math.max(0, value); },
  });
  const controller = createChatScrollController(list as unknown as HTMLElement, content as unknown as HTMLElement, spacer as unknown as HTMLElement);
  const update = (running = true) => {
    controller.update({ sessionId: "s", userId: "u", running, hasNewer: false });
    for (let i = 0; frameQueue.size && i < 10; i++) {
      const callbacks = [...frameQueue.values()]; frameQueue.clear(); callbacks.forEach(fn => fn(0));
    }
  };
  return { controller, list, content, spacer, scrolls, update, observers,
    grow: (amount: number) => { baseHeight += amount; },
    short: () => { baseHeight = 156; statusTop = 100; },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("chat scroll controller", () => {
  it("reserves only enough to align the new turn and consumes it as content grows", () => {
    const f = fixture(); f.update();
    expect(f.list.scrollTop).toBe(460);
    expect(f.spacer.style.height).toBe("260px");
    f.grow(200); f.update();
    expect(f.spacer.style.height).toBe("60px");
    expect(f.list.scrollTop).toBe(460);
    f.grow(200); f.update();
    expect(f.spacer.style.height).toBe("0px");
    expect(f.list.scrollTop).toBe(600);
    f.controller.dispose();
  });

  it("does not scroll after wheel-up even when a streaming answer grows", () => {
    const f = fixture(); f.update();
    f.list.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: -100 }));
    f.list.scrollTop = 200;
    f.scrolls.length = 0;
    f.grow(600); f.update();
    expect(f.scrolls).toEqual([]);
    expect(f.list.scrollTop).toBe(200);
    expect(f.spacer.style.height).toBe("0px");
    f.controller.dispose();
  });

  it.each(["touchstart", "pointerdown", "wheel"])("preserves reading geometry on %s and ignores layout-generated scroll events", (type) => {
    const f = fixture(); f.update();
    const before = f.list.scrollTop;
    f.list.dispatchEvent(Object.assign(new Event(type), { deltaY: -1 }));
    expect(f.list.scrollTop).toBe(before);
    f.list.scrollTop -= 1;
    f.list.dispatchEvent(new Event("scroll"));
    const reading = f.list.scrollTop;
    f.grow(600); f.update();
    expect(f.list.scrollTop).toBe(reading);
    expect(f.spacer.style.height).toBe("0px");
    f.controller.dispose();
  });

  it("resumes following only after explicit return to the live tail", () => {
    const f = fixture(); f.update(); f.controller.pause();
    f.grow(600); f.update();
    f.controller.followTail();
    expect(f.list.scrollTop).toBe(800);
    f.grow(200); f.update();
    expect(f.list.scrollTop).toBe(1000);
    f.controller.dispose();
  });

  it("clears trailing reserve on completion without throwing a short answer back to the top", () => {
    const f = fixture(); f.short(); f.update();
    expect(f.content.style.paddingTop).toBe("340px");
    f.update(false);
    expect(f.spacer.style.height).toBe("0px");
    expect(f.content.style.paddingTop).toBe("340px");
    f.controller.dispose();
  });

  it("does not pin an older history window", () => {
    const f = fixture();
    f.controller.update({ sessionId: "s", userId: "old", running: true, hasNewer: true });
    expect(f.scrolls).toEqual([]);
    expect(f.spacer.style.height).toBe("0px");
    f.controller.dispose();
  });

  it("restores owned layout styles and removes listeners on disposal", () => {
    const f = fixture(); f.short(); f.update(); f.controller.dispose();
    expect(f.content.style.paddingTop).toBe("");
    expect(f.spacer.style.height).toBe("");
    f.list.dispatchEvent(new Event("wheel"));
    expect(f.content.style.paddingTop).toBe("");
  });
});
