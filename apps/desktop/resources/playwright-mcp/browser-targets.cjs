const { createHash, randomUUID } = require("node:crypto");

const REF = /^(f\d+)?e\d+$/;
const REGION_ROLES = new Set(["region", "form", "dialog", "alertdialog", "group", "main", "navigation", "complementary", "banner", "contentinfo", "search", "row", "listitem"]);
const TIMEOUT = 3000;
const TTL = 60000;
const MAX_OBSERVATIONS = 32;
const MAX_SCAN = 10000;
const MAX_REGION_LOOKUPS = 100;
const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
const fingerprint = snapshot => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
const stale = () => new Error("Page or target changed; observation is stale. 重新查找目标后再操作。");
const label = value => String(value || "").slice(0, 500);
const regionInfo = (ref, role, name) => ({ ref, role, name: label(name), ...(String(name || "").length > 500 ? { nameTruncated: true } : {}) });

// All references and document handles are held by the host. No page globals are
// installed, and every returned ref came from Playwright's native AI snapshot.
function createTargetDiscovery({ isActive = () => true } = {}) {
  let revoked = false;
  const observations = new Map();
  const drop = id => {
    const entry = observations.get(id);
    if (!entry) return;
    observations.delete(id);
    clearTimeout(entry.timer);
    for (const handle of entry.handles) handle.dispose().catch(() => {});
  };
  function check(tab, signal) {
    if (revoked || !isActive() || signal?.aborted) throw new Error("Browser observation canceled or control unavailable.");
    if (!tab?.page || tab.page.isClosed()) throw new Error("Current browser page unavailable; choose a page and search again.");
  }
  async function read(tab, signal, operation) {
    check(tab, signal);
    let timer; let abort; let abandoned = false; let completedValue;
    const pending = Promise.resolve().then(operation);
    pending.then(value => { if (abandoned && typeof value?.dispose === "function") value.dispose().catch(() => {}); }, () => {});
    try {
      const result = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Browser observation timed out; use a fresh snapshot or screenshot.")), TIMEOUT);
          abort = () => reject(new Error("Browser observation canceled."));
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
      completedValue = result;
      check(tab, signal);
      return result;
    } catch (error) {
      abandoned = true;
      if (typeof completedValue?.dispose === "function") completedValue.dispose().catch(() => {});
      throw error;
    }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  const snapshot = (tab, signal) => read(tab, signal, () => tab.page.ariaSnapshotJSON({ mode: "ai", boxes: true, timeout: TIMEOUT }));
  const resolve = async (tab, ref, signal) => {
    if (!REF.test(ref)) throw new Error("Target ref is not a native snapshot reference.");
    return (await read(tab, signal, () => tab.targetLocator({ target: ref }))).locator;
  };
  function invalidate(tab, id) {
    for (const [key, entry] of observations) if (entry.tab === tab && (!id || id === key)) drop(key);
  }
  async function state(tab, locator, signal) {
    try {
      const enabled = await read(tab, signal, () => locator.isEnabled({ timeout: TIMEOUT }));
      const local = await read(tab, signal, () => locator.evaluate(el => {
        const doc = el.ownerDocument; const win = doc.defaultView;
        const parent = node => node.assignedSlot || node.parentElement || node.getRootNode()?.host;
        const contains = (ancestor, node) => {
          for (let current = node; current; current = parent(current)) if (current === ancestor) return true;
          return false;
        };
        let hidden = !el.isConnected; let disabled = false;
        for (let ancestor = el; ancestor; ancestor = parent(ancestor)) {
          const style = win.getComputedStyle(ancestor);
          hidden ||= style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
          disabled ||= ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-disabled") === "true";
        }
        const box = el.getBoundingClientRect();
        const x = box.left + box.width / 2; const y = box.top + box.height / 2;
        const visible = !hidden && box.width > 0 && box.height > 0 && x >= 0 && y >= 0 && x < win.innerWidth && y < win.innerHeight;
        let hit = visible ? doc.elementFromPoint(x, y) : null;
        const seen = new Set();
        while (hit?.shadowRoot && !seen.has(hit)) {
          seen.add(hit);
          const nested = hit.shadowRoot.elementFromPoint(x, y);
          if (!nested || nested === hit) break;
          hit = nested;
        }
        const modals = Array.from(doc.querySelectorAll("dialog:modal"));
        const modalBlocked = modals.length > 0 && !modals.some(dialog => contains(dialog, el));
        return { visible, disabled, blocked: !visible || modalBlocked || !hit || !contains(el, hit), point: { x, y }, viewport: { width: win.innerWidth, height: win.innerHeight } };
      }, undefined, { timeout: TIMEOUT }));
      // A frame may be unobstructed internally while its embedding iframe is
      // hidden, offscreen, inert, or covered in an ancestor document.
      let frameBlocked = false; let frameUnknown = false;
      let point = local.point; let viewport = local.viewport;
      let handle;
      try {
        handle = await read(tab, signal, () => locator.elementHandle({ timeout: TIMEOUT }));
        let frame = await read(tab, signal, () => handle.ownerFrame());
        while (frame?.parentFrame()) {
          const frameElement = await read(tab, signal, () => frame.frameElement());
          try {
            const mapped = await read(tab, signal, () => frameElement.evaluate((el, child) => {
              const b = el.getBoundingClientRect(); const d = el.ownerDocument; const w = d.defaultView;
              const parent = node => node.assignedSlot || node.parentElement || node.getRootNode()?.host;
              const contains = (ancestor, node) => {
                for (let current = node; current; current = parent(current)) if (current === ancestor) return true;
                return false;
              };
              let hidden = false; let transformed = false;
              for (let ancestor = el; ancestor; ancestor = parent(ancestor)) {
                const style = w.getComputedStyle(ancestor);
                hidden ||= style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-disabled") === "true";
                transformed ||= style.transform !== "none" || style.perspective !== "none" || (style.translate && style.translate !== "none") || (style.scale && style.scale !== "none") || (style.rotate && style.rotate !== "none") || (style.zoom && style.zoom !== "normal" && Number(style.zoom) !== 1);
              }
              const style = w.getComputedStyle(el);
              // Only translation through ordinary unscaled frame viewports is
              // asserted. CSS transforms/zoom/padding need a more complete map.
              const uncertain = transformed || [style.paddingLeft, style.paddingRight, style.paddingTop, style.paddingBottom].some(value => parseFloat(value) !== 0) || Math.abs(el.clientWidth - child.viewport.width) > 1 || Math.abs(el.clientHeight - child.viewport.height) > 1;
              if (uncertain) return { unknown: true, blocked: hidden };
              const x = b.left + parseFloat(style.borderLeftWidth) + child.point.x;
              const y = b.top + parseFloat(style.borderTopWidth) + child.point.y;
              let hit = d.elementFromPoint(x, y); const seen = new Set();
              while (hit?.shadowRoot && !seen.has(hit)) {
                seen.add(hit); const nested = hit.shadowRoot.elementFromPoint(x, y);
                if (!nested || nested === hit) break;
                hit = nested;
              }
              const modals = Array.from(d.querySelectorAll("dialog:modal"));
              const blocked = hidden || b.width <= 0 || b.height <= 0 || child.point.x < 0 || child.point.y < 0 || child.point.x >= el.clientWidth || child.point.y >= el.clientHeight || x < 0 || y < 0 || x >= w.innerWidth || y >= w.innerHeight || hit !== el || (modals.length > 0 && !modals.some(dialog => contains(dialog, el)));
              return { blocked, point: { x, y }, viewport: { width: w.innerWidth, height: w.innerHeight } };
            }, { point, viewport }));
            frameBlocked ||= mapped.blocked;
            if (mapped.unknown) { frameUnknown = true; break; }
            point = mapped.point; viewport = mapped.viewport;
          } finally { await frameElement.dispose().catch(() => {}); }
          frame = frame.parentFrame();
        }
      } finally { await handle?.dispose().catch(() => {}); }
      const result = { enabled: enabled && !local.disabled, visible: local.visible, blocked: local.blocked || frameBlocked ? true : frameUnknown ? null : false };
      return { ...result, available: !result.enabled || !result.visible || result.blocked === true ? false : result.blocked === null ? null : true };
    } catch (error) {
      check(tab, signal);
      return { enabled: null, visible: null, blocked: null, available: null };
    }
  }
  async function regionFor(tab, node, ancestors, desired, signal) {
    const regions = ancestors.filter(x => (x.name || ["row", "listitem"].includes(x.role)) && (desired || REGION_ROLES.has(x.role))).reverse();
    const native = regions.find(x => !desired || normalize(x.name).includes(desired));
    if (native?.ref && REF.test(native.ref)) return { region: regionInfo(native.ref, native.role, native.name), locator: await resolve(tab, native.ref, signal) };
    const locator = await resolve(tab, node.ref, signal);
    const nearby = locator.locator('xpath=ancestor-or-self::*[self::form or self::section or self::dialog or self::fieldset or @role="dialog" or @role="region" or @role="form"][1]');
    if (await read(tab, signal, () => nearby.count())) {
      const nearbyHandle = await read(tab, signal, () => nearby.elementHandle({ timeout: TIMEOUT }));
      try {
        // Match a DOM-nearby form/section to an actual ancestor in the full
        // native JSON. Scoped snapshots can poison Playwright's ref lookup set
        // after a delayed cancellation, so discovery never starts one.
        for (const ancestor of [...ancestors].reverse()) {
          if (!REF.test(ancestor.ref || "")) continue;
          const ancestorLocator = await resolve(tab, ancestor.ref, signal);
          if (!await read(tab, signal, () => ancestorLocator.evaluate((el, nearby) => el === nearby, nearbyHandle, { timeout: TIMEOUT }))) continue;
          const heading = ancestor.children?.find(x => typeof x === "object" && (x.role === "heading" || x.role === "legend"));
          const name = ancestor.name || heading?.name || "";
          if (!desired || normalize(name).includes(desired)) return { region: regionInfo(ancestor.ref, ancestor.role, name), locator: ancestorLocator };
          break;
        }
      } finally { await nearbyHandle?.dispose().catch(() => {}); }
    }
    if (desired) return null;
    return { region: { ref: null, role: null, name: "" }, locator: null };
  }
  async function sameMembers(tab, members, signal) {
    for (const member of members.values()) {
      for (const [locator, handle] of [[member.locator, member.element], [member.regionLocator, member.regionElement]]) {
        if (!handle) continue;
        if (!await read(tab, signal, () => locator.evaluate((el, original) => el === original && el.isConnected, handle, { timeout: TIMEOUT }))) throw stale();
      }
    }
  }
  async function fresh(tab, id, signal) {
    check(tab, signal);
    const entry = observations.get(id);
    if (!entry || entry.tab !== tab || entry.page !== tab.page || Date.now() - entry.created > TTL) {
      if (entry?.tab === tab) drop(id);
      throw new Error("Unknown or expired observation; 重新查找目标。");
    }
    try {
      const sameDocument = await read(tab, signal, () => tab.page.evaluate(doc => doc === document, entry.document));
      const tree = await snapshot(tab, signal);
      if (!sameDocument || tab.page.url() !== entry.url || fingerprint(tree) !== entry.fingerprint) throw stale();
      await sameMembers(tab, entry.members, signal);
      entry.tree = tree;
      return entry;
    } catch (error) { drop(id); check(tab, signal); throw stale(); }
  }
  async function find(tab, { query, role, region } = {}, { signal } = {}) {
    check(tab, signal);
    const text = normalize(query); const roleFilter = normalize(role); const regionFilter = normalize(region);
    if (!text) return { observationId: null, candidates: [], totalMatches: 0, partial: false, limitations: ["Provide a nonempty accessible-name substring; use a full snapshot or screenshot if unclear."] };
    let handles = new Set(); let documentHandle;
    try {
      // A handle survives neither navigation nor host eviction; page JavaScript
      // cannot overwrite the observation identity.
      documentHandle = await read(tab, signal, () => tab.page.evaluateHandle(() => document));
      handles.add(documentHandle);
      const url = tab.page.url(); const tree = await snapshot(tab, signal);
      const matches = []; let visited = 0; let stopped = false;
      const walk = (nodes, ancestors) => {
        for (const node of nodes || []) {
          if (++visited > MAX_SCAN) { stopped = true; return; }
          if (!node || typeof node !== "object") continue;
          if (REF.test(node.ref || "") && normalize(node.name).includes(text) && (!roleFilter || normalize(node.role) === roleFilter)) matches.push({ node, ancestors });
          walk(node.children, [...ancestors, node]);
          if (stopped) return;
        }
      };
      walk(tree, []);
      const candidates = []; const members = new Map(); let totalMatches = 0; let lookups = 0;
      for (const match of matches) {
        let scope;
        if (regionFilter || candidates.length < 5) {
          if (++lookups > MAX_REGION_LOOKUPS) { stopped = true; break; }
          scope = await regionFor(tab, match.node, match.ancestors, regionFilter, signal);
          if (!scope) continue;
        }
        totalMatches++;
        if (candidates.length >= 5) continue;
        const locator = await resolve(tab, match.node.ref, signal);
        const element = await read(tab, signal, () => locator.elementHandle({ timeout: TIMEOUT })); handles.add(element);
        const regionElement = scope.locator ? await read(tab, signal, () => scope.locator.elementHandle({ timeout: TIMEOUT })) : null;
        if (regionElement) handles.add(regionElement);
        const observed = await state(tab, locator, signal);
        const candidate = { ref: match.node.ref, role: match.node.role, name: label(match.node.name), ...(String(match.node.name || "").length > 500 ? { nameTruncated: true } : {}), region: scope.region, ...observed };
        candidates.push(candidate); members.set(candidate.ref, { candidate, locator, element, regionElement, regionLocator: scope.locator });
      }
      const sameDocument = await read(tab, signal, () => tab.page.evaluate(doc => doc === document, documentHandle));
      if (!sameDocument || url !== tab.page.url() || fingerprint(tree) !== fingerprint(await snapshot(tab, signal))) throw stale();
      await sameMembers(tab, members, signal);
      check(tab, signal);
      for (const [id, entry] of observations) if (Date.now() - entry.created > TTL) drop(id);
      while (observations.size >= MAX_OBSERVATIONS) drop(observations.keys().next().value);
      const observationId = randomUUID();
      const entry = { tab, page: tab.page, document: documentHandle, handles, url, tree, fingerprint: fingerprint(tree), members, created: Date.now() };
      observations.set(observationId, entry);
      entry.timer = setTimeout(() => drop(observationId), TTL); entry.timer.unref?.(); handles = null;
      const limitations = ["Literal accessible-name substring matching; no general semantic understanding. States are observations, not action success."];
      if (totalMatches > 1) limitations.push("Multiple targets match; select a region/ref explicitly or inspect a snapshot/screenshot.");
      if (!totalMatches) limitations.push("No reliable matching target. Try a different accessible name or use a full snapshot/screenshot.");
      if (stopped) limitations.push("Search coverage limited; totalMatches is a lower bound. Use a narrower query or full snapshot.");
      if (candidates.some(x => x.available === null)) limitations.push("Some target states are unknown; do not act without another observation.");
      const namesTruncated = candidates.some(x => x.nameTruncated || x.region.nameTruncated);
      if (namesTruncated) limitations.push("Long native accessible names truncated to 500 characters in this response.");
      return { observationId, candidates, totalMatches, partial: stopped || totalMatches > candidates.length || namesTruncated, limitations };
    } finally { for (const handle of handles || []) await handle.dispose().catch(() => {}); }
  }
  async function validate(tab, { observationId, refs } = {}, { signal } = {}) {
    const entry = await fresh(tab, observationId, signal);
    if (!Array.isArray(refs) || !refs.length || refs.length > 100 || refs.some(ref => !entry.members.has(ref))) throw new Error("Target ref is not a member of this observation; 重新查找目标。");
    for (const ref of refs) {
      const observed = await state(tab, entry.members.get(ref).locator, signal);
      if (observed.available !== true) throw new Error(`Target ${ref} is unavailable or its state is unknown; 重新查找目标。`);
    }
    await fresh(tab, observationId, signal);
  }
  async function expand(tab, { observationId, ref } = {}, { signal } = {}) {
    const entry = await fresh(tab, observationId, signal);
    const member = entry.members.get(ref);
    if (!member) throw new Error("Target ref is not a member of this observation; 重新查找目标。");
    if (!member.regionLocator || !member.candidate.region.ref) return { status: "unavailable", observationId, ref, region: member.candidate.region, snapshot: [], truncated: false, limitations: ["No reliable native local region was found. Use a full snapshot or screenshot to disambiguate."] };
    const queue = [...entry.tree]; let regionNode;
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      if (node.ref === member.candidate.region.ref) { regionNode = node; break; }
      queue.push(...node.children || []);
    }
    if (!regionNode) throw stale();
    const tree = [regionNode];
    let nodes = 0; let chars = 0; let truncated = false;
    function bound(items, depth = 0) {
      const result = [];
      for (const item of items || []) {
        if (nodes >= 80 || chars >= 10000 || depth >= 12) { truncated = true; break; }
        nodes++;
        if (typeof item !== "object" || !item) {
          const value = String(item).slice(0, 500); chars += value.length; result.push(value); truncated ||= value.length !== String(item).length; continue;
        }
        const copy = {};
        for (const [key, value] of Object.entries(item)) {
          if (key === "children") continue;
          copy[key] = typeof value === "string" ? value.slice(0, 500) : value;
          if (typeof value === "string" && value.length > 500) truncated = true;
        }
        chars += JSON.stringify(copy).length;
        if (item.children) copy.children = bound(item.children, depth + 1);
        result.push(copy);
      }
      return result;
    }
    const bounded = bound(tree);
    await fresh(tab, observationId, signal);
    return { observationId, ref, region: member.candidate.region, snapshot: bounded, truncated, limitations: truncated ? ["Local native accessibility subtree truncated; narrow the query or use a snapshot/screenshot."] : [] };
  }
  function revoke() { revoked = true; for (const id of observations.keys()) drop(id); }
  return { find, expand, validate, invalidate, revoke };
}

module.exports = { createTargetDiscovery };
