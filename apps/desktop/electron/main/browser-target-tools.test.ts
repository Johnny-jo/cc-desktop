import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
const { z } = mcpRequire("playwright-core/lib/utilsBundle");
let withTargetDiscovery = (definitions: any[], _options: any) => definitions;
try { ({ withTargetDiscovery } = require(path.resolve("resources/playwright-mcp/browser-target-tools.cjs"))); }
catch (error: any) { if (error.code !== "MODULE_NOT_FOUND") throw error; }

function fixture() {
  let active = true, snapshots = 0;
  const sequence: string[] = [], texts: string[] = [], errors: string[] = [];
  const tab = { page: {} };
  const context = { currentTab: () => tab };
  const signal = new AbortController().signal;
  const discovery = {
    find: vi.fn(async () => ({ observationId: "obs-1", candidates: [{ ref: "e2" }] })),
    expand: vi.fn(async () => ({ observationId: "obs-1", snapshot: [] })),
    validate: vi.fn(async () => { sequence.push("validate"); }),
    invalidate: vi.fn(() => { sequence.push("invalidate"); }),
  };
  const legacyFind = vi.fn(async () => { sequence.push("legacy find"); });
  const click = vi.fn(async (_context: any, _input: any, response: any) => {
    sequence.push("click"); response.setIncludeSnapshot(); response.addCode("native action");
  });
  const native = [
    { schema: { name: "browser_find", type: "readOnly", inputSchema: z.object({ text: z.string().optional(), regex: z.string().optional(),
      maxResults: z.number().optional(), filename: z.string().optional() }) }, handle: legacyFind },
    { schema: { name: "browser_click", type: "input", inputSchema: z.object({ target: z.string(), element: z.string().optional() }) }, handle: click },
  ];
  const definitions = withTargetDiscovery(native, { z, discovery, isActive: () => active });
  const tool = (name: string) => definitions.find(def => def.schema.name === name);
  const response = { addTextResult: (text: string) => texts.push(text), addError: (text: string) => errors.push(text),
    addCode: vi.fn(), setIncludeSnapshot: () => snapshots++ };
  const call = async (name: string, input: any) => tool(name).handle(context, input, response, signal);
  return { definitions, tool, discovery, legacyFind, click, call, context, tab, signal, sequence, texts, errors,
    snapshots: () => snapshots, cancel: () => { active = false; } };
}

describe("browser target tool integration", () => {
  it("extends the existing find tool and adds only one read-only region tool", () => {
    const f = fixture();
    expect(f.definitions.map(tool => tool.schema.name)).toEqual(["browser_find", "browser_click", "browser_expand_region"]);
    expect(f.tool("browser_expand_region").schema.type).toBe("readOnly");
    expect(f.tool("browser_find").schema.inputSchema.safeParse({ query: "保存", role: "button", region: "通知设置" }).success).toBe(true);
    expect(f.tool("browser_click").schema.inputSchema.safeParse({ target: "e2", observationId: "obs-1" }).success).toBe(true);
  });

  it("keeps legacy text/regex find calls unchanged", async () => {
    const f = fixture(); const input = { text: "Save", maxResults: 5 };
    await f.call("browser_find", input);
    expect(f.legacyFind).toHaveBeenCalledWith(f.context, input, expect.anything(), f.signal);
    expect(f.discovery.find).not.toHaveBeenCalled();
  });

  it("finds targets and expands their region without asking for a page snapshot", async () => {
    const f = fixture(); const input = { query: "保存", region: "通知设置" };
    await f.call("browser_find", input);
    expect(f.discovery.find).toHaveBeenCalledWith(f.tab, input, { signal: f.signal });
    expect(JSON.parse(f.texts[0])).toMatchObject({ observationId: "obs-1" });
    await f.call("browser_expand_region", { ref: "e2", observationId: "obs-1" });
    expect(f.discovery.expand).toHaveBeenCalledWith(f.tab, { ref: "e2", observationId: "obs-1" }, { signal: f.signal });
    expect(f.snapshots()).toBe(0);
  });

  it.each([{ query: "Save", text: "Save" }, { query: "Save", filename: "file" }, { role: "button" }, { query: " " }])("rejects mixed or incomplete query mode %j", async input => {
    const f = fixture();
    await f.call("browser_find", input);
    expect(f.errors).toHaveLength(1);
    expect(f.discovery.find).not.toHaveBeenCalled();
    expect(f.legacyFind).not.toHaveBeenCalled();
  });

  it("validates and consumes a guarded observation before delegating the original input action", async () => {
    const f = fixture();
    await f.call("browser_click", { target: "e2", element: "保存", observationId: "obs-1" });
    expect(f.sequence).toEqual(["validate", "invalidate", "click"]);
    expect(f.discovery.validate).toHaveBeenCalledWith(f.tab, { observationId: "obs-1", refs: ["e2"] }, { signal: f.signal });
    expect(f.click.mock.calls[0][1]).toEqual({ target: "e2", element: "保存" });
    expect(f.snapshots()).toBe(0);
    expect(JSON.parse(f.texts[0])).toMatchObject({ status: "action_returned", verifyRequired: true });
  });

  it("preserves automatic snapshots for ordinary existing actions", async () => {
    const f = fixture();
    await f.call("browser_click", { target: "e2" });
    expect(f.discovery.validate).not.toHaveBeenCalled();
    expect(f.snapshots()).toBe(1);
    expect(f.texts).toHaveLength(0);
  });

  it("never acts with a stale observation or after control is revoked during validation", async () => {
    const stale = fixture();
    stale.discovery.validate.mockRejectedValue(new Error("Stale observation; find again"));
    await expect(stale.call("browser_click", { target: "e2", observationId: "obs-1" })).rejects.toThrow(/Stale/);
    expect(stale.click).not.toHaveBeenCalled();
    const cancelled = fixture();
    cancelled.discovery.validate.mockImplementation(async () => { cancelled.cancel(); });
    await expect(cancelled.call("browser_click", { target: "e2", observationId: "obs-1" })).rejects.toThrow(/active|cancel/i);
    expect(cancelled.click).not.toHaveBeenCalled();
  });

  it("preserves native errors without reporting a successful action", async () => {
    const f = fixture();
    f.click.mockImplementation(async (_context, _input, response) => { response.addError("native click failed"); });
    await f.call("browser_click", { target: "e2", observationId: "obs-1" });
    expect(f.errors).toEqual(["native click failed"]);
    expect(f.texts).toHaveLength(0);
  });

  it("does not dispatch a validated ref into a different selected tab", async () => {
    const f = fixture();
    f.discovery.validate.mockImplementation(async () => { (f.context as any).currentTab = () => ({ page: { replaced: true } }); });
    await expect(f.call("browser_click", { target: "e2", observationId: "obs-1" })).rejects.toThrow(/page|tab/i);
    expect(f.click).not.toHaveBeenCalled();
  });

  it("binds native ensureTab to the same validated tab instead of selecting a new one", async () => {
    const f = fixture();
    const legacyEnsure = vi.fn(async () => ({ page: { other: true } }));
    (f.context as any).ensureTab = legacyEnsure;
    let actedOn: unknown;
    f.click.mockImplementation(async context => { actedOn = await context.ensureTab(); });
    await f.call("browser_click", { target: "e2", observationId: "obs-1" });
    expect(actedOn).toBe(f.tab);
    expect(legacyEnsure).not.toHaveBeenCalled();
  });
});
