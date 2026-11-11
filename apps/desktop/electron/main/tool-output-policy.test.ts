import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ToolOutputStore } from "./tool-output-store";
import { compactBrowserResult, createToolOutputBinding, shellOutputBudget } from "./tool-output-policy";

const source = "### Result\nTotal messages: 1 (Errors: 0, Warnings: 0)\n\n[LOG] HEAD" +
  "A".repeat(6200) + "中间🪻" + "B".repeat(6200) + "TAIL @ about:blank:1";
const blocks = (text: string) => [{ type: "text", text }];

describe("browser tool output", () => {
  it("honors lower user, project and project-local SDK budgets when the cwd is nested", () => {
    const dir = mkdtempSync(join(tmpdir(), "shell-output-budget-"));
    const project = join(dir, "repo"), cwd = join(project, "src"), config = join(dir, "user");
    for (const folder of [cwd, config, join(project, ".git"), join(project, ".claude")]) mkdirSync(folder, { recursive: true });
    try {
      const env = { CLAUDE_CONFIG_DIR: config };
      writeFileSync(join(config, "settings.json"), '{"bashOutputMaxChars":12000}');
      expect(shellOutputBudget(cwd, env)).toBe(12000);
      writeFileSync(join(project, ".claude", "settings.json"), '{"bashOutputMaxChars":10000}');
      writeFileSync(join(project, ".claude", "settings.local.json"), '{"bashOutputMaxChars":8000}');
      expect(shellOutputBudget(cwd, env)).toBe(8000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("archives exact text before replacing a known successful console result", () => {
    let saved = "";
    const result = compactBrowserResult("browser_console_messages", blocks(source), text => {
      saved = text;
      return "fixture-handle";
    });
    expect(saved).toBe(source);
    expect(result?.[0].text).toContain("HEAD");
    expect(result?.[0].text).toContain("TAIL");
    expect(result?.[0].text).toContain("fixture-handle");
    expect(result?.[0].text).not.toContain("中间");
  });
  it("retains evaluate's complete code section and only previews a decoded plain string", () => {
    const suffix = "\n### Ran Playwright code\n```js\nawait page.evaluate(() => document.title);\n```";
    const body = "HEAD " + "x".repeat(10000) + " TAIL";
    const input = "### Result\n" + JSON.stringify(body) + suffix;
    expect(compactBrowserResult("browser_evaluate", blocks(input), () => "handle")?.[0].text.endsWith(suffix)).toBe(true);
    for (const unsafe of [JSON.stringify({ ref: body }), JSON.stringify('{"value":"' + body + '"}'), JSON.stringify(body + " [ref=e5]")]) {
      expect(compactBrowserResult("browser_evaluate", blocks("### Result\n" + unsafe + suffix), () => "handle")).toBeUndefined();
    }
  });
  it("leaves control references, unknown shapes, images, failures and storage refusal intact", () => {
    for (const raw of [
      blocks(source.replace("Errors: 0", "Errors: 1")),
      blocks(source.replace("中间", "[ref=e12]")), blocks(source.replace("中间", '"observationId": "id"')),
      blocks(source + "\n### Snapshot\n- [Snapshot](snapshot.yml)"),
      blocks(source + "\n### Error\nTarget closed"),
      [...blocks(source), { type: "image", data: "AA==", mimeType: "image/png" }],
      [{ ...blocks(source)[0], annotations: {} }], { isError: true, content: blocks(source) },
    ]) {
      expect(compactBrowserResult("browser_console_messages", raw, () => "handle")).toBeUndefined();
    }
    expect(compactBrowserResult("Read", blocks(source), () => "handle")).toBeUndefined();
    expect(compactBrowserResult("browser_console_messages", blocks(source), () => undefined)).toBeUndefined();
    expect(compactBrowserResult("browser_console_messages", blocks(source), () => { throw Error("disk full"); })).toBeUndefined();
  });
  it("reauthorizes the owning personal session after restart, denies foreign handles and enforces TTL and quotas", () => {
    const file = join(mkdtempSync(join(tmpdir(), "result-store-")), "archive.sqlite3");
    let now = 5;
    const opts = { maxItemBytes: 100, maxSessionBytes: 9, maxTotalBytes: 15, ttlMs: 100, now: () => now };
    const store = new ToolOutputStore(file, opts);
    const handle = store.save("s1", "c", "abc测试")!;
    expect(handle).toMatch(/^[\da-f-]{36}$/);
    expect(store.save("s1", "other", "x")).toBeUndefined();
    expect(store.save("s2", "other", "1234567")).toBeUndefined();
    expect(store.read("s2", "c", handle, 0, 3)).toBeUndefined();
    store.close();
    const resumed = new ToolOutputStore(file, opts);
    const tool = { name: "fixture", summary: "", status: "done" as const, outputHandle: handle };
    expect(resumed.retained("s1", [{ kind: "tool", id: "wrong", tool: { ...tool, id: "wrong" } }]).size).toBe(0);
    expect(resumed.retained("s1", [{ kind: "tool", id: "c", tool: { ...tool, id: "c" } }]).get(handle)).toBe("c");
    expect(resumed.read("s1", "c", handle, 0, 3)).toEqual({ text: "abc", nextOffset: 3, totalChars: 5 });
    expect(resumed.read("s1", "c", handle, 3, 2)).toEqual({ text: "测试", nextOffset: null, totalChars: 5 });
    expect(resumed.read("s1", "c", handle, -1, 2)).toBeUndefined();
    now += 101;
    expect(resumed.read("s1", "c", handle, 0, 2)).toBeUndefined();
    expect(resumed.save("s1", "c2", "123")).toBeDefined();
    resumed.remove("s1");
    expect(resumed.read("s1", "c", handle, 0, 3)).toBeUndefined();
    resumed.close();
    rmSync(file);
  });
  it("binds MCP page access to a live query and rejects caller-supplied identities", async () => {
    const req = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = req("@modelcontextprotocol/sdk/inMemory.js");
    const store = new ToolOutputStore();
    const scope = { store, sessionId: "session-A", retained: new Map<string, string>(), sources: new Set(["browser"]), isActive: () => true };
    const old = createToolOutputBinding(scope);
    const input = { tool_use_id: "c", tool_name: "mcp__browser__browser_console_messages", mcp_server: { name: "browser", source: "sdk" }, tool_response: blocks(source) };
    const result = await old.post(input);
    const handle = /with handle ([\da-f-]{36})/.exec(result.hookSpecificOutput!.updatedToolOutput[0].text)![1];
    const fresh = createToolOutputBinding({ ...scope, retained: new Map([[handle, "c"]]) });
    const foreign = createToolOutputBinding({ ...scope, sessionId: "session-B", retained: new Map([[handle, "c"]]) });
    const bindings = [old, fresh, foreign];
    const clients = await Promise.all(bindings.map(async binding => {
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "1" });
      await binding.server.instance.connect(b);
      await client.connect(a);
      return client;
    }));
    try {
      expect(await old.post({ ...input, mcp_server: { ...input.mcp_server, source: "plugin" } })).toEqual({});
      expect(await old.post(input, undefined, { signal: AbortSignal.abort() })).toEqual({});
      const args = { handle, offset: 0, limit: 100 };
      const call = (index: number, parameters: object) => clients[index].callTool({ name: "result_read", arguments: parameters });
      expect(JSON.parse((await call(0, args)).content[0].text).text).toBe(source.slice(0, 100));
      old.revoke();
      expect(await old.post(input)).toEqual({});
      expect((await call(0, args)).isError).toBe(true);
      expect((await call(1, args)).isError).not.toBe(true);
      expect((await call(2, args)).isError).toBe(true);
      expect((await call(2, { ...args, sessionId: "session-A" })).isError).toBe(true);
      expect((await call(1, { ...args, limit: 4001 })).isError).toBe(true);
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await Promise.all(bindings.map(binding => binding.server.instance.close()));
      store.close();
    }
  });
});
