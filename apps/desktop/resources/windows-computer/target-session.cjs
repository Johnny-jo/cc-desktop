const { randomUUID } = require("node:crypto");
const { setTimeout: wait } = require("node:timers/promises");
const { buildTargetMap, selectTargets } = require("./target-map.cjs");

const normalize = text => String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const sameBounds = (a, b) => a && b && ["x", "y", "width", "height"].every(key => a[key] === b[key]);
const message = error => error?.message || String(error);
const PAGE_BUDGET = 3;

function withinRegion(target, uiBounds, region) {
  if (!region) return true;
  const b = target.bounds;
  if (!b || !uiBounds) return false;
  const x = b.x + b.width / 2 - uiBounds.x, y = b.y + b.height / 2 - uiBounds.y;
  return x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height;
}

function intersects(a, b) {
  return a && b && a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;
}

function createTargetSession({ request, observePixels }) {
  // Target IDs and the pixel observation refer to one published scene.
  let scene;
  function invalidate() { scene = undefined; }

  async function inspect(options, signal) {
    invalidate();
    const { windowId, query, action, region, includeImage = false, vision = "auto" } = options;
    if (vision === "never" && includeImage) throw Error("includeImage needs visual observation.");
    let cursor = options.cursor, ui, frame, image, nativeMap, pages = 0;
    const warnings = [];
    let nativeMatches = [];
    const matchesExactly = target => !target.isOffscreen && target.actions.length &&
      [target.name, target.automationId].some(v => normalize(v) === normalize(query));
    do {
      try {
        const page = await request("observe_target_tree", {
          windowId, cursor, ...(ui ? {extendObservationId:ui.observationId} : {}),
        }, signal);
        // The native helper retains the preceding chunk's references only when
        // continuing this very observation. All rows use the newest token.
        ui = ui ? {
          ...page, controls:[...ui.controls, ...page.controls],
          unavailableBranches:(ui.unavailableBranches ?? 0) + (page.unavailableBranches ?? 0),
        } : page;
      } catch (error) {
        signal.throwIfAborted();
        if (vision === "never" || cursor) throw error;
        warnings.push("Accessibility observation unavailable: " + message(error));
        break;
      }
      pages++;
      if (region && (region.x + region.width > ui.bounds.width || region.y + region.height > ui.bounds.height)) {
        throw Error("The requested region is outside the current window. Inspect its bounds again.");
      }
      nativeMap = buildTargetMap(ui, null);
      nativeMatches = selectTargets(nativeMap.targets, {query, action})
        .filter(t => withinRegion(t, ui.bounds, region));
      cursor = ui.nextCursor;
    } while (query && !nativeMatches.some(matchesExactly) && cursor && pages < PAGE_BUDGET);
    const nativeActions = nativeMatches.filter(t => t.actions.length);
    const hasUsableNative = query
      ? nativeActions.length === 1 && matchesExactly(nativeActions[0])
      : nativeActions.length > 0;
    const needPixels = includeImage || vision === "always" || (vision === "auto" && !hasUsableNative);
    if (needPixels) {
      try {
        ({ frame, image } = await observePixels("capture_window", { windowId, region, includeImage,
          ...(options.captureSource && {captureSource: options.captureSource}) }, signal));
      } catch (error) {
        signal.throwIfAborted();
        if (!ui || vision === "always" || includeImage) throw error;
        warnings.push("Visual observation unavailable: " + message(error));
      }
    }
    signal.throwIfAborted();
    if (frame && (frame.windowId !== windowId || (ui && !sameBounds(ui.bounds, frame.windowBounds)))) {
      throw Error("Window geometry or identity changed between observations. Inspect the window again.");
    }
    if (frame?.ocrWarning) warnings.push(frame.ocrWarning);
    if (ui?.unavailableBranches) warnings.push("Some accessibility branches were unavailable.");
    const { targets: all, bindings } = frame ? buildTargetMap(ui, frame) : nativeMap;
    const windowBounds = ui?.bounds ?? frame.windowBounds;
    const targets = selectTargets(all, {query, action}).filter(t => withinRegion(t, windowBounds, region));
    const sceneId = "scene-" + randomUUID();
    scene = { id: sceneId, windowId, bounds:windowBounds, uiaObservationId:ui?.observationId,
      visualObservationId: frame?.observationId, captureSource:frame?.captureSource,
      bindings: new Map(targets.map(t => [t.id, bindings.get(t.id)])),
      passwordBounds:(ui?.controls ?? []).filter(row => row.isPassword && row.bounds).map(row => row.bounds) };
    const view = { windowId, sceneId, bounds:windowBounds, targets, visionUsed: Boolean(frame), pagesRead:pages,
      truncated: Boolean(ui?.truncated || frame?.truncated), nextCursor: ui?.nextCursor ?? null,
      ...(frame ? { observationId: frame.observationId, captureSource: frame.captureSource, imageBounds: frame.bounds } : {}),
      ...(warnings.length ? { warnings } : {}) };
    return { view, image };
  }

  async function click(args, signal) {
    let { observationId } = args;
    if (observationId.startsWith("scene-")) {
      if (scene?.id !== observationId || scene.windowId !== args.windowId)
        throw Error("Scene expired or belongs to a different window. Inspect the window again.");
      if (!scene.visualObservationId)
        throw Error("This scene has no image. Use act_on_target, or obtain an observationId with observe_visual or observe_display_visual({windowId}).");
      observationId = scene.visualObservationId;
    }
    invalidate();
    return request("click", {...args, observationId}, signal);
  }

  async function readback(windowId, expected, signal, via, passwordBounds, captureSource) {
    const needle = normalize(expected);
    let observed = false;
    const warnings = [];
    try {
      // Read current application state, independently of what the model asked
      // the input provider to do. Allow a short UI dispatch delay.
      const attempts = needle ? 2 : via === "click" ? 0 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt) await wait(120, undefined, {signal});
        let cursor;
        for (let page = 0; page < PAGE_BUDGET; page++) {
          const ui = await request("observe_target_tree", {windowId, cursor}, signal);
          observed = true;
          for (const row of ui.controls) if (row.isPassword && row.bounds) passwordBounds.push(row.bounds);
          const rows = ui.controls.filter(c => !c.isPassword && !c.isOffscreen && intersects(c.bounds, ui.bounds));
          if (!needle) {
            return {status:"read_back", source:"uia", controls:rows.slice(0, 16).map(c => ({
              role:c.controlType, name:c.name, ...(c.value ? {value:c.value} : {}),
            })), truncated:rows.length > 16 || Boolean(ui.truncated)};
          }
          for (const row of rows) {
            const evidence = [row.name, row.value].find(t => t && normalize(t).includes(needle));
            if (evidence) return {status:"observed", source:"uia", evidence};
          }
          cursor = ui.nextCursor;
          if (!cursor) break;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      warnings.push(message(error));
    }
    if (needle || !observed) {
      try {
        const { frame } = await observePixels("capture_window", {
          windowId, ...(captureSource === "compositor" && {captureSource}),
        }, signal);
        const allowed = row => !passwordBounds.some(box => intersects(row.bounds, box));
        const texts = frame.texts.filter(allowed), shapes = frame.shapes.filter(allowed);
        if (frame.ocrWarning) warnings.push(frame.ocrWarning);
        else observed = true;
        if (!needle) {
          return { status:"read_back", source:"visual", texts:texts.slice(0, 16), shapes:shapes.slice(0, 16),
            truncated:Boolean(frame.truncated) || texts.length > 16 || shapes.length > 16, ...(warnings.length ? {warnings} : {}) };
        }
        const found = texts.find(t => normalize(t.text).includes(needle));
        if (found) return {status:"observed", source:"ocr", evidence:found.text, confidence:found.confidence};
      } catch (error) {
        signal.throwIfAborted();
        warnings.push(message(error));
      }
    }
    return {status:observed ? "not_observed" : "unavailable", ...(warnings.length ? {warnings} : {})};
  }

  async function pointerAction(operation, args, signal) {
    const {windowId, sceneId, verifyText} = args;
    if (!scene || scene.id !== sceneId || scene.windowId !== windowId)
      throw Error("Scene expired or belongs to a different window. Inspect again.");
    const integer = (value, min, max, label) => {
      if (!Number.isInteger(value) || value < min || value > max) throw Error("Invalid " + label + ": expected a bounded integer.");
      return value;
    };
    const coordinate = value => integer(value, -2147483648, 2147483647, "coordinate");
    const point = (x, y) => {
      coordinate(x); coordinate(y);
      const b = scene.bounds;
      if (x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height)
        throw Error("The point is outside the observed window bounds. Inspect again.");
    };
    let input;
    if (operation === "scroll") {
      point(args.x, args.y);
      const deltaX = integer(args.deltaX ?? 0, -20, 20, "deltaX");
      const deltaY = integer(args.deltaY ?? 0, -20, 20, "deltaY");
      if (!deltaX && !deltaY) throw Error("Supply a nonzero deltaX or deltaY.");
      input = {x:args.x,y:args.y,deltaX,deltaY};
    } else {
      point(args.startX, args.startY); point(args.endX, args.endY);
      input = {startX:args.startX,startY:args.startY,endX:args.endX,endY:args.endY,
        durationMs:integer(args.durationMs ?? 500, 1, 2000, "durationMs")};
    }
    const {passwordBounds, captureSource, visualObservationId, uiaObservationId} = scene;
    invalidate(); // An uncertain write consumes the original observation as well.
    signal.throwIfAborted();
    await request(operation, {windowId,observationId:visualObservationId ?? uiaObservationId,...input}, signal);
    let verification;
    try { verification = await readback(windowId, verifyText, signal, operation, passwordBounds, captureSource); }
    catch (error) { verification = signal.aborted ? {status:"interrupted"} : {status:"unavailable",warnings:[message(error)]}; }
    return {executed:true,windowId,via:operation,verification};
  }

  async function act(args, signal) {
    const {windowId, sceneId, targetId, action, value, verifyText} = args;
    if (!scene || scene.id !== sceneId || scene.windowId !== windowId) throw Error("Scene expired or belongs to a different window. Inspect again.");
    const binding = scene.bindings.get(targetId);
    if (!binding) throw Error("Unknown target. Use an ID returned by this inspection.");
    if ((action === "set_value") !== (typeof value === "string")) throw Error("Supply a literal value only for set_value.");
    let via;
    if (action === "activate") via = binding.activateVia;
    if (action === "set_value" && binding.canSetValue) via = "set_value";
    if (action === "select" && binding.canSelect) via = "select";
    if (!via) throw Error("This target does not support that action.");
    const {passwordBounds, captureSource} = scene;
    invalidate(); // Consume before the first side effect, including an uncertain provider failure.
    if (via === "click") {
      const activation = await request("activate_window", {windowId}, signal);
      if (activation?.authorizationChanged)
        throw Error("管理员窗口已授权并激活。请重新观察后使用新目标点击，此次未发送点击。");
      await request("click", {windowId, observationId:binding.visualObservationId, ...binding.point, button:"left"}, signal);
    } else {
      const operation = {invoke:"invoke_control", set_value:"set_value", select:"select_item"}[via];
      await request(operation, {windowId, observationId:binding.uiaObservationId, controlId:binding.controlId,
        ...(via === "set_value" ? {value} : {})}, signal);
    }
    let verification;
    try {
      verification = await readback(windowId, verifyText, signal, via, passwordBounds, captureSource);
    } catch (error) {
      // An acknowledged write must not turn into a failed action if stop
      // arrives during verification. Do not return captured data after stop.
      verification = signal.aborted ? {status:"interrupted"} : {status:"unavailable", warnings:[message(error)]};
    }
    return { executed:true, windowId, targetId, via, verification };
  }
  return { inspect, act, click, invalidate,
    scroll:(args,signal) => pointerAction("scroll",args,signal),
    drag:(args,signal) => pointerAction("drag",args,signal) };
}

module.exports = { createTargetSession };
