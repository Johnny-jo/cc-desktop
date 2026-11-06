import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeMcpServers, validateMcpServers } from "@claude-desktop/shared";
import { resolveMcpServers } from "./playwright-mcp";

describe("bundled browser MCP", () => {
  it.each(["chrome", "msedge"] as const)("round trips %s and launches the pinned CLI with an isolated profile", (browser) => {
    const saved = { browser: { type: "playwright", browser } } as const;
    expect(validateMcpServers(saved).ok).toBe(true);
    expect(sanitizeMcpServers(saved)).toEqual(saved);
    const config = resolveMcpServers(saved, false).browser;
    if (config.type !== "stdio") throw new Error("Expected a local MCP");
    expect(config.command).toEqual(process.execPath);
    expect(existsSync(config.args![0])).toBe(true);
    expect(config.args!.slice(1)).toEqual([browser]);
    expect(config.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("omits browser presets in a restricted room while preserving custom servers", () => {
    const api = { type: "http" as const, url: "https://example.org/api" };
    expect(resolveMcpServers({ api, browser: { type: "playwright", browser: "chrome" } }, false, false)).toEqual({ api });
    expect(sanitizeMcpServers({ browser: { type: "playwright", browser: "invalid" } })).toEqual({});
  });
});
