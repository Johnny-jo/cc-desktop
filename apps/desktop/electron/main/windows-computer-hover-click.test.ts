import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";

const { clickWithObservation } = createRequire(import.meta.url)("../../resources/windows-computer/click-after-hover.cjs");
const signal = new AbortController().signal;
const label = { x: -320, y: 180, width: 86, height: 28 };
const line = { text: "开启时长", confidence: 0.99, bounds: label };
const windowBounds = { x: -400, y: 100, width: 500, height: 400 };
const frame = {
  windowId: "12c:445", observationId: "visual-old", captureSource: "compositor",
  bounds: { x: -360, y: 140, width: 200, height: 130 }, windowBounds, texts: [line], shapes: [],
};
const click = { windowId: frame.windowId, observationId: frame.observationId, button: "left", x: -280, y: 192 };
const hover = Object.assign(new Error("Changed before first press"), { code: "hover_changed_before_press" });
type Box = typeof label;

function fixture(change: Record<string, unknown> = {}, failure: Error = hover) {
  const request = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ sent: true });
  const observePixels = vi.fn(async (_op: string, { region }: { region: Box }) => ({
    frame: { ...frame, observationId: "visual-new",
      bounds: { ...region, x: region.x + windowBounds.x, y: region.y + windowBounds.y }, ...change },
  }));
  return { request, observePixels };
}

it("rechecks a stable single-line label on the same backend after hover and presses once at the unmoved pointer", async () => {
  const shifted = { ...label, x: label.x + 1, height: label.height - 1 };
  const driver = fixture({ texts: [{ ...line, text: " 开启时长 ", bounds: shifted }] });
  await expect(clickWithObservation(driver, click, frame, signal)).resolves.toEqual({ sent: true });
  expect(driver.request).toHaveBeenNthCalledWith(1, "click", { ...click, targetBounds: label }, signal);
  expect(driver.observePixels).toHaveBeenCalledOnce();
  const [op, read] = driver.observePixels.mock.calls[0];
  expect(op).toBe("capture_window");
  expect(read).toMatchObject({ windowId: click.windowId, captureSource: "compositor" });
  const { region } = read;
  expect(region.x + windowBounds.x).toBeLessThan(label.x);
  expect(region.y + windowBounds.y).toBeLessThan(label.y);
  expect(region.width).toBeGreaterThan(label.width);
  expect(region.width).toBeLessThanOrEqual(frame.bounds.width);
  expect(driver.request).toHaveBeenNthCalledWith(2, "click", {
    ...click, observationId: "visual-new", targetBounds: shifted, requirePointerAtTarget: true,
  }, signal);
  expect(driver.request).toHaveBeenCalledTimes(2);
});

it.each([
  ["ordinary stale pixels", {}, frame, Error("Pixels changed before the mouse press")],
  ["partial input", {}, frame, Error("First click was already sent")],
  ["double click", { button: "double" }, frame, hover],
  ["right click", { button: "right" }, frame, hover],
  ["unlabelled icon", {}, { ...frame, texts: [] }, hover],
  ["display capture", {}, { ...frame, captureSource: "display" }, hover],
  ["an expired observation", { observationId: "visual-expired" }, frame, hover],
  ["low confidence", {}, { ...frame, texts: [{ ...line, confidence: 0.4 }] }, hover],
  ["a repeated label", {}, { ...frame, texts: [line, { ...line, bounds: { ...label, y: 230 } }] }, hover],
  ["a multiline outline", {}, { ...frame, shapes: [{ bounds: label, label: "开启时长 详情" }] }, hover],
] as const)("never recovers %s", async (_name, overrides, before, failure) => {
  const driver = fixture({}, failure);
  await expect(clickWithObservation(driver, { ...click, ...overrides }, before, signal)).rejects.toBe(failure);
  expect(driver.observePixels).not.toHaveBeenCalled();
  expect(driver.request).toHaveBeenCalledTimes(1);
});

it.each([
  ["label changed", { texts: [{ ...line, text: "关闭时长" }] }],
  ["label moved", { texts: [{ ...line, bounds: { ...label, x: label.x + 2 } }] }],
  ["right edge moved", { texts: [{ ...line, bounds: { ...label, x: label.x + 1, width: label.width + 1 } }] }],
  ["label uncertain", { texts: [{ ...line, confidence: 0.55 }] }],
  ["overlapping labels", { texts: [line, { ...line, text: "取消" }] }],
  ["another OCR line covers the last glyph", { texts: [line, {
    ...line, text: "取消", bounds: { ...label, x: label.x + label.width - 4, width: 20 },
  }] }],
  ["different window", { windowId: "13c:445" }],
  ["window moved", { windowBounds: { ...windowBounds, y: windowBounds.y - 1 } }],
  ["capture source changed", { captureSource: "print" }],
  ["old image reused", { observationId: frame.observationId }],
  ["different crop", { bounds: frame.bounds }],
  ["incomplete OCR", { truncated: true }],
])("sends no press when the recheck fails: %s", async (_name, change) => {
  const driver = fixture(change as Record<string, unknown>);
  await expect(clickWithObservation(driver, click, frame, signal)).rejects.toThrow();
  expect(driver.observePixels).toHaveBeenCalledOnce();
  expect(driver.request).toHaveBeenCalledTimes(1);
});

it("never replays a failed second request or proceeds after cancellation", async () => {
  const driver = fixture();
  driver.request.mockRejectedValueOnce(hover);
  await expect(clickWithObservation(driver, click, frame, signal)).rejects.toBe(hover);
  expect(driver.request).toHaveBeenCalledTimes(2);
  expect(driver.observePixels).toHaveBeenCalledOnce();

  const stopped = fixture();
  const owner = new AbortController();
  stopped.observePixels.mockImplementation(async () => {
    owner.abort();
    return { frame };
  });
  await expect(clickWithObservation(stopped, click, frame, owner.signal)).rejects.toThrow();
  expect(stopped.request).toHaveBeenCalledTimes(1);
});
