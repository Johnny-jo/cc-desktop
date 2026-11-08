import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const modulePath = path.resolve("resources/playwright-mcp/extension-branding.cjs");
const { renameSessionTabGroup } = existsSync(modulePath) ? require(modulePath) : {};
const origin = "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm";
const label = "AgentOS：查询资料";

function fixture(title = `Playwright · ${label}`) {
  const chrome = {
    tabs: { getCurrent: vi.fn().mockResolvedValue({ id: 9, groupId: 7 }) },
    tabGroups: { get: vi.fn().mockResolvedValue({ id: 7, title }), update: vi.fn().mockResolvedValue({ id: 7 }) },
  };
  const page = {
    url: () => `${origin}/connect.html`,
    evaluate: vi.fn(async (fn: Function, arg: unknown) => vm.runInNewContext(`(${fn.toString()})`, {
      chrome, location: { origin, pathname: "/connect.html" }, performance, setTimeout,
    })(arg)),
  };
  return { chrome, page, context: { pages: () => [page] } };
}

describe("AgentOS browser group branding", () => {
  it("renames only the group of its own extension connection tab", async () => {
    const { chrome, context } = fixture();
    expect(await renameSessionTabGroup(context, label)).toBe(true);
    expect(chrome.tabGroups.get).toHaveBeenCalledWith(7);
    expect(chrome.tabGroups.update).toHaveBeenCalledExactlyOnceWith(7, { title: label });
  });

  it("waits for the extension's asynchronous grouping before renaming", async () => {
    const { chrome, context } = fixture();
    chrome.tabs.getCurrent.mockResolvedValueOnce({ id: 9, groupId: -1 });
    chrome.tabGroups.get.mockResolvedValueOnce({ id: 7, title: "" });
    expect(await renameSessionTabGroup(context, label, { timeoutMs: 200, pollMs: 5 })).toBe(true);
    expect(chrome.tabGroups.update).toHaveBeenCalledTimes(1);
  });

  it.each([2, 10])("accepts a concurrent session suffix %s without changing other groups", async index => {
    const { chrome, context } = fixture(`Playwright · ${label} (${index})`);
    expect(await renameSessionTabGroup(context, label)).toBe(true);
    expect(chrome.tabGroups.update).toHaveBeenCalledExactlyOnceWith(7, { title: label });
  });

  it("leaves a user's different group title intact and returns a bounded failure", async () => {
    const { chrome, context } = fixture("工作资料");
    expect(await renameSessionTabGroup(context, label, { timeoutMs: 15, pollMs: 5 })).toBe(false);
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
  });

  it("never evaluates branding code in an ordinary website or another extension", async () => {
    const { page } = fixture();
    const pages = ["https://example.org/", "chrome-extension://another-extension/connect.html"].map(url => ({ ...page, url: () => url }));
    expect(await renameSessionTabGroup({ pages: () => pages }, label)).toBe(false);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("does not rename a group the connection tab left during inspection", async () => {
    const { chrome, context } = fixture();
    chrome.tabs.getCurrent.mockResolvedValueOnce({ id: 9, groupId: 7 }).mockResolvedValue({ id: 9, groupId: 8 });
    expect(await renameSessionTabGroup(context, label)).toBe(false);
    expect(chrome.tabGroups.update).not.toHaveBeenCalled();
  });
});
