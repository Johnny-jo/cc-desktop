// Run with --packaged after dist:dir to test the actual Windows distribution.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const lib = createRequire(require.resolve("@playwright/mcp/package.json"));
const { chromium } = lib("playwright");
const { Client, StdioClientTransport } = lib("playwright-core/lib/utilsBundle");
const packaged = process.argv.includes("--packaged");
const cursorIdleOnly = process.argv.includes("--cursor-idle-only");
const channelArg = process.argv.find(arg => arg.startsWith("--browser="))?.split("=")[1];
const screenshotPath = process.argv.find(arg => arg.startsWith("--screenshot="))?.slice("--screenshot=".length);
if (channelArg && !["chrome", "msedge"].includes(channelArg)) throw new Error("Expected --browser=chrome or --browser=msedge");
const dist = path.join(desktop, "release/win-unpacked");
const executable = packaged ? path.join(dist, "CC Desktop.exe") : process.execPath;
const resources = path.join(packaged ? dist : desktop, "resources");
const installIndicator = require(path.join(resources, "playwright-mcp/indicator.cjs"));
const { observeAutomationPointer } = require(path.join(resources, "playwright-mcp/pointer-source.cjs"));
const fixture = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "style-src 'none'" });
  if (req.url === "/frame") {
    res.end('<button id="inside" onclick="this.textContent=\'Frame clicked\'">Inside</button>');
    return;
  }
  res.end(`<title>Control fixture</title><button id="go" onclick="this.textContent='Clicked'">Go</button>
    <button id="later" disabled onclick="fetch('/unexpected')">Later</button>
    <iframe id="frame" title="Embedded fixture" src="/frame"></iframe>
    <script>new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-agentos-browser-control="cancelled"]')) return;
      observer.disconnect();
      document.getElementById('later').disabled = false;
      fetch('/released?tab=' + encodeURIComponent(location.pathname));
      setTimeout(() => fetch('/survived?tab=' + encodeURIComponent(location.pathname)
        + '&title=' + encodeURIComponent(document.title)
        + '&pointer=' + document.querySelectorAll('[data-agentos-browser-pointer="active"]').length), 300);
    }).observe(document, { subtree:true, attributes:true, attributeFilter:['data-agentos-browser-control'] });
    document.getElementById('frame').style.cssText = 'position:fixed;left:300px;top:300px;width:300px;height:150px';</script>`);
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + fixture.address().port + "/";
const temp = realpathSync(tmpdir());
const scratch = mkdtempSync(path.join(temp, "cc-control-"));
const rejected = [];
const released = new Set();
const surviving = new Map();
fixture.on("request", req => {
  if (req.url === "/unexpected") rejected.push(req.url);
  if (req.url.startsWith("/released?")) released.add(new URL(req.url, url).searchParams.get("tab"));
  if (req.url.startsWith("/survived?")) {
    const params = new URL(req.url, url).searchParams;
    surviving.set(params.get("tab"), { title: params.get("title"), pointer: params.get("pointer") });
  }
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// DevTools can inspect the closed shadow roots used by both the control button
// and Playwright's cursor. Page code cannot normally select either element.
async function inspect(cdp) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child);
  }
  visit(root);
  return nodes;
}

async function verify(channel) {
  released.clear();
  surviving.clear();
  const registry = path.join(scratch, channel);
  const client = new Client({ name: "control-test", version: "1" });
  const transport = new StdioClientTransport({ command: executable,
    args: [path.join(resources, "playwright-mcp/control.cjs"), channel, "isolated", "请帮我分析销售趋势，列出异常原因"],
    cwd: scratch, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PWTEST_SERVER_REGISTRY: registry }, stderr: "inherit" });
  let observer;
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const ok = async (name, args) => {
    const result = await call(name, args);
    const resultText = result.content.map(block => block.text ?? "").join("\n");
    assert.ok(!result.isError, resultText);
    return resultText;
  };
  try {
    await client.connect(transport);
    await ok("browser_navigate", { url });
    await ok("browser_close");
    await ok("browser_navigate", { url });
    const descriptor = JSON.parse(readFileSync(path.join(registry, readdirSync(registry)[0]), "utf8"));
    observer = await chromium.connect(descriptor.endpoint);
    const context = observer.contexts()[0];
    const page = context.pages().find(p => p.url() === url);
    assert.ok(page);
    const cdp = await context.newCDPSession(page);
    await page.locator("[data-agentos-browser-control]").waitFor();
    assert.ok((await inspect(cdp)).some(n => n.nodeValue === "AgentOS：分析销售趋势"));
    assert.equal(await page.title(), "AgentOS：分析销售趋势｜Control fixture");
    const initialPointer = page.locator('[data-agentos-browser-pointer="active"]');
    await initialPointer.waitFor({ state: "visible" });
    if (screenshotPath) {
      const box = await initialPointer.boundingBox();
      assert.ok(box);
      await page.screenshot({ path: screenshotPath, clip: { x: Math.max(0, box.x - 30), y: Math.max(0, box.y - 25), width: 180, height: 120 } });
    }
    const snapshot = await ok("browser_snapshot");
    const ref = label => {
      const line = snapshot.split("\n").find(s => s.includes('button "' + label + '"'));
      assert.ok(line, snapshot);
      return line.match(/\[ref=([^\]]+)\]/)[1];
    };
    await ok("browser_click", { target: ref("Go"), element: "Go" });
    assert.equal(await page.locator("#go").textContent(), "Clicked");
    await page.waitForFunction(() => {
      const rect = document.querySelector('[data-agentos-browser-pointer="active"]')?.getBoundingClientRect();
      return rect && rect.x < 60 && rect.y < 60;
    }, undefined, { timeout: 3000 });
    await ok("browser_click", { target: ref("Inside"), element: "Inside embedded frame" });
    await page.waitForFunction(() => {
      const rect = document.querySelector('[data-agentos-browser-pointer="active"]')?.getBoundingClientRect();
      return rect && rect.x > 300 && rect.y > 300;
    }, undefined, { timeout: 3000 });
    assert.equal(await page.frameLocator("#frame").locator("#inside").textContent(), "Frame clicked");
    const other = await context.newPage();
    await other.goto(url + "second");
    await other.reload();
    assert.equal(await other.title(), "AgentOS：分析销售趋势｜Control fixture");
    await other.evaluate(() => {
      const dialog = document.createElement("dialog");
      dialog.textContent = "Fixture dialog";
      document.body.append(dialog);
      dialog.showModal();
    });
    const host = other.locator("dialog:modal [data-agentos-browser-control]");
    await host.waitFor();
    const bounds = await host.boundingBox();
    // An Agent action is waiting on a disabled button in the controlled page.
    // A separate browser client supplies the user's trusted pointer click.
    await page.bringToFront();
    let done = false;
    const pending = call("browser_click", { target: ref("Later"), element: "Later" }).finally(() => { done = true; });
    await sleep(150);
    assert.equal(done, false, "The disabled button should have a pending click");
    const parked = await page.locator('[data-agentos-browser-pointer="active"]').boundingBox();
    assert.ok(parked);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 180 });
    await sleep(150);
    assert.deepEqual(await page.locator('[data-agentos-browser-pointer="active"]').boundingBox(), parked,
      "A physical mouse move during an Agent action must not move the virtual pointer");
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 370 });
    await sleep(150);
    assert.deepEqual(await page.locator('[data-agentos-browser-pointer="active"]').boundingBox(), parked,
      "A physical mouse move inside an iframe during an Agent action must not move the virtual pointer");
    await other.bringToFront();
    await other.mouse.click(bounds.x + bounds.width - 35, bounds.y + bounds.height / 2).catch(() => {});
    const interrupted = await pending;
    assert.ok(interrupted.isError, "Pending click must fail after cancellation");
    const result = await call("browser_navigate", { url: url + "forbidden" });
    assert.ok(result.isError && JSON.stringify(result.content).includes("用户已取消"), JSON.stringify(result));
    for (let i = 0; i < 40 && released.size < 2; i++) await sleep(100);
    assert.deepEqual([...released].sort(), ["/", "/second"], "Both pages should survive cancellation and release the disabled button");
    assert.deepEqual(rejected, []);
    // unbind deliberately disconnects the observer too. The fixture reports its
    // own state after cancellation, proving the actual user tabs stay alive.
    for (let i = 0; i < 40 && surviving.size < 2; i++) await sleep(100);
    assert.deepEqual([...surviving.keys()].sort(), ["/", "/second"]);
    for (const state of surviving.values()) assert.deepEqual(state, { title: "Control fixture", pointer: "0" });
    const dataAfterCancel = await call("browser_search_bookmarks", { query: "fixture" });
    assert.ok(dataAfterCancel.isError && JSON.stringify(dataAfterCancel.content).includes("用户已取消"), "Revocation rejects subsequent calls before tool lookup");
    console.log(channel + ": initial pointer, iframe click, 10-character session label, title after reload, cross-tab cancellation and subsequent-call blocking passed");
  } finally {
    await observer?.close().catch(() => {});
    await client.close();
  }
}
async function verifyReattach(channel) {
  const browser = await chromium.launch({ channel, headless: true });
  try {
    const context = await browser.newContext();
    await context.exposeBinding("__agentOSBrowserControl", () => ({ active: true, running: true }));
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(installIndicator, { label: "AgentOS：第一个对话" });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agentos-control-change", { detail: { active: false } })));
    assert.equal(await page.title(), "Control fixture");
    await page.evaluate(installIndicator, { label: "AgentOS：第二个对话" });
    await page.waitForFunction(() => document.title === "AgentOS：第二个对话｜Control fixture");
    assert.equal(await page.locator('[data-agentos-browser-control="active"]').count(), 1);
    assert.equal(await page.locator('[data-agentos-browser-pointer="active"]').count(), 1);
    const cdp = await context.newCDPSession(page);
    const nodes = await inspect(cdp);
    assert.ok(nodes.some(node => node.nodeValue === "AgentOS：第二个对话"));
    assert.ok(!nodes.some(node => node.nodeValue === "AgentOS：第一个对话"));
    await page.evaluate(() => { document.title = "Site updated title"; });
    await page.waitForFunction(() => document.title === "AgentOS：第二个对话｜Site updated title");
    console.log(channel + ": same-page reattach replaces old label, restores cursor and tracks site title changes");
  } finally {
    await browser.close();
  }
}
async function verifyPersistentCursor(channel) {
  const browser = await chromium.launch({ channel, headless: true });
  let failStatusOnce = false;
  let failCancelOnce = false;
  let active = true;
  let statusCalls = 0;
  let cancelCalls = 0;
  let agentRunning = false;
  try {
    const context = await browser.newContext();
    observeAutomationPointer(context, { isActive: () => active && agentRunning });
    await context.exposeBinding("__agentOSBrowserControl", (_source, action) => {
      if (action === "cancel") {
        cancelCalls++;
        if (failCancelOnce) { failCancelOnce = false; throw new Error("Synthetic temporary cancel disconnect"); }
        active = false;
        return { active: false, running: false };
      }
      statusCalls++;
      if (failStatusOnce) { failStatusOnce = false; throw new Error("Synthetic temporary disconnect"); }
      return { active, running: false };
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(installIndicator, { label: "AgentOS：鼠标停留验证" });
    const pointer = page.locator('[data-agentos-browser-pointer="active"]');
    await pointer.waitFor({ state: "visible" });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agentos-agent-action", { detail: { running: true } })));
    agentRunning = true;
    await page.mouse.click(175, 160);
    agentRunning = false;
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agentos-agent-action", { detail: { running: false } })));
    await sleep(400);
    const stoppedAt = await pointer.boundingBox();
    assert.ok(stoppedAt && Math.abs(stoppedAt.x - 175) < 1 && Math.abs(stoppedAt.y - 160) < 1);
    await sleep(1000);
    assert.equal(await pointer.isVisible(), true, "An idle pointer must remain visible after an action finishes");
    assert.deepEqual(await pointer.boundingBox(), stoppedAt, "An idle pointer must stay at its last position");
    failStatusOnce = true;
    await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
    await sleep(400);
    assert.equal(await pointer.isVisible(), true, "A temporary connection failure must not remove the parked pointer");
    await sleep(1300);
    assert.deepEqual(await pointer.boundingBox(), stoppedAt, "Reconnecting must preserve the last pointer position");
    await page.mouse.move(430, 220);
    await sleep(150);
    assert.deepEqual(await pointer.boundingBox(), stoppedAt, "A human mouse move while idle must not move the virtual pointer");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("agentos-control-change", { detail: { active: false } })));
    assert.equal(await pointer.count(), 0, "Explicit cancellation removes the parked pointer");

    failStatusOnce = true;
    await page.evaluate(installIndicator, { label: "AgentOS：取消重试验证" });
    await sleep(200);
    failCancelOnce = true;
    const bar = await page.locator('[data-agentos-browser-control="active"]').boundingBox();
    assert.ok(bar);
    await page.mouse.click(bar.x + bar.width - 35, bar.y + bar.height / 2);
    await sleep(150);
    assert.equal(cancelCalls, 1);
    assert.equal(await pointer.isVisible(), true, "A failed cancel request must keep the pointer until the host confirms release");
    await sleep(1300);
    assert.equal(cancelCalls, 2, "Cancellation must retry after the connection recovers");
    assert.equal(active, false, "The host must receive cancellation before the UI reports it");
    assert.equal(await pointer.count(), 0);
    const callsAfterCancel = statusCalls + cancelCalls;
    await sleep(1200);
    assert.equal(statusCalls + cancelCalls, callsAfterCancel, "Confirmed cancellation must stop pending retries");

    active = true;
    failStatusOnce = true;
    await page.evaluate(installIndicator, { label: "AgentOS：释放重试验证" });
    await sleep(200);
    await page.evaluate(() => window.__agentOSDisposeIndicator());
    const callsAfterDispose = statusCalls + cancelCalls;
    await sleep(1200);
    assert.equal(statusCalls + cancelCalls, callsAfterDispose, "Disposal must stop pending reconnect timers");
    console.log(channel + ": parked cursor persists while idle/disconnected, cancellation retries until host confirmation, and cancelled/disposed indicators stop retrying");
  } finally {
    await browser.close();
  }
}

try {
  for (const channel of channelArg ? [channelArg] : ["chrome", "msedge"]) {
    await verifyPersistentCursor(channel);
    if (!cursorIdleOnly) {
      await verify(channel);
      await verifyReattach(channel);
    }
  }
} finally {
  fixture.closeAllConnections(); fixture.close();
  const target = realpathSync(scratch);
  assert.equal(path.dirname(target), temp);
  assert.ok(path.basename(target).startsWith("cc-control-"));
  rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
