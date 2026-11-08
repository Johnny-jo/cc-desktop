// Run after desktop build + dist:dir, with the configured CPA already listening.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const require = createRequire(path.join(desktop, "package.json"));
const { _electron } = createRequire(require.resolve("@playwright/mcp/package.json"))("playwright");
const source = process.env.CC_DESKTOP_TEST_SOURCE_PROFILE ?? path.join(process.env.APPDATA, "@claude-desktop/desktop");
const readJson = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const current = readJson(source, "settings.json");
assert.ok(current.tokenEnc && current.defaultModel && current.cpaPort, "A configured CPA profile is required");
await fetch(`http://127.0.0.1:${current.cpaPort}/`, { signal: AbortSignal.timeout(3000) });
const tempRoot = realpathSync(tmpdir());
const scratch = mkdtempSync(path.join(tempRoot, "cc-browser-acceptance-"));
const profile = path.join(scratch, "desktop");
const project = path.join(scratch, "project");
const fixtures = new Map();
const server = createServer(async (req, res) => {
  const fixture = fixtures.get(req.url);
  if (!fixture) { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.method === "GET") {
    res.end('<form method="post"><label>Test value <input name="value" required></label><button>Submit</button></form>');
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.method !== "POST" || new URLSearchParams(body).get("value") !== fixture.value) {
    res.writeHead(400).end("Incorrect form value"); return;
  }
  fixture.userAgent = req.headers["user-agent"];
  res.end(`<p>Receipt: ${fixture.receipt}</p>`);
});
let app;
let watchdog;
try {
  mkdirSync(profile); mkdirSync(project);
  // Reuse only the OS-encrypted token and encryption metadata in the disposable profile.
  writeFileSync(path.join(profile, "Local State"), JSON.stringify({ os_crypt: readJson(source, "Local State").os_crypt }));
  writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
    setupCompleted: true, tokenEnc: current.tokenEnc, cpaPort: current.cpaPort,
    defaultModel: current.defaultModel, models: [current.defaultModel], lastProjectPath: project,
    photoFlowEnabled: false, locale: "zh", permissionMode: "default",
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(scratch, "claude") };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: path.join(desktop, "release/win-unpacked/CC Desktop.exe"),
    args: [`--user-data-dir=${profile}`], env, cwd: project, timeout: 30000,
  });
  assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), profile);
  watchdog = setTimeout(() => { void app.close(); }, 240000);
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await page.waitForFunction(() => window.desktop?.getSettings !== undefined);
  assert.ok(await page.evaluate(async () => (await window.desktop.getSettings()).hasToken), "CPA token decrypt failed");
  await page.getByRole("button", { name: "设置", exact: true }).first().click();
  await page.getByRole("button", { name: /^操控/ }).click();

  for (const browser of ["chrome", "msedge"]) {
    const label = browser === "chrome" ? "Google Chrome" : "Microsoft Edge";
    const route = "/" + randomUUID();
    const fixture = { value: randomUUID(), receipt: "CC-" + randomUUID() };
    fixtures.set(route, fixture);
    const url = `http://127.0.0.1:${server.address().port}${route}`;
    if (browser === "msedge") await page.getByRole("switch", { name: "Google Chrome操控" }).click();
    await page.getByRole("switch", { name: label + "操控" }).click();
    await page.getByRole("button", { name: "管理" + label + "配置" }).click();
    await page.getByLabel("浏览器模式").selectOption("isolated");
    await page.getByRole("button", { name: "保存更改" }).click();
    await page.waitForFunction(async channel => Object.values((await window.desktop.getSettings()).mcpServers ?? {})
      .some(config => config.type === "playwright" && config.browser === channel && config.connection === "isolated"), browser);
    const serverName = await page.getByLabel("配置名称", { exact: true }).inputValue();
    await page.getByRole("button", { name: "测试连接" }).click();
    await page.getByText("测试通过 1 / 1 · " + serverName, { exact: true }).waitFor({ timeout: 45000 });
    const result = await page.evaluate(async ({ url, value, project, serverName }) => {
      const api = window.desktop;
      const toolNames = [];
      const prefix = `mcp__${serverName}__browser_`;
      const stop = api.on("session:event", event => {
        if (event.type === "tool_start") toolNames.push(event.tool.name);
      });
      const permit = api.on("permission:request", request => {
        const allowed = request.toolName === "ToolSearch" || (request.toolName.startsWith(prefix) &&
          ["navigate", "snapshot", "click", "type", "fill_form", "press_key"].includes(request.toolName.slice(prefix.length)));
        const input = request.inputPreview;
        const safeUrl = request.toolName !== prefix + "navigate" || input?.url === url;
        void api.respondPermission(request.requestId, allowed && safeUrl ? { behavior: "allow", scope: "once" } : { behavior: "deny" });
      });
      try {
        const { sessionId } = await api.startSession({
          text: `Use ONLY the browser MCP (discover tools with ToolSearch if needed). Open ${url}, enter ${value} into Test value, click Submit, and reply with the receipt displayed on the resulting page. Only use navigate, snapshot, type/fill_form, click or press_key. Do not use any shell or code execution.`,
          attachments: [],
        }, project);
        const transcript = await api.selectSession(sessionId);
        return { toolNames, reply: transcript.items.filter(i => i.kind === "text" && i.role === "assistant").map(i => i.text).join("\n") };
      } finally { stop(); permit(); }
    }, { url, value: fixture.value, project, serverName });
    console.log(JSON.stringify({ browser, model: current.defaultModel, tools: result.toolNames }));
    assert.ok(result.toolNames.includes(`mcp__${serverName}__browser_navigate`), "Expected a real browser MCP navigation");
    assert.ok(fixture.userAgent?.includes("Chrome/"), "Expected a Chromium browser form POST");
    assert.equal(fixture.userAgent.includes("Edg/"), browser === "msedge", "Wrong browser channel");
    assert.ok(result.reply.includes(fixture.receipt), "Model did not read back the server-issued receipt");
    console.log(JSON.stringify({ browser, receipt: fixture.receipt, result: "passed" }));
  }
} finally {
  clearTimeout(watchdog);
  try { await app?.close(); } finally {
    server.closeAllConnections(); server.close();
    const target = realpathSync(scratch);
    assert.equal(path.dirname(target), tempRoot);
    assert.ok(path.basename(target).startsWith("cc-browser-acceptance-"));
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
