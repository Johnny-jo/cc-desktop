const { observedLabel } = require("./observed-label.cjs");

const validBox = b => b && [b.x, b.y, b.width, b.height].every(Number.isSafeInteger) && b.width > 0 && b.height > 0;
const right = b => b.x + b.width;
const bottom = b => b.y + b.height;
const contains = (outer, b) => validBox(outer) && validBox(b) &&
  outer.x <= b.x && outer.y <= b.y && right(outer) >= right(b) && bottom(outer) >= bottom(b);
const sameEdges = (a, b, tolerance = 0) => validBox(a) && validBox(b) &&
  Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance &&
  Math.abs(right(a) - right(b)) <= tolerance && Math.abs(bottom(a) - bottom(b)) <= tolerance;

function textOf(line) {
  if (typeof line.text !== "string" || /[\r\n\u2028\u2029]/u.test(line.text)) return "";
  return line.text.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function uniqueText(frame, box) {
  if (!box || frame.truncated || frame.ocrWarning || !contains(frame.bounds, box)) return;
  const line = frame.texts.find(row => row.bounds === box);
  if (!Number.isFinite(line.confidence) || line.confidence < 0.9 || line.confidence > 1) return;
  const text = textOf(line);
  const ambiguous = frame.texts.some(row => {
    if (row === line) return false;
    const b = row.bounds;
    return textOf(row) === text || (validBox(b) && b.x < right(box) && box.x < right(b) && b.y < bottom(box) && box.y < bottom(b));
  });
  if (text && !ambiguous) return text;
}

function surroundingCrop(observed, label) {
  const pad = Math.max(16, Math.min(64, label.height));
  const x = Math.max(observed.x, label.x - pad), y = Math.max(observed.y, label.y - pad);
  const endX = Math.min(right(observed), right(label) + pad), endY = Math.min(bottom(observed), bottom(label) + pad);
  // A label cut off by the original observation cannot establish the full visible text.
  if (x >= label.x - 1 || y >= label.y - 1 || endX <= right(label) + 1 || endY <= bottom(label) + 1) return;
  return { x, y, width: endX - x, height: endY - y };
}

async function clickWithObservation({ request, observePixels }, args, frame, signal) {
  const { windowId, observationId, x, y, button } = args;
  const click = { windowId, observationId, x, y, button };
  const targetBounds = observedLabel(frame, click);
  try {
    return await request("click", targetBounds ? { ...click, targetBounds } : click, signal);
  } catch (error) {
    // Only this native error certifies a pointer move and zero presses. A partial double-click,
    // provider error, or an unacknowledged write must never enter the recovery path.
    if (error?.code !== "hover_changed_before_press" || button !== "left" || !targetBounds ||
        !["print", "compositor"].includes(frame.captureSource) || !contains(frame.windowBounds, frame.bounds)) throw error;
    signal.throwIfAborted();
    const text = uniqueText(frame, targetBounds);
    const crop = text && surroundingCrop(frame.bounds, targetBounds);
    if (!crop) throw error;
    const region = { ...crop, x: crop.x - frame.windowBounds.x, y: crop.y - frame.windowBounds.y };
    const { frame: fresh } = await observePixels("capture_window", { windowId, region, captureSource: frame.captureSource }, signal);
    signal.throwIfAborted();
    if (fresh?.observationId && fresh.observationId !== observationId && fresh.windowId === windowId &&
        fresh.captureSource === frame.captureSource && sameEdges(fresh.bounds, crop) && sameEdges(fresh.windowBounds, frame.windowBounds)) {
      const checked = { ...click, observationId: fresh.observationId };
      const bounds = observedLabel(fresh, checked);
      if (sameEdges(bounds, targetBounds, 1) && uniqueText(fresh, bounds) === text)
        return request("click", { ...checked, targetBounds: bounds, requirePointerAtTarget: true }, signal);
    }
    throw Error("The target changed on hover and its complete label could not be confirmed. Inspect it again before clicking.");
  }
}

module.exports = { clickWithObservation };
