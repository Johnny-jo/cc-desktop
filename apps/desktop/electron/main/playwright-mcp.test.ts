import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeMcpServers, validateMcpServers } from "@claude-desktop/shared";
import { resolveMcpServers } from "./playwright-mcp";

describe("bundled Windows desktop MCP", () => {
  const api = { type: "http", url: "https://example.org/api" } as const;
  const servers = { computer: { type: "windows-computer" }, api } as const;
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])("runs the bundled stdio server on Windows (packaged: %s)", (isPackaged) => {
    const resourcesPath = path.resolve("packaged-app", "resources");
    vi.stubGlobal("process", { ...process, platform: "win32", resourcesPath });
    const root = isPackaged ? resourcesPath : path.resolve(__dirname, "../../resources");
    expect(resolveMcpServers(servers, isPackaged, true, "桌面测试", "browser-auth.json")).toEqual({
      computer: {
        type: "stdio",
        command: process.execPath,
        args: [path.join(root, "windows-computer", isPackaged ? "server.cjs" : "dist/server.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
      api,
    });
  });

  it.each([
    ["win32", false], ["linux", true], ["darwin", true],
  ] as const)("omits the preset on %s when control is allowed: %s", (platform, allowControl) => {
    vi.stubGlobal("process", { ...process, platform });
    expect(resolveMcpServers(servers, false, allowControl)).toEqual({ api });
  });
});

describe("bundled browser MCP", () => {
  it.each(["chrome", "msedge"] as const)("round trips legacy %s and defaults to the extension connection", (browser) => {
    const saved = { browser: { type: "playwright", browser } } as const;
    expect(validateMcpServers(saved).ok).toBe(true);
    expect(sanitizeMcpServers(saved)).toEqual(saved);
    const config = resolveMcpServers(saved, false).browser;
    if (config.type !== "stdio") throw new Error("Expected a local MCP");
    expect(config.command).toEqual(process.execPath);
    expect(existsSync(config.args![0])).toBe(true);
    expect(config.args!.slice(1)).toEqual([browser, "extension", "浏览器会话", ""]);
    expect(config.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it.each(["extension", "isolated"] as const)("passes the %s connection, session title, and profile in order", (connection) => {
    const config = resolveMcpServers({ browser: {
      type: "playwright", browser: "msedge", connection, profile: "Profile 2",
    } }, false, true, "查询今日工作资料").browser;
    if (config.type !== "stdio") throw new Error("Expected a local MCP");
    expect(config.args!.slice(1)).toEqual(["msedge", connection, "查询今日工作资料", "Profile 2"]);
    expect(config.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("omits browser presets in a restricted room while preserving custom servers", () => {
    const api = { type: "http" as const, url: "https://example.org/api" };
    expect(resolveMcpServers({ api, browser: {
      type: "playwright", browser: "chrome", connection: "extension", profile: "Profile 2",
    } }, false, false, "群聊资料查询")).toEqual({ api });
    expect(sanitizeMcpServers({ browser: { type: "playwright", browser: "invalid" } })).toEqual({});
  });

  it("passes only the authorization store path to an extension process", () => {
    const store = "C:/AgentOS/browser-auth.json";
    const servers = { browser: { type: "playwright", browser: "msedge" } } as const;
    const extension = resolveMcpServers(servers, false, true, "浏览器验证", store).browser;
    if (extension.type !== "stdio") throw new Error("Expected a local MCP");
    expect(extension.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", AGENTOS_BROWSER_AUTH_STORE: store });
    const isolated = resolveMcpServers({ browser: { ...servers.browser, connection: "isolated" as const } }, false, true, "浏览器验证", store).browser;
    if (isolated.type !== "stdio") throw new Error("Expected a local MCP");
    expect(isolated.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });
});
