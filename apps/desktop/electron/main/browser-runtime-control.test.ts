import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
const { tools } = mcpRequire("playwright-core/lib/coreBundle");
const { chromium } = mcpRequire("playwright");
const { z } = mcpRequire("playwright-core/lib/utilsBundle");
const controlPath = path.resolve("resources/playwright-mcp/control.cjs");
const localRequire = createRequire(controlPath);

function harness(connection: string, endpoint = "", override: Record<string, any> = {}, env: Record<string, string> = {}) {
  const proc = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), argv: ["node", controlPath, "chrome", connection, "Fixture", "", endpoint], env: { ...process.env, AGENTOS_BROWSER_AUTH_STORE: "must-not-be-read-for-cdp", ...env }, exitCode: 0 });
  let options: any;
  const ready = new Promise<any>((resolve, reject) => {
    const runtimeTools = { ...tools, ...override, start: async (value: any) => { options = value; resolve(value); } };
    const specialRequire = (name: string): any => {
      if (name === "node:module") return { createRequire: () => (id: string) => id === "playwright-core/lib/coreBundle" ? { tools: runtimeTools } : mcpRequire(id) };
      if (["./browser-data.cjs", "./extension-setup.cjs", "./browser-auth.cjs"].includes(name)) return new Proxy({}, { get: () => () => { throw new Error(`CDP unexpectedly accessed ${name}`); } });
      return localRequire(name);
    };
    specialRequire.resolve = localRequire.resolve;
    vm.runInNewContext(fs.readFileSync(controlPath, "utf8"), { require: specialRequire, module: { exports: {} }, process: proc, console: { ...console, error: (error: string) => reject(new Error(error)) } }, { filename: controlPath });
  });
  return { proc, ready, get options() { return options; } };
}
let fixture: any; let originalPage: any; let endpoint: string;
beforeAll(async () => {
  const port = await new Promise<number>(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port)); }); });
  endpoint = `http://127.0.0.1:${port}`;
  fixture = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: [`--remote-debugging-port=${port}`] });
  originalPage = await fixture.newPage(); await originalPage.setContent("<button>Fixture original page</button>");
});
afterAll(async () => { await fixture?.close(); });

describe("browser control CDP integration", () => {
  it("keeps isolated ownership even when inherited Playwright environment points at another browser", async () => {
    let observed: any;
    const runtime = harness("isolated", "", { createBrowserWithInfo: async (config: any) => { observed = config; throw new Error("fixture stopped before browser launch"); } }, {
      PLAYWRIGHT_MCP_CDP_ENDPOINT: "http://127.0.0.1:1", PLAYWRIGHT_MCP_EXTENSION: "true",
    });
    await expect((await runtime.ready).create({ cwd: process.cwd() })).rejects.toThrow("fixture stopped before browser launch");
    expect(observed.browser.cdpEndpoint).toBeUndefined(); expect(observed.extension).toBe(false); expect(observed.browser.isolated).toBe(true);
  });

  it("rejects unsafe CLI endpoints before starting any browser connection", async () => {
    for (const endpoint of ["http://user:secret@localhost:9222", "http://localhost:9222/?token=secret", "http://localhost:9222/#fragment", "http://local\nhost:9222/"]) {
      await expect(harness("cdp", endpoint).ready).rejects.toThrow(/CDP/);
    }
  });

  it("attaches without profile or extension access and releases both transports while preserving the original page", async () => {
    const runtime = harness("cdp", endpoint); const options = await runtime.ready;
    expect(options.toolSchemas.map((schema: any) => schema.name)).toContain("browser_verify");
    expect(options.toolSchemas.map((schema: any) => schema.name)).not.toContain("browser_search_history");
    const backend = await options.create({ cwd: process.cwd(), clientName: "fixture" });
    await backend.initialize({ cwd: process.cwd(), clientName: "fixture" });
    await backend.callTool("browser_tabs", { action: "list" });
    const verify = await backend.callTool("browser_verify", { text: "Fixture original page", timeoutMs: 0 });
    expect(verify.content[0].text).toContain('"status":"observed"');
    await backend.callTool("browser_release_control", {});
    await expect(backend.callTool("browser_snapshot", {})).rejects.toThrow(/取消|released|cancelled/);
    await backend.dispose();
    expect(originalPage.isClosed()).toBe(false);
    expect(await originalPage.locator("button").innerText()).toBe("Fixture original page");
    expect(fixture.isConnected()).toBe(true);
  }, 20000);

  it("releases the attached lease on initialization failure and EOF", async () => {
    const failed = harness("cdp", endpoint, { createBrowserWithInfo: async () => { throw new Error("fixture initialization failed"); } });
    await expect((await failed.ready).create({ cwd: process.cwd() })).rejects.toThrow("fixture initialization failed");
    const runtime = harness("cdp", endpoint); const options = await runtime.ready;
    const backend = await options.create({ cwd: process.cwd(), clientName: "fixture" });
    runtime.proc.stdin.emit("end");
    await new Promise(resolve => setTimeout(resolve, 100));
    const next = harness("cdp", endpoint); const nextBackend = await (await next.ready).create({ cwd: process.cwd(), clientName: "fixture" });
    await backend.dispose(); // This stale callback must not close the new backend.
    await nextBackend.initialize({ cwd: process.cwd(), clientName: "fixture" });
    expect((await nextBackend.callTool("browser_tabs", { action: "list" })).isError).not.toBe(true);
    await nextBackend.dispose();
    expect(originalPage.isClosed()).toBe(false);
  }, 20000);

  it("cancels queued writes through the page's cancel binding", async () => {
    let entered!: () => void; let finish!: () => void; let writes = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const blocking = new Promise<void>(resolve => { finish = resolve; });
    const runtime = harness("cdp", endpoint, { filteredTools: (config: any) => [...tools.filteredTools(config), {
      schema: { name: "fixture_hold", title: "Fixture", description: "Fixture", inputSchema: z.object({}), type: "action" },
      handle: async () => { entered(); await blocking; },
    }, {
      schema: { name: "fixture_write", title: "Fixture", description: "Fixture", inputSchema: z.object({}), type: "action" },
      handle: async () => { writes++; },
    }] });
    const backend = await (await runtime.ready).create({ cwd: process.cwd(), clientName: "fixture" });
    await backend.initialize({ cwd: process.cwd(), clientName: "fixture" });
    const first = backend.callTool("fixture_hold", {}).catch((error: Error) => error.message);
    await waiting;
    const second = backend.callTool("fixture_write", {}).catch((error: Error) => error.message);
    await originalPage.evaluate(() => { void (window as any).__agentOSBrowserControl("cancel"); });
    await new Promise(resolve => setTimeout(resolve, 100));
    finish();
    expect(await first).toMatch(/取消/); expect(await second).toMatch(/取消/);
    expect(writes).toBe(0);
    await backend.dispose();
    expect(originalPage.isClosed()).toBe(false);
  }, 20000);

  it("rejects actions as soon as disposal begins, before asynchronous backend cleanup finishes", async () => {
    let entered!: () => void; let finish!: () => void; let writes = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const blocking = new Promise<void>(resolve => { finish = resolve; });
    class SlowBackend {
      cleanup: () => Promise<void>;
      constructor(_config: any, _context: any, _definitions: any, options: any) { this.cleanup = options.dispose; }
      async dispose() { entered(); await blocking; await this.cleanup(); }
      async callTool() { writes++; return {}; }
    }
    const runtime = harness("cdp", endpoint, { BrowserBackend: SlowBackend });
    const backend = await (await runtime.ready).create({ cwd: process.cwd(), clientName: "fixture" });
    const disposing = backend.dispose(); await waiting;
    const action = backend.callTool("fixture_write", {}).catch((error: Error) => error.message);
    await new Promise(resolve => setTimeout(resolve, 20));
    finish(); await disposing;
    expect(await action).toMatch(/取消/); expect(writes).toBe(0);
  }, 20000);

  it("continues attaching and stops queued actions when decorative frame evaluation is stuck", async () => {
    let unstick!: () => void; let writes = 0;
    const stuck = new Promise<void>(resolve => { unstick = resolve; });
    class CountingBackend {
      cleanup: () => Promise<void>;
      constructor(_config: any, _context: any, _definitions: any, options: any) { this.cleanup = options.dispose; }
      async dispose() { await this.cleanup(); }
      async callTool() { writes++; return {}; }
    }
    const runtime = harness("cdp", endpoint, { BrowserBackend: CountingBackend, createBrowserWithInfo: async (...args: any[]) => {
      const info = await tools.createBrowserWithInfo(...args);
      for (const page of info.browser.contexts()[0].pages()) for (const frame of page.frames()) frame.evaluate = () => stuck;
      return info;
    } });
    const creating = (await runtime.ready).create({ cwd: process.cwd(), clientName: "fixture" });
    const ready = await Promise.race([creating.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1500))]);
    if (!ready) { unstick(); await (await creating).dispose(); }
    expect(ready).toBe(true);
    const backend = await creating;
    const action = backend.callTool("fixture_write", {}).catch((error: Error) => error.message);
    await new Promise(resolve => setTimeout(resolve, 20));
    const releasing = backend.callTool("browser_release_control", {});
    expect(await action).toMatch(/取消/);
    await releasing; unstick(); await backend.dispose();
    expect(writes).toBe(0); expect(originalPage.isClosed()).toBe(false);
  }, 20000);
});
