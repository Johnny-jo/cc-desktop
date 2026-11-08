const { createRequire } = require("node:module");
const version = require("@playwright/mcp/package.json").version;
const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
const { chromium } = mcpRequire("playwright");
const { tools } = mcpRequire("playwright-core/lib/coreBundle");
const { z } = mcpRequire("playwright-core/lib/utilsBundle");
const installControlIndicator = require("./indicator.cjs");
const { sessionLabel } = require("./session-label.cjs");
const { resolveBrowserProfile, searchBrowserHistory, searchBrowserBookmarks } = require("./browser-data.cjs");
const { prepareBrowserExtension } = require("./extension-setup.cjs");
const { loadBrowserAuthorization } = require("./browser-auth.cjs");
const { observeAutomationPointer } = require("./pointer-source.cjs");
const { renameSessionTabGroup } = require("./extension-branding.cjs");

const cancelledMessage = "用户已取消 AgentOS 浏览器控制。此连接中的浏览器和资料查询工具已停用。";

async function start(channel, connection = "isolated", title, profileName) {
  if (!["chrome", "msedge"].includes(channel)) throw new Error("Expected chrome or msedge");
  if (!["isolated", "extension"].includes(connection)) throw new Error("Expected extension or isolated connection");
  const attached = connection === "extension";
  const label = sessionLabel(title);
  const profile = attached ? resolveBrowserProfile(channel, { profileName: profileName || undefined }) : undefined;
  const cliOptions = { browser: channel, ...(attached ? { extension: true, profileDirName: profile.profileName } : { isolated: true }) };
  const config = await tools.resolveCLIConfigForMCP(cliOptions, process.env);
  let revoked = false;
  let closing = false;
  let owner;
  let driver;
  let ownerContext;
  let running = 0;
  let stopPointer;
  const releasedContexts = new WeakSet();

  const dataTools = attached ? [
    {
      schema: {
        name: "browser_search_history", title: "Search browser history",
        description: "按关键词只读查询当前日常浏览器配置的访问历史，返回网页标题、HTTP(S) 地址和访问时间；不修改历史。",
        inputSchema: z.object({
          query: z.string().max(200).default("").describe("网页标题或地址关键词；空值查询最近访问"),
          limit: z.number().int().min(1).max(100).default(20).describe("最多返回条数，1–100"),
          days: z.number().int().min(1).max(365).default(30).describe("查询最近天数，1–365"),
        }), type: "readOnly",
      },
      handle: async (_context, input, response) => response.addTextResult(JSON.stringify({
        browser: channel, profile: profile.profileName, results: searchBrowserHistory(profile, input),
      })),
    },
    {
      schema: {
        name: "browser_search_bookmarks", title: "Search browser bookmarks",
        description: "按关键词只读查询当前日常浏览器配置的书签，返回网页标题、HTTP(S) 地址及书签目录；不修改书签。",
        inputSchema: z.object({
          query: z.string().max(200).default("").describe("书签标题、地址或目录关键词；空值列出书签"),
          limit: z.number().int().min(1).max(100).default(20).describe("最多返回条数，1–100"),
        }), type: "readOnly",
      },
      handle: async (_context, input, response) => response.addTextResult(JSON.stringify({
        browser: channel, profile: profile.profileName, results: searchBrowserBookmarks(profile, input),
      })),
    },
  ] : [];
  const definitions = [...tools.filteredTools(config), ...dataTools];

  async function broadcastAction() {
    await Promise.allSettled((ownerContext?.pages() ?? []).flatMap(page => page.frames()).map(frame => frame.evaluate(value => {
      window.dispatchEvent(new CustomEvent("agentos-agent-action", { detail: { running: value } }));
    }, running > 0)));
  }

  async function releaseIndicators(context) {
    releasedContexts.add(context);
    await Promise.allSettled(context.pages().map(async page => {
      await page.screencast.hideActions();
      await Promise.allSettled(page.frames().map(frame => frame.evaluate(() => {
        window.dispatchEvent(new CustomEvent("agentos-control-change", { detail: { active: false } }));
      })));
    }));
  }

  async function revoke(context) {
    if (revoked) return;
    revoked = true;
    stopPointer?.();
    await Promise.allSettled([driver?.close(), owner?.unbind()]);
    await releaseIndicators(context);
    // Closing an extension connection detaches the debugger, not the user's Edge.
    if (attached) await owner?.close().catch(() => {});
  }

  class ControlledBackend extends tools.BrowserBackend {
    async callTool(...args) {
      if (revoked) throw new Error(cancelledMessage);
      running++;
      await broadcastAction();
      try {
        const result = await super.callTool(...args);
        if (revoked) throw new Error(cancelledMessage);
        return result;
      } finally {
        running--;
        if (!revoked) await broadcastAction();
      }
    }
  }

  async function createBackend(clientInfo) {
    if (revoked || closing) throw new Error(cancelledMessage);
    if (attached) {
      const setup = await prepareBrowserExtension(channel, profile.profileName);
      if (setup.state !== "ready") throw new Error(setup.message);
    }
    const scopedStore = attached && process.env.AGENTOS_BROWSER_AUTH_STORE;
    const token = scopedStore ? await loadBrowserAuthorization(scopedStore, channel, profile.profileName)
      : process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    if (scopedStore) {
      if (token) process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
      else delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    }
    let info;
    try {
      info = await tools.createBrowserWithInfo(config, { ...clientInfo, clientName: label }, cliOptions, {
        title: label, workspaceDir: clientInfo.cwd,
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      const safeMessage = token ? message.split(token).join("[连接令牌]") : message;
      throw new Error(token ? `${safeMessage}\n如连接授权已重置，请在设置 → MCP 中更新连接授权后重试。` : safeMessage);
    } finally {
      if (scopedStore) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    }
    const browser = owner = info.browser;
    let stopBackendPointer;
    function releaseBackendPointer() {
      stopBackendPointer?.();
      if (stopPointer === stopBackendPointer) stopPointer = undefined;
    }
    try {
      if (closing || revoked) throw new Error(cancelledMessage);
      const context = ownerContext = attached ? browser.contexts()[0] : await browser.newContext({ viewport: null });
      if (!context) throw new Error("Cannot attach AgentOS to the selected browser profile");
      if (attached && !await renameSessionTabGroup(context, label)) {
        console.error("AgentOS 标签组名称暂未更新，当前浏览器连接仍可继续使用。");
      }
      if (!attached) context.once("close", () => { void browser.close().catch(() => {}); });
      await context.exposeBinding("__agentOSBrowserControl", async ({ frame, page }, action) => {
        if (action === "cancel" && frame === page.mainFrame()) await revoke(context);
        return { active: !revoked && !closing && !releasedContexts.has(context), running: running > 0 };
      });
      stopBackendPointer = observeAutomationPointer(context, { isActive: () => !revoked && !closing && running > 0 });
      stopPointer = stopBackendPointer;
      await context.addInitScript(installControlIndicator, { label });
      const preparePage = async page => {
        if (revoked || closing) return;
        await page.screencast.showActions({ cursor: "none", duration: 180, style: { title: "display:none" } });
        await Promise.all(page.frames().map(frame => frame.evaluate(installControlIndicator, { label })));
      };
      context.on("page", page => { void preparePage(page).catch(() => {}); });
      await Promise.all(context.pages().map(preparePage));
      driver = await chromium.connect(info.endpoint);
      const controlled = driver.contexts()[0];
      if (!controlled) throw new Error("Cannot connect the AgentOS browser tools");
      return new ControlledBackend(config, controlled, definitions, {
        idleTimer: info.idleTimer,
        dispose: async () => {
          releaseBackendPointer();
          if (revoked) return;
          await releaseIndicators(context);
          await browser.close().catch(() => {});
        },
      });
    } catch (error) {
      releaseBackendPointer();
      await browser.close().catch(() => {});
      throw error;
    }
  }

  await tools.start({ name: "AgentOS Browser", nameInConfig: "playwright", version,
    toolSchemas: definitions.map(tool => tool.schema), ignoreRoots: config.ignoreRoots, create: createBackend });
  async function close() {
    if (closing) return;
    closing = true;
    if (ownerContext && !revoked) await revoke(ownerContext);
    await owner?.close().catch(() => {});
  }
  process.stdin.once("end", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}

start(...process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
