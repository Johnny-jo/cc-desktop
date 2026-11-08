import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { observeAutomationPointer } = require(path.resolve("resources/playwright-mcp/pointer-source.cjs"));

function fixture() {
  const instrumentation = { addListener: vi.fn(), removeListener: vi.fn() };
  const serverContext = { instrumentation };
  const serverPage = {};
  const page = { evaluate: vi.fn().mockResolvedValue(undefined) };
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    _connection: { toImpl: (value: unknown) => value === page ? serverPage : serverContext },
  });
  const source = { attribution: { context: serverContext, page: serverPage } };
  return { context, page, source, instrumentation };
}

describe("automation pointer source", () => {
  it("uses resolved automation coordinates in the owning context", async () => {
    const { context, page, source, instrumentation } = fixture();
    observeAutomationPointer(context);
    const [listener, scope] = instrumentation.addListener.mock.calls[0];
    expect(scope).toBe(source.attribution.context);
    await listener.onBeforeInputAction({ metadata: { method: "click" } }, source, { x: 321, y: 432 });
    expect(page.evaluate.mock.calls[0][1]).toEqual({ x: 321, y: 432, pressed: true });
  });

  it("rejects inactive, foreign-context and nonfinite coordinates", async () => {
    const { context, page, source, instrumentation } = fixture();
    let active = false;
    observeAutomationPointer(context, { isActive: () => active });
    const listener = instrumentation.addListener.mock.calls[0][0];
    await listener.onBeforeInputAction({}, source, { x: 1, y: 2 });
    active = true;
    await listener.onBeforeInputAction({}, { attribution: { ...source.attribution, context: {} } }, { x: 1, y: 2 });
    await listener.onBeforeInputAction({}, source, { x: Number.NaN, y: 2 });
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it.each(["dispose", "close"])("removes its listener after %s and ignores late input", async mode => {
    const { context, page, source, instrumentation } = fixture();
    const dispose = observeAutomationPointer(context);
    const listener = instrumentation.addListener.mock.calls[0][0];
    if (mode === "close") context.emit("close"); else dispose();
    dispose();
    await listener.onBeforeInputAction({}, source, { x: 1, y: 2 });
    expect(instrumentation.removeListener).toHaveBeenCalledExactlyOnceWith(listener);
    expect(context.listenerCount("close")).toBe(0);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("does not fail an action if navigation discards the decorative update", async () => {
    const { context, page, source, instrumentation } = fixture();
    page.evaluate.mockRejectedValue(new Error("Page navigated"));
    observeAutomationPointer(context);
    await expect(instrumentation.addListener.mock.calls[0][0].onBeforeInputAction({}, source, { x: 1, y: 2 })).resolves.toBeUndefined();
  });
});
