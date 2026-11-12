import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
const { chromium } = mcpRequire("playwright");
const { Tab } = mcpRequire("playwright-core/lib/coreBundle").tools;
let engine: any = {};
try { engine = require(path.resolve("resources/playwright-mcp/browser-targets.cjs")); } catch (error: any) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
let browser: any; let page: any; let tab: any;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  // Exercise the shipped native method without starting the MCP log machinery.
  tab = Object.assign(Object.create(Tab.prototype), { page, context: { config: {} }, _initializedPromise: Promise.resolve() });
});
afterAll(async () => { await browser?.close(); });
function discovery(options: any = {}) { expect(typeof engine.createTargetDiscovery).toBe("function"); return engine.createTargetDiscovery(options); }

describe("native browser target discovery", () => {
  it("distinguishes same-name controls by native accessible region and returns actionable native refs", async () => {
    const d = discovery();
    await page.setContent('<section aria-label="Profile"><button onclick="this.textContent=\'Saved\'">Save</button></section><section aria-label="Billing"><button>Save</button></section>');
    const result = await d.find(tab, { query: "save", role: "button" });
    expect(result.totalMatches).toBe(2); expect(result.candidates.map((x: any) => x.region.name)).toEqual(["Profile", "Billing"]);
    expect(result.candidates[0]).toMatchObject({ name: "Save", role: "button", available: true, visible: true, enabled: true, blocked: false });
    await expect(d.validate(tab, { observationId: result.observationId, refs: [result.candidates[0].ref] })).resolves.toBeUndefined();
    await (await tab.targetLocator({ target: result.candidates[0].ref })).locator.click();
    expect(await page.locator('section').first().innerText()).toBe("Saved");
    const scoped = await d.find(tab, { query: "Save", region: "Billing" });
    expect(scoped.totalMatches).toBe(1); expect(scoped.candidates[0].region.name).toBe("Billing");
  });
  it("reports disabled, aria-disabled, inert, offscreen and pointer-obscured targets conservatively", async () => {
    const d = discovery();
    await page.setContent('<button disabled>Save native</button><button aria-disabled="true">Save aria</button><div inert><button>Save inert</button></div><button style="position:absolute;top:900px">Save below</button><div style="position:relative"><button>Save covered</button><div style="position:absolute;inset:0;background:red"></div></div>');
    const result = await d.find(tab, { query: "Save" });
    for (const x of result.candidates) expect(x.available).not.toBe(true);
    expect(result.candidates.find((x: any) => x.name === "Save native")).toMatchObject({ enabled: false, available: false });
    expect(result.candidates.find((x: any) => x.name === "Save covered")).toMatchObject({ blocked: true, available: false });
    await expect(d.validate(tab, { observationId: result.observationId, refs: [result.candidates[0].ref] })).rejects.toThrow(/unavailable|不可用/);
  });
  it("does not expose modal-background controls as available", async () => {
    const d = discovery();
    await page.setContent('<button>Save background</button><dialog><button>Save dialog</button></dialog><script>document.querySelector("dialog").showModal()</script>');
    const result = await d.find(tab, { query: "Save" });
    expect(result.candidates.find((x: any) => x.name === "Save dialog")?.available).toBe(true);
    expect(result.candidates.find((x: any) => x.name === "Save background")?.available).not.toBe(true);
  });
  it("rejects same-name replacement, navigation and unrelated snapshot changes", async () => {
    const d = discovery(); await page.setContent('<button>Save</button>');
    let result = await d.find(tab, { query: "Save" });
    await page.locator('button').evaluate((el: any) => { el.outerHTML = '<button>Save</button>'; });
    await expect(d.validate(tab, { observationId: result.observationId, refs: [result.candidates[0].ref] })).rejects.toThrow(/changed|stale|重新/);
    result = await d.find(tab, { query: "Save" });
    await page.evaluate(() => document.body.appendChild(document.createTextNode("updated")));
    await expect(d.expand(tab, { observationId: result.observationId, ref: result.candidates[0].ref })).rejects.toThrow(/changed|stale|重新/);
    result = await d.find(tab, { query: "Save" }); await page.goto('data:text/html,<button>Save</button>');
    await expect(d.validate(tab, { observationId: result.observationId, refs: [result.candidates[0].ref] })).rejects.toThrow(/changed|stale|重新/);
  });
  it("expands only the stored native region with bounded output and no writes or scroll", async () => {
    const d = discovery();
    await page.setContent('<form><h2>Billing</h2><button>Save</button>' + '<p>Detail line</p>'.repeat(180) + '</form><aside>OUTSIDE_SENTINEL</aside><script>window.writes=0;document.addEventListener("click",()=>window.writes++)</script>');
    const result = await d.find(tab, { query: "Save", region: "Billing" });
    const expanded = await d.expand(tab, { observationId: result.observationId, ref: result.candidates[0].ref });
    expect(expanded.region.name).toBe("Billing"); expect(expanded.truncated).toBe(true);
    expect(JSON.stringify(expanded)).not.toContain("OUTSIDE_SENTINEL"); expect(JSON.stringify(expanded).length).toBeLessThan(16000);
    expect(await page.evaluate(() => ({ writes: (window as any).writes, scroll: window.scrollY }))).toEqual({ writes: 0, scroll: 0 });
  });
  it("keeps native iframe refs usable", async () => {
    const d = discovery(); await page.setContent('<iframe srcdoc="<section aria-label=Frame><button>Save frame</button></section>"></iframe>');
    await page.frameLocator('iframe').getByRole('button').waitFor();
    const result = await d.find(tab, { query: "Save frame" });
    expect(result.candidates[0].ref).toMatch(/^f\d+e\d+$/); expect(result.candidates[0].available).toBe(true);
    await d.validate(tab, { observationId: result.observationId, refs: [result.candidates[0].ref] });
    expect(await (await tab.targetLocator({ target: result.candidates[0].ref })).locator.innerText()).toBe("Save frame");
  });
  it("bounds ambiguous results and explains missing or empty queries", async () => {
    const d = discovery(); await page.setContent('<button>Save</button>'.repeat(9));
    const result = await d.find(tab, { query: "Save" });
    expect(result.totalMatches).toBe(9); expect(result.candidates).toHaveLength(5); expect(result.partial).toBe(true);
    expect((await d.find(tab, { query: "missing" })).limitations.length).toBeGreaterThan(0);
    expect((await d.find(tab, { query: "" })).candidates).toEqual([]);
    await expect(d.validate(tab, { observationId: result.observationId, refs: ["e99999"] })).rejects.toThrow(/observation|观察/);
  });
  it("invalidates explicitly and discards canceled, revoked and closed-page observations", async () => {
    let active = true; const d = discovery({ isActive: () => active }); await page.setContent('<button>Save</button>');
    const result = await d.find(tab, { query: "Save" }); d.invalidate(tab, result.observationId);
    await expect(d.validate(tab, { observationId: result.observationId, refs: [result.candidates[0].ref] })).rejects.toThrow();
    const abort = new AbortController(); abort.abort(); await expect(d.find(tab, { query: "Save" }, { signal: abort.signal })).rejects.toThrow();
    active = false; await expect(d.find(tab, { query: "Save" })).rejects.toThrow();
    active = true; d.revoke(); await expect(d.find(tab, { query: "Save" })).rejects.toThrow();
    const extra = await browser.newPage(); await extra.close();
    await expect(discovery().find({ ...tab, page: extra }, { query: "Save" })).rejects.toThrow();
  });
  it("rejects cancellation during a native read and never publishes that observation", async () => {
    const d = discovery(); const abort = new AbortController();
    await page.setContent('<button>Save</button>');
    const native = page.ariaSnapshotJSON.bind(page); let finish: any;
    page.ariaSnapshotJSON = async (...args: any[]) => { const tree = await native(...args); await new Promise(resolve => { finish = resolve; }); return tree; };
    try {
      const pending = d.find(tab, { query: "Save" }, { signal: abort.signal });
      while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
      abort.abort(); await expect(pending).rejects.toThrow(/cancel/); finish();
    } finally { page.ariaSnapshotJSON = native; }
  });
  it("keeps names and subtree output bounded even for very large accessible names", async () => {
    const d = discovery(); await page.setContent('<section aria-label="' + 'Region'.repeat(2000) + '"><button aria-label="Save ' + 'detail '.repeat(2000) + '">Save</button></section>');
    const result = await d.find(tab, { query: "Save" });
    expect(JSON.stringify(result).length).toBeLessThan(8000);
    expect(result.partial).toBe(true); expect(result.candidates[0].nameTruncated).toBe(true);
  });
  it("rechecks pointer availability even if the native snapshot is unchanged", async () => {
    const d = discovery(); await page.setContent('<button>Save</button><div id="cover" aria-hidden="true" style="display:none;position:fixed;inset:0;background:red"></div>');
    const result = await d.find(tab, { query: "Save" });
    await page.locator('#cover').evaluate((el: any) => { el.style.display = 'block'; });
    await expect(d.validate(tab, { observationId: result.observationId, refs: [result.candidates[0].ref] })).rejects.toThrow(/unavailable|changed|重新/);
  });
  it("does not mark controls in an invisible embedding iframe available", async () => {
    const d = discovery(); await page.setContent('<div style="opacity:0"><iframe srcdoc="<button>Save frame</button>"></iframe></div>');
    await page.frameLocator('iframe').getByRole('button').waitFor();
    const result = await d.find(tab, { query: "Save frame" });
    expect(result.candidates[0].available).toBe(false);
  });
  it("tests the target point through nested iframe hosts instead of iframe centers", async () => {
    const d = discovery();
    await page.setContent('<iframe style="width:600px;height:400px;border:5px solid black" srcdoc="<iframe style=\'width:450px;height:250px;border:3px solid black\' srcdoc=\'<button>Save nested</button>\'></iframe>"></iframe><div aria-hidden="true" style="position:fixed;left:20px;top:20px;width:130px;height:80px;background:red;z-index:9"></div>');
    await page.frameLocator('iframe').frameLocator('iframe').getByRole('button').waitFor();
    const result = await d.find(tab, { query: "Save nested" });
    expect(result.candidates[0]).toMatchObject({ blocked: true, available: false });
    await page.locator('div[aria-hidden]').evaluate((el: any) => el.remove());
    const unobstructed = await d.find(tab, { query: "Save nested" });
    expect(unobstructed.candidates[0]).toMatchObject({ blocked: false, available: true });
  });
  it("follows open shadow hit-test roots for real visible controls", async () => {
    const d = discovery();
    await page.setContent('<div id="host"></div><script>document.querySelector("#host").attachShadow({mode:"open"}).innerHTML="<div id=inner></div>";document.querySelector("#host").shadowRoot.querySelector("#inner").attachShadow({mode:"open"}).innerHTML="<button>Save shadow</button>"</script>');
    const result = await d.find(tab, { query: "Save shadow" });
    expect(result.candidates[0]).toMatchObject({ blocked: false, visible: true, available: true });
    await expect(d.validate(tab, { observationId: result.observationId, refs: [result.candidates[0].ref] })).resolves.toBeUndefined();
  });
  it("rejects an independently reloaded iframe document even when native refs and snapshot match", async () => {
    const d = discovery();
    await page.setContent('<iframe srcdoc="<section aria-label=Frame><button>Save frame</button></section>"></iframe>');
    await page.frameLocator('iframe').getByRole('button').waitFor();
    const result = await d.find(tab, { query: "Save frame" });
    const before = await page.ariaSnapshotJSON({ mode: 'ai', boxes: true });
    const frame = page.frames()[1];
    await Promise.all([frame.waitForNavigation(), frame.evaluate(() => location.reload())]);
    await frame.getByRole('button').waitFor();
    expect(await page.ariaSnapshotJSON({ mode: 'ai', boxes: true })).toEqual(before);
    await expect(d.validate(tab, { observationId: result.observationId, refs: [result.candidates[0].ref] })).rejects.toThrow(/changed|stale|重新/);
    const again = await d.find(tab, { query: "Save frame" });
    await Promise.all([frame.waitForNavigation(), frame.evaluate(() => location.reload())]);
    await frame.getByRole('button').waitFor();
    await expect(d.expand(tab, { observationId: again.observationId, ref: again.candidates[0].ref })).rejects.toThrow(/changed|stale|重新/);
  });
  it("selects real table rows for local disambiguation and reports unavailable without a region", async () => {
    const d = discovery();
    await page.setContent('<table><tr><td>First</td><td><button>Save</button></td></tr><tr><td>Second</td><td><button>Save</button></td></tr></table>');
    const result = await d.find(tab, { query: "Save" });
    expect(result.candidates.map((x: any) => x.region.role)).toEqual(['row', 'row']);
    const expanded = await d.expand(tab, { observationId: result.observationId, ref: result.candidates[0].ref });
    expect(JSON.stringify(expanded.snapshot)).toContain('First'); expect(JSON.stringify(expanded.snapshot)).not.toContain('Second');
    await page.setContent('<button>Save</button>');
    const plain = await d.find(tab, { query: "Save" });
    expect(await d.expand(tab, { observationId: plain.observationId, ref: plain.candidates[0].ref })).toMatchObject({ status: 'unavailable', snapshot: [], limitations: expect.arrayContaining([expect.stringMatching(/snapshot|screenshot/)]) });
  });
  it("never starts scoped snapshots that can poison legacy refs on error or cancellation", async () => {
    const d = discovery();
    await page.setContent('<section aria-label="First"><button>Save first</button></section><section aria-label="Second"><button>Save second</button></section>');
    const nativeTarget = tab.targetLocator; let scopedCalls = 0;
    tab.targetLocator = async function (...args: any[]) {
      const result = await nativeTarget.apply(this, args); const nativeScoped = result.locator.ariaSnapshotJSON.bind(result.locator);
      result.locator.ariaSnapshotJSON = async (...options: any[]) => { scopedCalls++; await nativeScoped(...options); throw new Error('forced scoped failure'); };
      return result;
    };
    try {
      const result = await d.find(tab, { query: "Save" });
      await expect(d.expand(tab, { observationId: result.observationId, ref: result.candidates[0].ref })).resolves.toHaveProperty('snapshot');
      expect(scopedCalls).toBe(0);
      const abort = new AbortController(); const nativeSnapshot = page.ariaSnapshotJSON.bind(page);
      page.ariaSnapshotJSON = async (...args: any[]) => { const tree = await nativeSnapshot(...args); abort.abort(); return tree; };
      try { await expect(d.expand(tab, { observationId: result.observationId, ref: result.candidates[0].ref }, { signal: abort.signal })).rejects.toThrow(/cancel/); }
      finally { page.ariaSnapshotJSON = nativeSnapshot; }
      expect(await (await nativeTarget.call(tab, { target: result.candidates[1].ref })).locator.innerText()).toBe('Save second');
    } finally { tab.targetLocator = nativeTarget; }
  });
  it("disposes frozen native node and document handles on invalidation and interrupted discovery", async () => {
    const d = discovery(); await page.setContent('<section aria-label="Profile"><button>Save</button></section>');
    const acquired = new Map<any, boolean>();
    const track = (handle: any) => {
      if (!acquired.has(handle)) {
        acquired.set(handle, false); const dispose = handle.dispose.bind(handle);
        handle.dispose = async () => { acquired.set(handle, true); await dispose(); };
      }
      return handle;
    };
    const nativeDocument = page.evaluateHandle.bind(page); const nativeTarget = tab.targetLocator;
    page.evaluateHandle = async (...args: any[]) => track(await nativeDocument(...args));
    tab.targetLocator = async function (...args: any[]) {
      const result = await nativeTarget.apply(this, args); const elementHandle = result.locator.elementHandle.bind(result.locator);
      result.locator.elementHandle = async (...options: any[]) => track(await elementHandle(...options));
      return result;
    };
    try {
      const result = await d.find(tab, { query: "Save" });
      expect([...acquired.values()].some(disposed => !disposed)).toBe(true);
      d.invalidate(tab, result.observationId);
      expect([...acquired.values()].every(Boolean)).toBe(true);
      acquired.clear(); const abort = new AbortController(); const nativeSnapshot = page.ariaSnapshotJSON.bind(page); let reads = 0;
      page.ariaSnapshotJSON = async (...args: any[]) => { const tree = await nativeSnapshot(...args); if (++reads === 2) abort.abort(); return tree; };
      try { await expect(d.find(tab, { query: "Save" }, { signal: abort.signal })).rejects.toThrow(/cancel/); }
      finally { page.ariaSnapshotJSON = nativeSnapshot; }
      expect(acquired.size).toBeGreaterThan(2); expect([...acquired.values()].every(Boolean)).toBe(true);
    } finally { page.evaluateHandle = nativeDocument; tab.targetLocator = nativeTarget; d.revoke(); }
  });
  it("keeps scaled iframe geometry unknown rather than asserting a reliable point mapping", async () => {
    const d = discovery(); await page.setContent('<iframe style="transform:scale(.8);transform-origin:top left" srcdoc="<button>Save scaled</button>"></iframe>');
    await page.frameLocator('iframe').getByRole('button').waitFor();
    const result = await d.find(tab, { query: "Save scaled" });
    expect(result.candidates[0]).toMatchObject({ blocked: null, available: null });
    expect(result.limitations).toContain('Some target states are unknown; do not act without another observation.');
  });
});
