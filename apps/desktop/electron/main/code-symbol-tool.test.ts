import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKControlListPermissionRulesResponse } from "@anthropic-ai/claude-agent-sdk";
import { createCodeSymbolBinding } from "./code-symbol-tool";
import * as runner from "./code-symbol-runner";
import { MessageStream } from "./message-stream";

const req = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = req("@modelcontextprotocol/sdk/inMemory.js");
const close: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(close.splice(0).map(fn => fn())); vi.restoreAllMocks(); });

function rules(behavior: "allow" | "ask" | "deny", rule: string) {
  return { state: { rules: [{ behavior, rule }], errors: [] } } as unknown as SDKControlListPermissionRulesResponse;
}

async function fixture(
  policy: () => Promise<SDKControlListPermissionRulesResponse | undefined>,
  desktopDeny: () => string[] = () => [],
  roots: { root: string; requestedRoot?: string } = { root: "fixture-root" },
) {
  const binding = createCodeSymbolBinding({
    ...roots, isActive: () => true, listRules: policy, desktopDeny,
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await binding.server.instance.connect(b);
  await client.connect(a);
  close.push(async () => { await client.close(); await binding.server.instance.close(); });
  return { binding, client, read: (args: Record<string, unknown> = { name: "target" }) =>
    client.callTool({ name: "read_symbol", arguments: args }) };
}

describe("read_symbol MCP", () => {
  it("publishes a read-only tool, validates inputs and returns the authorized runner result", async () => {
    const lookup = vi.spyOn(runner, "runCodeSymbolLookup").mockResolvedValue({ status: "found" });
    const f = await fixture(async () => rules("deny", "Bash(git push*)"));
    expect((await f.client.listTools()).tools).toMatchObject([{ name: "read_symbol", annotations: { readOnlyHint: true } }]);
    expect((await f.read({ name: "x", root: "another" })).isError).toBe(true);
    expect((await f.read({ name: "x", column: 5 })).isError).toBe(true);
    expect((await f.read({ name: "x", file: "../outside.ts" })).isError).toBe(true);
    expect((await f.read({ name: "x", line: 0 })).isError).toBe(true);
    expect((await f.read({ name: "x", callOffset: 1.1 })).isError).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    const args = { name: "target", file: "src/a.ts", line: 1, column: 4, callOffset: 0 };
    expect((await f.read(args)).content).toEqual([{ type: "text", text: '{"status":"found"}' }]);
    expect(lookup).toHaveBeenCalledWith("fixture-root", args, expect.any(AbortSignal));
  });

  it("accepts a bounded purpose query and rejects mixed modes or invalid search scopes", async () => {
    const lookup = vi.spyOn(runner, "runCodeSymbolLookup").mockResolvedValue({ status: "candidates", candidates: [] });
    const f = await fixture(async () => rules("allow", "Read"));
    const schema = (await f.client.listTools()).tools[0].inputSchema;
    expect(schema.properties).toHaveProperty("purpose");
    const args = { purpose: "取消过期的摘要请求", hints: ["summaryModel", "abort"], scope: "src/main" };
    expect((await f.read(args)).isError).not.toBe(true);
    expect(lookup).toHaveBeenCalledWith("fixture-root", args, expect.any(AbortSignal));
    lookup.mockClear();
    for (const invalid of [
      {}, { purpose: " " }, { purpose: "x".repeat(2001) },
      { purpose: "x", name: "target" }, { purpose: "x", file: "src/a.ts" },
      { purpose: "x", line: 1 }, { name: "x", hints: ["abort"] },
      { purpose: "x", hints: [""] }, { purpose: "x", hints: ["x".repeat(121)] },
      { purpose: "x", hints: Array(9).fill("x") }, { purpose: "x", hints: "abort" },
      { purpose: "x", scope: "../outside" }, { purpose: "x", scope: "C:private" },
      { purpose: "x", scope: "/outside" }, { purpose: "x", scope: "\\\\outside\\share" },
      { purpose: "x", scope: ".\\..\\outside" }, { purpose: "x", scope: "\u0000" },
    ]) expect((await f.read(invalid)).isError, JSON.stringify(invalid)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect((await f.read({ purpose: "find cancellation", scope: "." })).isError).not.toBe(true);
  });

  it("applies live read restrictions to purpose searches before running the index", async () => {
    const lookup = vi.spyOn(runner, "runCodeSymbolLookup");
    const f = await fixture(async () => rules("ask", "Read(./private/**)"));
    expect((await f.read({ purpose: "find cancellation", hints: ["abort"] })).isError).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["Read(./private/**)", "Read", "mcp__agentos-code__read_symbol"])("blocks desktop deny %s before lookup", async rule => {
    const lookup = vi.spyOn(runner, "runCodeSymbolLookup");
    const f = await fixture(async () => rules("allow", "Read"), () => [rule]);
    expect((await f.read()).isError).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("can index visible code when the only read restrictions target hidden files excluded from the index", async () => {
    vi.spyOn(runner, "runCodeSymbolLookup").mockResolvedValue({ status: "found" });
    const policy = async () => rules("deny", "Read(./.env*)");
    const root = path.resolve(path.parse(process.cwd()).root, "visible");
    const f = await fixture(policy, () => ["Read(.git/**)"], { root });
    expect((await f.read()).isError).not.toBe(true);
    const alias = await fixture(policy, () => [], { root, requestedRoot: root + "-link" });
    expect((await alias.read()).isError).toBe(true);
    const hidden = await fixture(policy, () => [], { root: path.join(root, ".env-project") });
    expect((await hidden.read()).isError).toBe(true);
  });

  it.each([
    rules("deny", "Read(./secrets/**)"), rules("ask", "Read(./private/**)"), rules("deny", "mcp__agentos-code__*"),
    undefined, { state: { rules: [], errors: [{}] } } as unknown as SDKControlListPermissionRulesResponse,
  ])("fails closed for restricted or unavailable live CLI permissions", async state => {
    const lookup = vi.spyOn(runner, "runCodeSymbolLookup");
    const f = await fixture(async () => state);
    expect((await f.read()).isError).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([{ name: "target" }, { purpose: "find cancellation", hints: ["abort"] }])("cancels an in-flight worker and suppresses revoked output for %j", async args => {
    let finish!: (value: unknown) => void;
    const lookup = vi.spyOn(runner, "runCodeSymbolLookup").mockImplementation(() => new Promise(r => { finish = r; }));
    const f = await fixture(async () => rules("allow", "Read"));
    const call = f.read(args);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    f.binding.revoke();
    expect(lookup.mock.calls[0][2]?.aborted).toBe(true);
    finish("late private data");
    expect(await call).toMatchObject({ isError: true });
    expect((await f.read(args)).isError).toBe(true);
  });

  it("rechecks the live permissions before disclosing an already-running lookup", async () => {
    let current = rules("allow", "Read");
    vi.spyOn(runner, "runCodeSymbolLookup").mockImplementation(async () => {
      current = rules("deny", "Read(./newly-restricted/**)");
      return "private data";
    });
    const f = await fixture(async () => current);
    const result = await f.read();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("private data");
  });

  it("blocks the transport while it is disabled and ignores stale enable acknowledgements", async () => {
    const lookup = vi.spyOn(runner, "runCodeSymbolLookup").mockResolvedValue("ok");
    const f = await fixture(async () => rules("allow", "Read"));
    const staleEnable = f.binding.suspend();
    const currentEnable = f.binding.suspend();
    staleEnable();
    expect((await f.read()).isError).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    currentEnable();
    expect((await f.read()).isError).toBeFalsy();
  });

  it.runIf(process.env.CC_TEST_BUNDLED_SDK === "1")("reads project and user denies from the bundled CLI before indexing", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "symbol-rule-wire-"));
    const project = path.join(dir, "project");
    const profile = path.join(dir, "profile");
    fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(./private/**)"] } }));
    fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ permissions: { deny: ["Read(./user-denied/**)"] } }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(path|systemroot|windir|comspec|pathext|temp|tmp|programfiles|localappdata|programfiles\(x86\))$/i.test(key)));
    const input = new MessageStream();
    const q = query({ prompt: input as Parameters<typeof query>[0]["prompt"], options: {
      cwd: project, env: { ...env, HOME: profile, USERPROFILE: profile, CLAUDE_CONFIG_DIR: profile,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      pathToClaudeCodeExecutable: path.resolve("../../vendor/win-x64/claude/claude.exe"),
      settingSources: ["user", "project", "local"], strictMcpConfig: true,
    } }) as ReturnType<typeof query> & { listPermissionRules(): Promise<SDKControlListPermissionRulesResponse> };
    try {
      const { state } = await q.listPermissionRules();
      expect(state.rules).toEqual(expect.arrayContaining([
        expect.objectContaining({ behavior: "deny", rule: "Read(./private/**)", source: "projectSettings" }),
        expect.objectContaining({ behavior: "deny", rule: "Read(./user-denied/**)", source: "userSettings" }),
      ]));
      const lookup = vi.spyOn(runner, "runCodeSymbolLookup");
      const f = await fixture(() => q.listPermissionRules());
      expect((await f.read()).isError).toBe(true);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      input.end();
      q.close();
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 });
    }
  }, 30_000);
});
