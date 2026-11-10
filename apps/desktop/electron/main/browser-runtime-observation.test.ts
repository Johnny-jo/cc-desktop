import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
const { chromium } = mcpRequire("playwright");
const modulePath = path.resolve("resources/playwright-mcp/browser-observation.cjs");
let observation: any = {};
try { observation = require(modulePath); } catch (error: any) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
let browser: any; let page: any;
beforeAll(async () => { browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }); page = await browser.newPage({ viewport: { width: 480, height: 320 }, deviceScaleFactor: 2 }); });
afterAll(async () => { await browser?.close(); });

describe("read-only browser observations", () => {
  it("observes exact URL and visible text without clicking or navigating", async () => {
    expect(typeof observation.verifyPage).toBe("function");
    await page.setContent('<button onclick="window.writes++">Confirm</button><span hidden>secret</span><script>window.writes=0</script>');
    const result = await observation.verifyPage(page, { url: "about:blank", text: "Confirm", timeoutMs: 0 });
    expect(result).toMatchObject({ status: "observed", url: "about:blank", conditions: { url: true, text: true } });
    expect(result.page).toBeTruthy(); expect(Number.isNaN(Date.parse(result.observedAt))).toBe(false);
    expect((await observation.verifyPage(page, { text: "secret", timeoutMs: 0 })).status).toBe("not_observed");
    expect((await observation.verifyPage(page, { url: "about:blan", timeoutMs: 0 })).status).toBe("not_observed");
    expect(await page.evaluate(() => (window as any).writes)).toBe(0);
  });

  it("waits for a visible result, reports unavailable for missing pages, and does not infer success", async () => {
    expect(typeof observation.verifyPage).toBe("function");
    await page.setContent('<div id="result"></div><script>setTimeout(()=>document.querySelector("#result").innerText="Saved",80)</script>');
    expect((await observation.verifyPage(page, { text: "Saved", timeoutMs: 1000 })).status).toBe("observed");
    expect((await observation.verifyPage(undefined, { text: "Saved", timeoutMs: 0 })).status).toBe("unavailable");
    expect((await observation.verifyPage(page, { timeoutMs: 0 })).status).toBe("unavailable");
    expect((await observation.verifyPage(page, { text: "Saved", timeoutMs: 0 }, { isActive: () => false })).status).toBe("unavailable");
  });

  it("adds metadata from the actual upstream screenshot buffer for a named file without taking another screenshot", async () => {
    expect(typeof observation.withScreenshotMetadata).toBe("function");
    let captures = 0; const texts: string[] = [];
    const tool = { schema: { name: "browser_take_screenshot" }, handle: async (_context: any, params: any, response: any) => {
      captures++; await response.addFileResult({ absoluteName: "fixture.png" }, await page.screenshot({ scale: params.scale }));
    } };
    const wrapped = observation.withScreenshotMetadata(tool);
    await wrapped.handle({ currentTab: () => ({ page }) }, { filename: "fixture.png", scale: "device" }, {
      addFileResult: async () => {}, addTextResult: (text: string) => texts.push(text),
    });
    expect(captures).toBe(1);
    const result = JSON.parse(texts[0]);
    expect(result).toMatchObject({ screenshot: { page: expect.any(String), url: "about:blank", viewport: { width: 480, height: 320 }, pixels: { width: 960, height: 640 }, scale: "device", devicePixelRatio: 2 } });
  });

  it("keeps a successful screenshot if metadata cannot be read", async () => {
    const texts: string[] = []; let files = 0;
    const page = { _guid: "fixture", url: () => "https://fixture.test/", evaluate: async () => { throw new Error("page navigated"); } };
    const tool = { schema: { name: "browser_take_screenshot" }, handle: async (_context: any, _input: any, response: any) => {
      await response.addFileResult({}, Buffer.alloc(0));
    } };
    await expect(observation.withScreenshotMetadata(tool).handle({ currentTab: () => ({ page }) }, {}, {
      addFileResult: async () => { files++; }, addTextResult: (text: string) => texts.push(text),
    })).resolves.toBeUndefined();
    expect(files).toBe(1); expect(JSON.parse(texts[0]).screenshot.status).toBe("unavailable");
  });

  it("does not pair a screenshot with coordinates from a replacement document", async () => {
    const texts: string[] = []; let reads = 0;
    const page = { _guid: "fixture", url: () => "https://fixture.test/", evaluate: async () => ({
      url: "https://fixture.test/", document: ++reads, width: 480, height: 320, devicePixelRatio: 1,
    }) };
    const tool = { schema: { name: "browser_take_screenshot" }, handle: async () => {} };
    await observation.withScreenshotMetadata(tool).handle({ currentTab: () => ({ page }) }, {}, { addTextResult: (text: string) => texts.push(text) });
    const metadata = JSON.parse(texts[0]).screenshot;
    expect(metadata.status).toBe("unavailable"); expect(metadata.viewport).toBeUndefined();
  });

  it("returns the already captured screenshot when its final metadata read never resolves", async () => {
    const texts: string[] = []; let reads = 0; let files = 0;
    const page = { _guid: "fixture", evaluate: () => ++reads === 1
      ? Promise.resolve({ url: "https://fixture.test/", document: 1, width: 480, height: 320, devicePixelRatio: 1 })
      : new Promise(() => {}) };
    const tool = { schema: { name: "browser_take_screenshot" }, handle: async (_context: any, _input: any, response: any) => {
      await response.addFileResult({}, Buffer.alloc(0));
    } };
    const capturing = observation.withScreenshotMetadata(tool).handle({ currentTab: () => ({ page }) }, {}, {
      addFileResult: async () => { files++; }, addTextResult: (text: string) => texts.push(text),
    });
    expect(await Promise.race([capturing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1000))])).toBe(true);
    expect(files).toBe(1); expect(JSON.parse(texts[0]).screenshot.status).toBe("unavailable");
  });
});
