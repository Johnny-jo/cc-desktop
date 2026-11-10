import { describe, expect, it } from "vitest";
import { sanitizeMcpServers, validateMcpServers } from "@claude-desktop/shared";
import { resolveMcpServers } from "./playwright-mcp";
import { buildMcpServersPatch, mcpServersToDrafts, setControlEnabled } from "../../src/components/settings/mcp-form";

describe("CDP browser configuration", () => {
  const saved = { remote: { type: "playwright", browser: "chrome", connection: "cdp", cdpEndpoint: "http://127.0.0.1:9222" } } as const;

  it("preserves the endpoint through load, form edits, disable and re-enable", () => {
    expect(validateMcpServers(saved).ok).toBe(true);
    expect(sanitizeMcpServers(saved)).toEqual(saved);
    expect(buildMcpServersPatch(mcpServersToDrafts(saved))).toEqual({ ok: true, mcpServers: saved, disabledControlServers: {} });
    const disabled = buildMcpServersPatch(setControlEnabled(mcpServersToDrafts(saved), "chrome", false));
    expect(disabled).toMatchObject({ ok: true, mcpServers: {}, disabledControlServers: saved });
    if (!disabled.ok) throw Error(disabled.error);
    expect(buildMcpServersPatch(setControlEnabled(mcpServersToDrafts({}, disabled.disabledControlServers), "chrome", true))).toEqual({ ok: true, mcpServers: saved, disabledControlServers: {} });
  });

  it.each(["http://localhost:9222", "https://browser.example/cdp", "ws://localhost:9222/devtools/browser/id", "wss://browser.example/devtools/browser/id"])("accepts CDP endpoint %s", cdpEndpoint => {
    expect(validateMcpServers({ remote: { ...saved.remote, cdpEndpoint } }).ok).toBe(true);
  });

  it.each([undefined, "", " ", "file:///C:/browser", "ftp://browser.test", "http://user:pass@host", "https://host/#fragment", "http://host/?token=secret", "not-an-address", 22])("rejects invalid or credential-bearing CDP endpoint %s", cdpEndpoint => {
    const raw = { remote: { ...saved.remote, cdpEndpoint } };
    expect(validateMcpServers(raw as never)).toMatchObject({ ok: false });
    expect(sanitizeMcpServers(raw)).toEqual({});
  });

  it("passes the endpoint without profile or extension authorization", () => {
    const result = resolveMcpServers(saved, false, true, "远程页面", "private-auth.json").remote;
    if (result.type !== "stdio") throw Error("Expected bundled MCP");
    expect(result.args?.slice(1)).toEqual(["chrome", "cdp", "远程页面", "", "http://127.0.0.1:9222"]);
    expect(result.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(resolveMcpServers(saved, false, false)).toEqual({});
  });

  it("drops irrelevant profile and endpoint fields when changing connection mode", () => {
    const [draft] = mcpServersToDrafts(saved);
    expect(buildMcpServersPatch([{ ...draft, profile: "Default" }])).toMatchObject({ ok: true, mcpServers: saved });
    expect(buildMcpServersPatch([{ ...draft, connection: "extension", profile: "Profile 2" }])).toMatchObject({ ok: true, mcpServers: {
      remote: { type: "playwright", browser: "chrome", connection: "extension", profile: "Profile 2" },
    } });
  });
});
