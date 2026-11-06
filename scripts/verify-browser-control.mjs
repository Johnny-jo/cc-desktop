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
const dist = path.join(desktop, "release/win-unpacked");
const executable = packaged ? path.join(dist, "CC Desktop.exe") : process.execPath;
const resources = path.join(packaged ? dist : desktop, "resources");
const fixture = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "style-src 'none'" });
  res.end(`<title>Control fixture</title><button id="go" onclick="this.textContent='Clicked'">Go</button>
    <button id="later" disabled onclick="fetch('/unexpected')">Later</button>
    <script>new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-agentos-browser-control="cancelled"]')) return;
      observer.disconnect();
      document.getElementById('later').disabled = false;
      fetch('/released?tab=' + encodeURIComponent(location.pathname));
    }).observe(document, { subtree:true, attributes:true, attributeFilter:['data-agentos-browser-control'] })</script>`);
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + fixture.address().port + "/";
const temp = realpathSync(tmpdir());
const scratch = mkdtempSync(path.join(temp, "cc-control-"));
const rejected = [];
const released = new Set();
fixture.on("request", req => {
  if (req.url === "/unexpected") rejected.push(req.url);
  if (req.url.startsWith("/released?")) released.add(new URL(req.url, url).searchParams.get("tab"));
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
  const registry = path.join(scratch, channel);
  const client = new Client({ name: "control-test", version: "1" });
  const transport = new StdioClientTransport({ command: executable,
    args: [path.join(resources, "playwright-mcp/control.cjs"), channel],
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
    assert.ok((await inspect(cdp)).some(n => n.nodeValue === "AgentOS 正在控制中"));
    const snapshot = await ok("browser_snapshot");
    const ref = label => {
      const line = snapshot.split("\n").find(s => s.includes('button "' + label + '"'));
      assert.ok(line, snapshot);
      return line.match(/\[ref=([^\]]+)\]/)[1];
    };
    await ok("browser_click", { target: ref("Go"), element: "Go" });
    assert.equal(await page.locator("#go").textContent(), "Clicked");
    const cursor = (await inspect(cdp)).find(n => n.localName === "x-pw-action-cursor");
    assert.match((cursor?.attributes || []).join(" "), /visibility:\s*visible/);
    const other = await context.newPage();
    await other.goto(url + "second");
    await other.reload();
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
    await other.bringToFront();
    await other.mouse.click(bounds.x + bounds.width - 35, bounds.y + bounds.height / 2).catch(() => {});
    const interrupted = await pending;
    assert.ok(interrupted.isError, "Pending click must fail after cancellation");
    const result = await call("browser_navigate", { url: url + "forbidden" });
    assert.ok(result.isError && JSON.stringify(result.content).includes("用户已取消"), JSON.stringify(result));
    for (let i = 0; i < 40 && released.size < 2; i++) await sleep(100);
    assert.deepEqual([...released].sort(), ["/", "/second"], "Both pages should survive cancellation and release the disabled button");
    assert.deepEqual(rejected, []);
    console.log(channel + ": live cursor, indicator after reload, cross-tab cancellation, pending and subsequent calls blocked");
  } finally {
    await observer?.close().catch(() => {});
    await client.close();
  }
}
try {
  for (const channel of ["chrome", "msedge"]) await verify(channel);
} finally {
  fixture.closeAllConnections(); fixture.close();
  const target = realpathSync(scratch);
  assert.equal(path.dirname(target), temp);
  assert.ok(path.basename(target).startsWith("cc-control-"));
  rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
