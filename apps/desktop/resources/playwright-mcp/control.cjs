const { createRequire } = require("node:module");
const version = require("@playwright/mcp/package.json").version;
const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
const { chromium } = mcpRequire("playwright");
const { tools } = mcpRequire("playwright-core/lib/coreBundle");
const installControlIndicator = require("./indicator.cjs");

const cancelledMessage = "用户已取消 AgentOS 浏览器控制。此连接中的浏览器工具已停用。";

async function start(channel) {
  if (!["chrome", "msedge"].includes(channel)) throw new Error("Expected chrome or msedge");
  let revoked = false;
  let owner;
  let driver;
  let closing = false;
  const config = await tools.resolveCLIConfigForMCP({ browser: channel, isolated: true }, process.env);
  const definitions = tools.filteredTools(config);

  async function revoke(context) {
    if (revoked) return;
    revoked = true;
    // The MCP drives a separate Playwright connection. Disconnecting aborts
    // pending auto-waits while the owning connection keeps the user's tabs open.
    await Promise.allSettled([driver?.close(), owner?.unbind()]);
    await Promise.allSettled(context.pages().map(async page => {
      await page.screencast.hideActions();
      await page.evaluate(() => window.dispatchEvent(new Event("agentos-control-change")));
    }));
  }

  class ControlledBackend extends tools.BrowserBackend {
    async callTool(...args) {
      if (revoked) throw new Error(cancelledMessage);
      const result = await super.callTool(...args);
      if (revoked) throw new Error(cancelledMessage);
      return result;
    }
  }

  async function createBackend(clientInfo) {
    if (revoked || closing) throw new Error(cancelledMessage);
    const browser = await chromium.launch({ channel, headless: false });
    if (closing || revoked) {
      await browser.close();
      throw new Error(cancelledMessage);
    }
    owner = browser;
    try {
      const context = await browser.newContext({ viewport: null });
      context.once("close", () => { void browser.close().catch(() => {}); });
      await context.exposeBinding("__agentOSBrowserControl", async ({ frame, page }, action) => {
        if (action === "cancel" && frame === page.mainFrame()) await revoke(context);
        return !revoked;
      });
      await context.addInitScript(installControlIndicator);
      context.on("page", page => {
        if (!revoked) void page.screencast.showActions({
          cursor: "pointer", duration: 650, style: { title: "display:none" },
        }).catch(() => {});
      });
      const { endpoint } = await browser.bind("AgentOS", { workspaceDir: clientInfo.cwd });
      driver = await chromium.connect(endpoint);
      const controlled = driver.contexts()[0];
      if (!controlled) throw new Error("Cannot attach AgentOS to the isolated browser context");
      return new ControlledBackend(config, controlled, definitions, {
        dispose: async () => {
          if (!revoked) await browser.close().catch(() => {});
        },
      });
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }

  await tools.start({ name: "Playwright", nameInConfig: "playwright", version,
    toolSchemas: definitions.map(tool => tool.schema), ignoreRoots: config.ignoreRoots, create: createBackend });
  async function close() {
    if (closing) return;
    closing = true;
    await owner?.close().catch(() => {});
  }
  process.stdin.once("end", close);
  process.once("SIGTERM", close);
}

start(process.argv[2]).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
