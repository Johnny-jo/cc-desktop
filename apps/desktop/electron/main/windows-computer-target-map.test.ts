import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { buildTargetMap, selectTargets } = createRequire(import.meta.url)("../../resources/windows-computer/target-map.cjs");
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const frame = rect(-500, 20, 400, 300);
const button = rect(-480, 60, 92, 34);
const label = rect(-466, 69, 64, 16);
const center = (b: typeof frame) => ({ x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) });
const control = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, controlType: "Button", enabled: true, patterns: ["invoke"], bounds: button, ...extra });
const text = (name: string, bounds = label) => ({ text: name, bounds, point: center(bounds), confidence: 0.95 });
const shape = (bounds = button, name?: string) => ({ kind: "rectangle", bounds, point: center(bounds), label: name });
const ui = (...controls: ReturnType<typeof control>[]) => ({ windowId: "hwnd", observationId: "tree", bounds: frame, controls });
const visual = (texts: ReturnType<typeof text>[], shapes: ReturnType<typeof shape>[]) =>
  ({ windowId: "hwnd", observationId: "pixels", bounds: frame, texts, shapes });

describe("Windows grounded target map", () => {
  it("accepts the full retained native window and rejects observations beyond its budget", () => {
    const rows = Array.from({length: 768}, (_, index) => control(String(index), "entry " + index));
    expect(buildTargetMap(ui(...rows)).targets).toHaveLength(768);
    expect(() => buildTargetMap(ui(...rows, control("overflow", "extra")))).toThrow(/limit/);
  });
  it("joins a label and outline at their absolute screen position, retaining direct UIA routing", () => {
    const state = buildTargetMap(ui(control("7", "Save  文件")), visual([text("save 文件")], [shape(button, "save 文件")]));
    expect(state.targets).toHaveLength(1);
    const [target] = state.targets;
    expect(target).toMatchObject({ name: "Save  文件", role: "Button", bounds: button, sources: ["uia", "ocr", "shape"], actions: ["activate"] });
    expect(state.bindings.get(target.id)).toMatchObject({ controlId: "7", uiaObservationId: "tree", activateVia: "invoke" });
  });

  it("keeps all native actions for controls without geometry and never invents a point from UIA alone", () => {
    const state = buildTargetMap(ui(
      control("1", "Mode", { bounds: null, patterns: ["select", "setValue"] }),
      control("2", "Panel", { patterns: [] }),
    ));
    const [mode, panel] = state.targets;
    expect(mode.actions.sort()).toEqual(["activate", "select", "set_value"]);
    expect(state.bindings.get(mode.id)).toMatchObject({ activateVia: "select", canSetValue: true, canSelect: true });
    expect(panel.actions).toEqual([]);
    expect(state.bindings.get(panel.id)).not.toHaveProperty("point");
  });

  it("keeps identical labels at different locations and the observed hierarchy in filtered results", () => {
    const second = rect(-480, 140, 92, 34);
    const state = buildTargetMap(ui(
      control("1", "Toolbar", { controlType: "ToolBar", patterns: [], bounds: frame }),
      control("2", "打开 File", { parentId: "1", automationId: "Open.First" }),
      control("3", "打开 File", { bounds: second, parentId: "earlier", ancestors: [{ name: "侧栏", controlType: "Pane" }] }),
    ), visual([text("打开 File")], []));
    const matches = selectTargets(state.targets, { query: "  打开   fiLE ", action: "activate" });
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ parentId: state.targets[0].id, sources: ["uia", "ocr"], ancestors: [{ name: "Toolbar", role: "ToolBar" }] });
    expect(matches[1]).toMatchObject({ bounds: second, sources: ["uia"], ancestors: [{ name: "侧栏", role: "Pane" }] });
    expect(selectTargets(state.targets, { query: "open.fir" })).toEqual([matches[0]]);
    expect(selectTargets(state.targets, { query: "打开", action: "select" })).toEqual([]);
  });

  it("keeps overlapping equally plausible matches distinct and marks their shared visual evidence", () => {
    const state = buildTargetMap(ui(control("a", "Apply"), control("b", "Apply")), visual([text("Apply")], [shape(button, "Apply")]));
    expect(state.targets).toHaveLength(3);
    expect(state.targets.map((row: { sources: string[] }) => row.sources)).toEqual([["uia"], ["uia"], ["ocr", "shape"]]);
    expect(state.targets.every((row: { ambiguous?: boolean }) => row.ambiguous)).toBe(true);
    expect(state.targets[2].actions).toEqual([]);
  });

  it("leaves a mismatched label at the native button ambiguous and allows an independent target elsewhere", () => {
    const otherLabel = rect(-230, 185, 44, 12);
    const state = buildTargetMap(ui(control("a", "Delete")), visual([text("Archive"), text("Move", otherLabel)], [shape(button, "Archive")]));
    const [buttonTarget, conflicting, independent] = state.targets;
    expect(buttonTarget).toMatchObject({ name: "Delete", ambiguous: true, sources: ["uia"], actions: ["activate"] });
    expect(state.bindings.get(buttonTarget.id)).toMatchObject({ activateVia: "invoke" });
    expect(conflicting).toMatchObject({ name: "Archive", ambiguous: true, sources: ["ocr", "shape"], actions: [] });
    expect(state.bindings.get(conflicting.id)).not.toHaveProperty("point");
    expect(state.bindings.get(conflicting.id)).not.toHaveProperty("activateVia");
    expect(independent).toMatchObject({ name: "Move", sources: ["ocr"], actions: ["activate"] });
    expect(state.bindings.get(independent.id)).toMatchObject({ activateVia: "click", point: center(otherLabel) });
  });

  it("also withholds a standalone OCR click when the line fits an actionable native control with a conflicting label", () => {
    const state = buildTargetMap(ui(control("a", "Delete")), visual([text("Archive")], []));
    expect(state.targets[1]).toMatchObject({ name: "Archive", ambiguous: true, actions: [] });
    expect(state.bindings.get(state.targets[1].id)).not.toHaveProperty("point");
  });

  it("uses an observed point for custom controls and keeps unlabeled icons as geometric candidates", () => {
    const icon = rect(-225, 85, 15, 15);
    const state = buildTargetMap(ui(control("7", "", { patterns: [], controlType: "Custom" })), visual(
      [text("提交")], [shape(), { ...shape(icon), kind: "icon" }],
    ));
    const [custom, symbol] = state.targets;
    expect(custom).toMatchObject({ name: "提交", role: "Custom", sources: ["uia", "ocr", "shape"], actions: ["activate"] });
    expect(state.bindings.get(custom.id)).toMatchObject({ activateVia: "click", point: center(button), visualObservationId: "pixels" });
    expect(symbol).toMatchObject({ name: "", role: "icon", sources: ["shape"], bounds: icon });
    expect(symbol.parentId).toBeUndefined();
    expect(state.bindings.get(symbol.id)).toMatchObject({ activateVia: "click", point: center(icon), visualObservationId: "pixels" });
  });

  it("anchors an off-center label to observed text pixels inside its outline", () => {
    const left = text("打开", rect(button.x + 5, button.y + 8, 24, 14));
    const state = buildTargetMap(null, visual([left], [shape(button, "打开")]));
    expect(state.targets).toHaveLength(1);
    expect(state.bindings.get(state.targets[0].id)).toMatchObject({ activateVia: "click", point: left.point });
  });

  it("suppresses visual actions and sensitive text intersecting disabled or password regions", () => {
    const password = rect(-300, 60, 110, 34);
    const state = buildTargetMap(ui(
      control("a", "Disabled", { enabled: false }),
      control("b", "private", { isPassword: true, value: "secret", bounds: password, patterns: ["setValue"] }),
    ), visual([text("shadow label"), text("ocrSecret", rect(-301, 65, 32, 13))], [shape(), shape(password, "secretShape")]));
    expect(state.targets).toHaveLength(2);
    expect(state.targets[0].actions).toEqual([]);
    expect(state.targets[1].actions).toEqual(["set_value"]);
    expect(JSON.stringify(state.targets)).not.toMatch(/private|secret|shadow label/i);
    for (const entry of state.bindings.values()) expect(entry).not.toHaveProperty("point");
  });

  it("does not use a visual namesake to reactivate a disabled control with missing geometry", () => {
    const state = buildTargetMap(ui(control("a", "Save", { enabled: false, bounds: null })),
      visual([text("Save"), text("Other", rect(-230, 185, 44, 12))], []));
    expect(selectTargets(state.targets, { query: "Save", action: "activate" })).toEqual([]);
    expect(selectTargets(state.targets, { query: "Other", action: "activate" })).toHaveLength(1);
  });

  it("rejects cross-window frames and drops invalid or off-crop visual points", () => {
    const pixels = visual([text("Open"), { ...text("off-crop"), point: { x: 3, y: 2 } }, text("outside", rect(-45, 45, 10, 10))], []);
    expect(() => buildTargetMap(ui(), { ...pixels, windowId: "other" })).toThrow(/window/i);
    const state = buildTargetMap(null, pixels);
    expect(state.targets).toHaveLength(1);
    expect(state.targets[0]).toMatchObject({ name: "Open", actions: ["activate"], sources: ["ocr"] });
  });

  it("accepts crops from the same window geometry and rejects a window which moved between observations", () => {
    const pixels = { ...visual([text("Save")], []), bounds: button, windowBounds: frame };
    expect(buildTargetMap(ui(control("a", "Save")), pixels).targets).toHaveLength(1);
    expect(() => buildTargetMap(ui(), { ...pixels, windowBounds: { ...frame, x: frame.x + 5 } })).toThrow(/moved|bounds/i);
    expect(() => buildTargetMap(ui(), { ...pixels, bounds: { ...frame, x: frame.x + 5 } })).toThrow(/crop|bounds/i);
  });

  it("leaves competing unlabeled outlines and their text ambiguous instead of attaching a click", () => {
    const wider = { ...button, width: button.width + 8 };
    const state = buildTargetMap(null, visual([text("Apply")], [shape(), shape(wider)]));
    expect(state.targets).toHaveLength(3);
    for (const target of state.targets) {
      expect(target).toMatchObject({ ambiguous: true, actions: [] });
      expect(state.bindings.get(target.id)).not.toHaveProperty("activateVia");
    }
  });

  it("does not promote an entire structural UIA pane into a clickable control just because its border is visible", () => {
    const state = buildTargetMap(ui(control("p", "Settings", { controlType: "Pane", patterns: [] })), visual([], [shape()]));
    expect(state.targets).toHaveLength(2);
    expect(state.targets[0]).toMatchObject({ name: "Settings", sources: ["uia"], actions: [] });
    expect(state.targets[1]).toMatchObject({ name: "", sources: ["shape"] });
  });

  it("reports confidence for multiline OCR corroborated by a shape and preserves UIA value routing", () => {
    const lines = [text("First", rect(-466, 63, 34, 12)), { ...text("line", rect(-466, 76, 34, 12)), confidence: 0.78 }];
    const state = buildTargetMap(ui(control("field", "Title", { controlType: "Edit", patterns: ["setValue"], value: "First line" })),
      visual(lines, [shape(button, "First line")]));
    expect(state.targets).toHaveLength(1);
    expect(state.targets[0]).toMatchObject({ name: "Title", value: "First line", confidence: 0.78, sources: ["uia", "ocr", "shape"] });
    expect(state.bindings.get(state.targets[0].id)).toMatchObject({ canSetValue: true });
  });

  it("distinguishes matching canvas labels using their innermost containing panels", () => {
    const rightLabel = rect(-226, 69, 64, 16);
    const state = buildTargetMap(ui(
      control("group", "设置", { controlType: "Group", bounds: frame, patterns: [] }),
      control("left", "个人", { controlType: "Pane", parentId: "group", bounds: rect(-495, 36, 186, 180), patterns: [] }),
      control("right", "团队", { controlType: "TabItem", parentId: "group", bounds: rect(-306, 36, 200, 180), patterns: ["select"] }),
    ), visual([text("保存"), text("保存", rightLabel)], [shape(button, "保存")]));
    const matches = selectTargets(state.targets, { query: "保存" });
    expect(matches).toHaveLength(2);
    expect(matches[0].containerHint).toEqual({ id: state.targets[1].id, name: "个人", role: "Pane", source: "geometry" });
    expect(matches[1].containerHint).toEqual({ id: state.targets[2].id, name: "团队", role: "TabItem", source: "geometry" });
    for (const target of matches) {
      expect(target.parentId).toBeUndefined();
      expect(target.actions).toEqual(["activate"]);
      expect(state.bindings.get(target.id)).toEqual({
        activateVia: "click", visualObservationId: "pixels", point: center(target === matches[0] ? label : rightLabel),
      });
    }
  });

  it.each([
    ["overlapping", [rect(-490, 45, 140, 100), rect(-479, 34, 150, 88)]],
    ["identical", [button, button]],
    ["coextensive with the candidate", [label]],
    ["partly enclosing", [rect(label.x + 2, label.y, label.width, label.height)]],
    ["unbounded", [null]],
  ] as const)("omits a geometry hint for %s panels", (_reason, panels) => {
    const state = buildTargetMap(ui(...panels.map((bounds, index) =>
      control(String(index), "Panel " + index, { controlType: "Group", bounds, patterns: [] }))), visual([text("保存")], []));
    expect(selectTargets(state.targets, { query: "保存" })[0].containerHint).toBeUndefined();
  });

  it("respects explicit UIA sibling relationships even when one sibling's box encloses the other", () => {
    const state = buildTargetMap(ui(
      control("1", "Layer A", { parentId: "root", controlType: "Group", bounds: frame, patterns: [] }),
      control("2", "Layer B", { parentId: "root", controlType: "Group", bounds: button, patterns: [] }),
    ), visual([text("保存")], []));
    expect(selectTargets(state.targets, { query: "保存" })[0].containerHint).toBeUndefined();
  });
});
