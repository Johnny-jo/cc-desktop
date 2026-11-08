import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const modulePath = path.resolve(import.meta.dirname, "../../resources/playwright-mcp/connection-authorization.cjs");
const { persistConnectionAuthorization } = existsSync(modulePath) ? require(modulePath) : {};
const { saveBrowserAuthorization, loadBrowserAuthorization, hasBrowserAuthorization } = require("../../resources/playwright-mcp/browser-auth.cjs");
const extensionId = "mmlmfjhmonkocbjadbfplnigmagldckm";
const connectionUrl = `chrome-extension://${extensionId}/connect.html`;
const token = Buffer.alloc(32, 5).toString("base64url");
const otherToken = Buffer.alloc(32, 6).toString("base64url");
let directory: string;
let storePath: string;
let protect: ReturnType<typeof vi.fn>;

function page(url = connectionUrl, value: unknown = token, evaluatedUrl = url) {
  const getItem = vi.fn(() => value);
  const evaluate = vi.fn(async (fn: (...args: unknown[]) => unknown, arg: unknown) => runInNewContext(`(${fn.toString()})(arg)`, {
    arg, URL, location: new URL(evaluatedUrl), localStorage: { getItem },
  }));
  return { url: vi.fn(() => url), evaluate, getItem };
}
function context(...pages: ReturnType<typeof page>[]) { return { pages: vi.fn(() => pages) }; }
beforeEach(() => {
  const root = path.resolve(import.meta.dirname, "../../../../.tmp");
  mkdirSync(root, { recursive: true });
  directory = mkdtempSync(path.join(root, "agentos-connection-auth-test-"));
  storePath = path.join(directory, "browser-auth.json");
  protect = vi.fn(async (value: string) => Buffer.from(`synthetic-protected:${value}`).toString("base64"));
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe("post-handshake scoped connection authorization persistence", () => {
  it.each([undefined, ""])("does not inspect pages when the authorization store is absent: %j", async (store) => {
    const tab = page(); const browserContext = context(tab);
    expect(await persistConnectionAuthorization(browserContext, store, "msedge", "Profile 2", { protect })).toBe(false);
    expect(browserContext.pages).not.toHaveBeenCalled();
    expect(tab.evaluate).not.toHaveBeenCalled();
    expect(protect).not.toHaveBeenCalled();
  });

  it("does not read a page or overwrite an already configured scope", async () => {
    await saveBrowserAuthorization(storePath, "msedge", "Profile 2", otherToken, { protect });
    const before = readFileSync(storePath, "utf8"); protect.mockClear();
    const tab = page(); const browserContext = context(tab);
    expect(await persistConnectionAuthorization(browserContext, storePath, "msedge", "PROFILE 2", { protect })).toBe(false);
    expect(browserContext.pages).not.toHaveBeenCalled();
    expect(tab.evaluate).not.toHaveBeenCalled();
    expect(protect).not.toHaveBeenCalled();
    expect(readFileSync(storePath, "utf8")).toBe(before);
  });

  it("encrypts only the official connection page's single authorization key for the selected scope", async () => {
    const tab = page(`${connectionUrl}?mcpRelayUrl=ws://127.0.0.1:1234&client=fixture`);
    expect(await persistConnectionAuthorization(context(tab), storePath, "msedge", "Profile 2", { protect })).toBe(true);
    expect(tab.getItem.mock.calls).toEqual([["auth-token"]]);
    expect(protect).toHaveBeenCalledWith(token);
    expect(readFileSync(storePath, "utf8")).not.toContain(token);
    expect(hasBrowserAuthorization(storePath, "msedge", "Profile 2")).toBe(true);
    expect(hasBrowserAuthorization(storePath, "chrome", "Profile 2")).toBe(false);
    expect(hasBrowserAuthorization(storePath, "msedge", "Default")).toBe(false);
    const unprotect = async (value: string) => Buffer.from(value, "base64").toString().slice("synthetic-protected:".length);
    expect(await loadBrowserAuthorization(storePath, "msedge", "Profile 2", { unprotect })).toBe(token);
  });

  it.each([["chrome", "Profile 2"], ["msedge", "Default"]])("keeps existing other-scope authorization isolated from %s %s", async (browser, profileName) => {
    await saveBrowserAuthorization(storePath, "msedge", "Profile 2", otherToken, { protect });
    expect(await persistConnectionAuthorization(context(page()), storePath, browser, profileName, { protect })).toBe(true);
    expect(hasBrowserAuthorization(storePath, browser, profileName)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(storePath, "utf8")).entries)).toHaveLength(2);
  });

  it.each([
    "https://example.org/connect.html",
    `http://${extensionId}/connect.html`,
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/connect.html",
    `chrome-extension://${extensionId}.example/connect.html`,
    `chrome-extension://${extensionId}/index.html`,
    `chrome-extension://${extensionId}/connect.html/`,
    `chrome-extension://${extensionId}/connect.html%2F`,
    `chrome-extension://other@${extensionId}/connect.html`,
    `chrome-extension://${extensionId}:123/connect.html`,
  ])("does not evaluate any storage on an untrusted or different page: %s", async (url) => {
    const tab = page(url);
    expect(await persistConnectionAuthorization(context(tab), storePath, "msedge", "Profile 2", { protect })).toBe(false);
    expect(tab.evaluate).not.toHaveBeenCalled();
    expect(tab.getItem).not.toHaveBeenCalled();
    expect(existsSync(storePath)).toBe(false);
  });

  it.each([
    "https://example.org/navigation-race",
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/connect.html",
    `chrome-extension://${extensionId}/options.html`,
  ])("checks the page location again before accessing storage after navigation to %s", async (evaluatedUrl) => {
    const tab = page(connectionUrl, token, evaluatedUrl);
    expect(await persistConnectionAuthorization(context(tab), storePath, "msedge", "Profile 2", { protect })).toBe(false);
    expect(tab.evaluate).toHaveBeenCalledOnce();
    expect(tab.getItem).not.toHaveBeenCalled();
    expect(protect).not.toHaveBeenCalled();
  });

  it.each([["firefox", "Default"], ["msedge", "../outside"]])("rejects invalid scope %s %s without inspecting pages", async (browser, profileName) => {
    const tab = page(); const browserContext = context(tab);
    await expect(persistConnectionAuthorization(browserContext, storePath, browser, profileName, { protect })).rejects.toThrow(/授权/);
    expect(browserContext.pages).not.toHaveBeenCalled();
    expect(tab.evaluate).not.toHaveBeenCalled();
    expect(protect).not.toHaveBeenCalled();
  });

  it("returns false when the connected browser context no longer has the connection page", async () => {
    expect(await persistConnectionAuthorization(context(), storePath, "msedge", "Profile 2", { protect })).toBe(false);
    expect(protect).not.toHaveBeenCalled();
  });

  it.each([null, "", "invalid", `${token}extra`, `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${token}`])("rejects missing or malformed raw storage values safely: %j", async (value) => {
    let caught: unknown;
    try { await persistConnectionAuthorization(context(page(connectionUrl, value)), storePath, "msedge", "Profile 2", { protect }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toMatch(/授权|手动/);
    expect(String(caught)).not.toContain(token);
    expect(caught).not.toHaveProperty("cause");
    expect(protect).not.toHaveBeenCalled();
    expect(existsSync(storePath)).toBe(false);
  });

  it.each(["read", "encrypt"])("hides secret values in %s failures", async (failure) => {
    const tab = page();
    if (failure === "read") tab.evaluate.mockRejectedValueOnce(new Error(`synthetic secret ${token}`));
    else protect.mockRejectedValueOnce(new Error(`synthetic secret ${token}`));
    let caught: unknown;
    try { await persistConnectionAuthorization(context(tab), storePath, "msedge", "Profile 2", { protect }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(token);
    expect(caught).not.toHaveProperty("cause");
  });

  it("rechecks the scope before saving when a manual configuration appeared during page evaluation", async () => {
    const tab = page();
    tab.evaluate.mockImplementationOnce(async () => {
      await saveBrowserAuthorization(storePath, "msedge", "Profile 2", otherToken, { protect });
      return { source: true, token };
    });
    expect(await persistConnectionAuthorization(context(tab), storePath, "msedge", "Profile 2", { protect })).toBe(false);
    expect(protect).toHaveBeenCalledTimes(1);
  });

  it("serializes duplicate helper calls for the same scope", async () => {
    const tab = page(); const browserContext = context(tab);
    const results = await Promise.all([
      persistConnectionAuthorization(browserContext, storePath, "msedge", "Profile 2", { protect }),
      persistConnectionAuthorization(browserContext, storePath, "msedge", "profile 2", { protect }),
    ]);
    expect(results).toEqual([true, false]);
    expect(tab.getItem).toHaveBeenCalledTimes(1);
    expect(protect).toHaveBeenCalledTimes(1);
  });
});
