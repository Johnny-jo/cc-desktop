// Verify that the distributable includes and can execute the target-discovery resources.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(repo, "apps/desktop");
const require = createRequire(path.join(desktop, "package.json"));
const lib = createRequire(require.resolve("@playwright/mcp/package.json"));
const { chromium } = lib("playwright");
const { Client, StdioClientTransport } = lib("playwright-core/lib/utilsBundle");
const packaged = path.resolve(process.argv[2] ?? path.join(repo, ".tmp/browser-target-package/win-unpacked"));
const resources = path.join(packaged, "resources/playwright-mcp");
for (const name of ["control.cjs", "browser-target-tools.cjs", "browser-targets.cjs"]) {
  assert.deepEqual(fs.readFileSync(path.join(resources, name)), fs.readFileSync(path.join(desktop, "resources/playwright-mcp", name)));
}
const tempRoot = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempRoot, "browser-target-package-"));
const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
});
let browser; let client;
try {
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: [`--remote-debugging-port=${port}`] });
  const page = await browser.newPage();
  await page.setContent('<form aria-label="Profile"><button type="button">Save</button></form>' +
    '<form aria-label="Notifications"><label>Email<input></label><button type="button" onclick="window.saved=(window.saved||0)+1;document.querySelector(\'#result\').textContent=\'Saved notifications\'">Save</button></form><p id="result"></p>');
  client = new Client({ name: "browser-target-package", version: "1" });
  await client.connect(new StdioClientTransport({ command: path.join(packaged, "CC Desktop.exe"),
    args: [path.join(resources, "control.cjs"), "chrome", "cdp", "Target package fixture", "", `http://127.0.0.1:${port}`],
    cwd: scratch, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stderr: "inherit" }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.ok(!result.isError, text);
    return { text, json: () => JSON.parse(text.split("\n").find(line => line.trimStart().startsWith("{"))) };
  };
  const schemas = (await client.listTools()).tools;
  assert.ok(schemas.some(tool => tool.name === "browser_expand_region"));
  await call("browser_tabs", { action: "list" });
  const query = (await call("browser_find", { query: "Save", role: "button", region: "Notifications" })).json();
  assert.equal(query.candidates.length, 1);
  const candidate = query.candidates[0];
  assert.equal(candidate.available, true);
  const expanded = (await call("browser_expand_region", { observationId: query.observationId, ref: candidate.ref })).json();
  assert.ok(JSON.stringify(expanded.snapshot).includes("Email"));
  const acted = await call("browser_click", { target: candidate.ref, element: "Save notifications", observationId: query.observationId });
  assert.equal(acted.json().verifyRequired, true);
  assert.ok(!acted.text.includes("### Snapshot"));
  assert.equal((await call("browser_verify", { text: "Saved notifications", timeoutMs: 0 })).json().status, "observed");
  const stale = await client.callTool({ name: "browser_click", arguments: { target: candidate.ref, observationId: query.observationId } });
  assert.equal(stale.isError, true);
  assert.equal(await page.evaluate(() => window.saved), 1);
  console.log("Packaged browser resources found the real target, expanded its form, guarded one click and verified the result.");
} finally {
  await client?.close().catch(() => {});
  await browser?.close();
  const target = fs.realpathSync(scratch);
  assert.equal(path.dirname(target), tempRoot);
  assert.ok(path.basename(target).startsWith("browser-target-package-"));
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
