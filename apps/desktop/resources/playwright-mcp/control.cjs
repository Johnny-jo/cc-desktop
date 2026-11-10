const { createRequire } = require("node:module");
const { URL } = require("node:url");
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
const { browserResource, createCallQueue, createOwnership, withTimeout } = require("./control-runtime.cjs");
const { acquireBrowserLease } = require("./browser-lease.cjs");
const { verifyPage, withScreenshotMetadata } = require("./browser-observation.cjs");

const cancelledMessage = "用户已取消 AgentOS 浏览器控制。此连接中的浏览器和资料查询工具已停用。";

async function start(channel, connection = "isolated", title, profileName, cdpEndpoint) {
  if (!["chrome", "msedge"].includes(channel)) throw new Error("Expected chrome or msedge");
  if (!["isolated", "extension", "cdp"].includes(connection)) throw new Error("Expected extension, cdp or isolated connection");
  const extensionProfile = connection === "extension";
  const attached = connection !== "isolated";
  const label = sessionLabel(title);
  const profile = extensionProfile ? resolveBrowserProfile(channel, { profileName: profileName || undefined }) : undefined;
  const resource = browserResource({ connection, cdpEndpoint, profileDirectory: profile?.directory });
  const cliOptions = { browser: channel, ...(extensionProfile ? { extension: true, profileDirName: profile.profileName }
    : connection === "cdp" ? { cdpEndpoint: new URL(cdpEndpoint).href } : { isolated: true }) };
  const config = await tools.resolveCLIConfigForMCP(cliOptions, process.env);
  // Ownership and the leased resource follow the selected mode. Inherited
  // Playwright environment/config must not silently attach an isolated owner
  // (or redirect a selected profile) to some other browser.
  config.browser = { ...config.browser, isolated: !attached,
    cdpEndpoint: connection === "cdp" ? cliOptions.cdpEndpoint : undefined,
    remoteEndpoint: undefined, userDataDir: undefined };
  config.extension = extensionProfile;
  let revoked = false;
  let closing = false;
  const sessions = new Set();
  const releasedContexts = new WeakSet();

  const dataTools = extensionProfile ? [
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
  const controlTools = [
    {
      schema: {
        name: "browser_release_control", title: "Release browser control",
        description: "释放当前连接的浏览器控制和租约，停用后续工具；连接日常浏览器时保留原浏览器和页面。",
        inputSchema: z.object({}), type: "action",
      },
      handle: async () => {}, // Handled before the action queue, so release can cancel queued work.
    },
    {
      schema: {
        name: "browser_verify", title: "Verify browser result",
        description: "只读观察当前页面；url 与完整当前 URL 精确比较（含路径、查询和片段）；text 为归一空白后的可见文本子串。所有给定条件同时满足才返回 observed；不点击、导航或重放动作。",
        inputSchema: z.object({
          url: z.string().min(1).max(4096).optional(), text: z.string().min(1).max(2000).optional(),
          timeoutMs: z.number().int().min(0).max(10000).default(2000),
        }), type: "readOnly",
      },
      handle: async (context, input, response, signal) => response.addTextResult(JSON.stringify(await verifyPage(
        context.currentTab()?.page, input, { isActive: () => !revoked && !closing, signal },
      ))),
    },
  ];
  const definitions = [...tools.filteredTools(config).map(withScreenshotMetadata), ...dataTools, ...controlTools];

  async function releaseIndicators(context) {
    if (!context) return;
    releasedContexts.add(context);
    await Promise.allSettled(context.pages().map(async page => {
      await page.screencast.hideActions().catch(() => {});
      await Promise.allSettled(page.frames().map(frame => frame.evaluate(() => {
        window.dispatchEvent(new CustomEvent("agentos-control-change", { detail: { active: false } }));
      })));
    }));
  }

  async function revoke() {
    revoked = true;
    await Promise.allSettled([...sessions].map(session => session.release()));
  }

  async function createBackend(clientInfo) {
    if (revoked || closing) throw new Error(cancelledMessage);
    const lease = await acquireBrowserLease(resource);
    if (revoked || closing) { await lease.release(); throw new Error(cancelledMessage); }
    const queue = createCallQueue(cancelledMessage);
    let initialized;
    const initialization = new Promise(resolve => { initialized = resolve; });
    let running = 0;
    let stopPointer;
    const state = { attached, releaseLease: () => lease.release(), beforeRelease: async () => {
      queue.revoke();
      stopPointer?.();
      state.idleTimer?.dispose();
      await releaseIndicators(state.context);
    } };
    const ownership = createOwnership(state);
    const session = { release: async () => {
      queue.revoke();
      await initialization;
      await ownership.release();
      sessions.delete(session);
    } };
    sessions.add(session);
    const broadcastAction = async () => {
      await withTimeout(() => Promise.allSettled((state.context?.pages() ?? []).flatMap(page => page.frames()).map(frame => frame.evaluate(value => {
        window.dispatchEvent(new CustomEvent("agentos-agent-action", { detail: { running: value } }));
      }, running > 0)))).catch(() => {});
    };
    class ControlledBackend extends tools.BrowserBackend {
      async dispose() {
        queue.revoke();
        stopPointer?.();
        await super.dispose();
      }
      async callTool(name, input, signal) {
        if (name === "browser_release_control") {
          await revoke();
          return { content: [{ type: "text", text: JSON.stringify({ status: "released", attached }) }] };
        }
        return queue.run(async () => {
          if (revoked || closing) throw new Error(cancelledMessage);
          running++;
          await broadcastAction();
          try {
            queue.check(signal);
            if (revoked || closing) throw new Error(cancelledMessage);
            return await super.callTool(name, input, signal);
          }
          finally { running--; if (!revoked && !closing) await broadcastAction(); }
        }, signal);
      }
    }
    let token;
    const scopedStore = extensionProfile && process.env.AGENTOS_BROWSER_AUTH_STORE;
    try {
      if (extensionProfile) {
        const setup = await prepareBrowserExtension(channel, profile.profileName);
        if (setup.state !== "ready") throw new Error(setup.message);
        token = scopedStore ? await loadBrowserAuthorization(scopedStore, channel, profile.profileName)
          : process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
        if (scopedStore) {
          if (token) process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
          else delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
        }
      }
      const info = await tools.createBrowserWithInfo(config, { ...clientInfo, clientName: label }, cliOptions, {
        title: label, workspaceDir: clientInfo.cwd,
      });
      const browser = state.browser = info.browser;
      state.idleTimer = info.idleTimer;
      if (closing || revoked) throw new Error(cancelledMessage);
      const context = state.context = attached ? browser.contexts()[0] : await browser.newContext({ viewport: null });
      if (!context) throw new Error("Cannot attach AgentOS to the selected browser context");
      if (extensionProfile && !await renameSessionTabGroup(context, label)) {
        console.error("AgentOS 标签组名称暂未更新，当前浏览器连接仍可继续使用。");
      }
      await withTimeout(() => context.exposeBinding("__agentOSBrowserControl", async ({ frame, page }, action) => {
        if (action === "cancel" && frame === page.mainFrame()) await revoke();
        return { active: !revoked && !closing && !releasedContexts.has(context), running: running > 0 };
      }), 1000);
      stopPointer = observeAutomationPointer(context, { isActive: () => !revoked && !closing && running > 0 });
      await withTimeout(() => context.addInitScript(installControlIndicator, { label })).catch(() => {});
      const preparePage = page => withTimeout(async () => {
        if (revoked || closing || releasedContexts.has(context)) return;
        await page.screencast.showActions({ cursor: "none", duration: 180, style: { title: "display:none" } });
        await Promise.all(page.frames().map(frame => frame.evaluate(installControlIndicator, { label })));
      }).catch(() => {});
      context.on("page", page => { void preparePage(page).catch(() => {}); });
      await Promise.all(context.pages().map(preparePage));
      state.driver = await chromium.connect(info.endpoint);
      const controlled = state.driver.contexts()[0];
      if (!controlled) throw new Error("Cannot connect the AgentOS browser tools");
      if (closing || revoked) throw new Error(cancelledMessage);
      browser.once("disconnected", () => { void session.release(); });
      state.driver.once("disconnected", () => { void session.release(); });
      const backend = new ControlledBackend(config, controlled, definitions, {
        idleTimer: info.idleTimer, dispose: () => session.release(),
      });
      initialized();
      return backend;
    } catch (error) {
      initialized();
      await session.release();
      const message = String(error?.message ?? error);
      const safeMessage = token ? message.split(token).join("[连接令牌]") : message;
      throw new Error(token ? `${safeMessage}\n如连接授权已重置，请在设置 → MCP 中更新连接授权后重试。` : safeMessage);
    } finally {
      if (scopedStore) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    }
  }

  // Install termination listeners before the server can begin an initialization.
  async function close() {
    if (closing) return;
    closing = true;
    await revoke();
  }
  process.stdin.once("end", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  try {
    await tools.start({ name: "AgentOS Browser", nameInConfig: "playwright", version,
      toolSchemas: definitions.map(tool => tool.schema), ignoreRoots: config.ignoreRoots, create: createBackend });
  } catch (error) { await close(); throw error; }
}

start(...process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
