// UIA and visual bounds use the same absolute, physical screen coordinates.
// Only observation-scoped bindings are used for execution. Target rows are for display and lookup.
const normalize = value => (value || "").normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
const area = box => box.width * box.height;
const validBounds = b => b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0;
const structuralRoles = new Set(["Window", "Pane", "Group", "Document", "ToolBar", "MenuBar", "List", "Tree", "Table", "DataGrid"]);

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return Math.max(0, w) * Math.max(0, h);
}

function inside(point, box) {
  return point.x >= box.x && point.y >= box.y && point.x < box.x + box.width && point.y < box.y + box.height;
}

function strictlyEncloses(outer, inner) {
  return outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height &&
    area(outer) > area(inner);
}

function containerHint(bounds, containers, controlsById) {
  // Containers arrive smallest first. Overlapping siblings or equal outlines cannot establish ownership.
  const parents = new Set();
  let innermost;
  let enclosed = bounds;
  for (const container of containers) {
    if (overlap(container.bounds, bounds) === 0) continue;
    const parentId = controlsById.get(container.id).parentId;
    if (!strictlyEncloses(container.bounds, enclosed) || (parentId && parents.has(parentId))) return;
    if (parentId) parents.add(parentId);
    if (!innermost) innermost = container;
    enclosed = container.bounds;
  }
  if (innermost) {
    const name = controlsById.get(innermost.id).name || "";
    return { id: innermost.id, name, role: innermost.role, source: "geometry" };
  }
}

function actions(binding) {
  const result = [];
  if (binding.activateVia) result.push("activate");
  if (binding.canSetValue) result.push("set_value");
  if (binding.canSelect) result.push("select");
  return result;
}

function makeControl(control, observationId) {
  const id = "u:" + control.id;
  const password = control.isPassword === true;
  const enabled = control.enabled === true;
  const patterns = enabled ? control.patterns || [] : [];
  const binding = { controlId: control.id, uiaObservationId: observationId };
  if (patterns.includes("invoke")) binding.activateVia = "invoke";
  else if (patterns.includes("select")) binding.activateVia = "select";
  if (patterns.includes("setValue")) binding.canSetValue = true;
  if (patterns.includes("select")) binding.canSelect = true;
  const target = {
    id, name: password ? "" : control.name || "", role: control.controlType || "Control",
    bounds: validBounds(control.bounds) ? control.bounds : null, enabled,
    actions: actions(binding), sources: ["uia"],
  };
  if (control.automationId) target.automationId = control.automationId;
  if (typeof control.isOffscreen === "boolean") target.isOffscreen = control.isOffscreen;
  if (password) target.isPassword = true;
  else if (typeof control.value === "string") target.value = control.value;
  return { target, binding };
}

function addContext(target, control, targetsById, controlsById) {
  const parent = targetsById.get(control.parentId);
  if (parent) target.parentId = parent.id;
  // Native ancestor hints survive page boundaries where the parent has no live target id.
  if (control.ancestors?.length) {
    target.ancestors = control.ancestors.slice(-8).map(a => ({ name: a.name || "", role: a.controlType || "Control" }));
    return;
  }
  const ancestors = [];
  let next = parent;
  const seen = new Set([target.id]);
  while (next && ancestors.length < 8 && !seen.has(next.id)) {
    seen.add(next.id);
    ancestors.unshift({ id: next.id, name: next.name, role: next.role });
    const source = controlsById.get(next.id);
    next = targetsById.get(source.parentId);
  }
  if (ancestors.length) target.ancestors = ancestors;
}

function visualCandidates(visual, windowBounds, protectedRegions) {
  function usable(row) {
    const { bounds, point } = row;
    return validBounds(bounds) && point && Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y) &&
      inside(point, bounds) && inside(point, windowBounds) && overlap(bounds, visual.bounds) === area(bounds) &&
      !protectedRegions.some(region => region && overlap(region, bounds) > 0);
  }
  const texts = visual.texts.filter(line => line.text && usable(line));
  const shapes = visual.shapes.filter(usable);
  // The detector assigns OCR labels to their nearest enclosing outline, including multiline labels.
  // Without that label, require a single contained line of a plausible size.
  const linesByShape = new Map();
  const owners = new Map();
  for (const shape of shapes) {
    if (shape.kind !== "rectangle") continue;
    const lines = texts.filter(line => inside(line.point, shape.bounds) && overlap(shape.bounds, line.bounds) >= 0.9 * area(line.bounds) &&
      shape.bounds.height <= Math.max(48, line.bounds.height * 4));
    const label = normalize(shape.label);
    if (!lines.length || (label ? normalize(lines.map(line => line.text).join(" ")) !== label : lines.length !== 1)) continue;
    linesByShape.set(shape, lines);
    for (const line of lines) {
      const possible = owners.get(line) || [];
      possible.push(shape);
      owners.set(line, possible);
    }
  }
  const assigned = new Map();
  const disputed = new Set();
  for (const [line, possible] of owners) {
    const labeled = possible.filter(candidate => candidate.label);
    const best = labeled.length ? labeled : possible;
    if (best.length === 1) assigned.set(line, best[0]);
    else {
      disputed.add(line);
      for (const shape of best) disputed.add(shape);
    }
  }
  const consumed = new Set();
  const candidates = [];
  for (const shape of shapes) {
    const lines = linesByShape.get(shape);
    const paired = lines && lines.every(line => assigned.get(line) === shape);
    if (paired) lines.forEach(line => consumed.add(line));
    candidates.push({
      role: shape.kind, name: paired ? lines.map(line => line.text).join(" ") : shape.label || "",
      sources: paired ? ["ocr", "shape"] : ["shape"], bounds: shape.bounds, point: paired ? lines[0].point : shape.point,
      ambiguous: disputed.has(shape), confidence: paired ? Math.min(...lines.map(line => line.confidence)) : undefined,
    });
  }
  for (const line of texts) {
    if (!consumed.has(line)) candidates.push({
      role: "text", name: line.text, sources: ["ocr"], bounds: line.bounds, point: line.point,
      confidence: line.confidence, ambiguous: disputed.has(line),
    });
  }
  return candidates;
}

function compareCandidate(control, candidate) {
  const { bounds } = control;
  if (!bounds || !control.enabled || control.isPassword || control.isOffscreen || !inside(candidate.point, bounds)) return;
  const intersection = overlap(bounds, candidate.bounds);
  const visualArea = area(candidate.bounds);
  const name = normalize(candidate.name);
  const controlName = normalize(control.name);
  // Text inside a large enclosing pane or document does not by itself identify the pane.
  const fits = intersection >= visualArea * 0.8 && bounds.height <= Math.max(48, candidate.bounds.height * 4) &&
    bounds.width <= Math.max(160, candidate.bounds.width * 8);
  if (name && (name === controlName || name === normalize(control.value))) return fits ? "match" : undefined;
  if (name && controlName) {
    if (fits && control.actions.length) return "conflict";
    return;
  }
  // An unlabeled outline or control needs substantially the same footprint.
  if (!structuralRoles.has(control.role) && candidate.sources.includes("shape") &&
    intersection / (area(bounds) + visualArea - intersection) >= 0.75) return "match";
}

function addVisual(target, binding, candidate, observationId) {
  target.sources.push(...candidate.sources);
  if (!target.name) target.name = candidate.name;
  if (candidate.confidence !== undefined) target.confidence = candidate.confidence;
  if (target.ambiguous) return;
  binding.visualObservationId = observationId;
  binding.point = candidate.point;
  if (!binding.activateVia) binding.activateVia = "click";
  target.actions = actions(binding);
}

function buildTargetMap(ui, visual) {
  if (ui && visual && ui.windowId !== visual.windowId) throw new Error("The observations belong to different windows.");
  if ([ui, visual].some(frame => frame && (!frame.windowId || !frame.observationId || !validBounds(frame.bounds)))) {
    throw new Error("A window observation with valid bounds and an observation ID is required.");
  }
  if (ui && visual?.windowBounds && ["x", "y", "width", "height"].some(k => ui.bounds[k] !== visual.windowBounds[k])) {
    throw new Error("The window moved or resized between observations. Observe the window again.");
  }
  const windowBounds = ui?.bounds || visual?.windowBounds || visual?.bounds;
  if (visual && overlap(visual.bounds, windowBounds) !== area(visual.bounds)) {
    throw new Error("Visual crop lies outside the window bounds. Observe the window again.");
  }
  const controls = ui?.controls || [];
  // One published inspection can retain three native chunks of 256 controls.
  if (controls.length > 3 * 256 || (visual && (visual.texts.length > 160 || visual.shapes.length > 128))) {
    throw new Error("Window observation exceeds the target map limit.");
  }
  const targets = [];
  const bindings = new Map();
  const targetsById = new Map();
  const controlsById = new Map();
  for (const control of controls) {
    const { target, binding } = makeControl(control, ui.observationId);
    targets.push(target);
    bindings.set(target.id, binding);
    targetsById.set(control.id, target);
    controlsById.set(target.id, control);
  }
  for (const target of targets) addContext(target, controlsById.get(target.id), targetsById, controlsById);
  if (!visual) return { targets, bindings };

  const containers = targets.filter(t => t.bounds && !t.isPassword && t.role !== "Window" &&
    (structuralRoles.has(t.role) || t.role === "Tab" || t.role === "TabItem")).sort((a, b) => area(a.bounds) - area(b.bounds));
  const protectedRegions = targets.filter(t => t.isPassword || !t.enabled).map(t => t.bounds);
  const candidates = visualCandidates(visual, windowBounds, protectedRegions);
  const disabledNames = new Set(targets.filter(t => !t.enabled && !t.bounds && t.name).map(t => normalize(t.name)));
  for (const candidate of candidates) {
    if (disabledNames.has(normalize(candidate.name))) candidate.ambiguous = true;
  }
  const matches = candidates.map(candidate => {
    const possible = [];
    for (const target of targets) {
      const relation = compareCandidate(target, candidate);
      if (relation === "match") possible.push(target);
      if (relation === "conflict") {
        candidate.ambiguous = true;
        target.ambiguous = true;
      }
    }
    return possible;
  });
  const counts = new Map();
  for (const list of matches) for (const t of list) counts.set(t, (counts.get(t) || 0) + 1);
  candidates.forEach((candidate, index) => {
    const possible = matches[index];
    if (!candidate.ambiguous && possible.length === 1 && counts.get(possible[0]) === 1) {
      const [target] = possible;
      addVisual(target, bindings.get(target.id), candidate, visual.observationId);
      return;
    }
    const target = {
      id: "v:" + (index + 1), name: candidate.name, role: candidate.role, bounds: candidate.bounds,
      enabled: null, sources: [], actions: [],
    };
    const hint = containerHint(candidate.bounds, containers, controlsById);
    if (hint) target.containerHint = hint;
    const binding = {};
    if (possible.length || candidate.ambiguous) {
      // Keep every accessible target and its direct actions; avoid assigning the same click to any of them.
      target.ambiguous = true;
      for (const match of possible) match.ambiguous = true;
    }
    addVisual(target, binding, candidate, visual.observationId);
    targets.push(target);
    bindings.set(target.id, binding);
  });
  return { targets, bindings };
}

function selectTargets(targets, { query, action } = {}) {
  const needle = normalize(query);
  return targets.filter(target => (!action || target.actions.includes(action)) &&
    (!needle || normalize(target.name).includes(needle) || normalize(target.automationId).includes(needle)));
}

module.exports = { buildTargetMap, selectTargets };
