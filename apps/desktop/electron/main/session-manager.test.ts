import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppSettings, ChatItem, FileChange, SdkNormalizedEvent, SessionProgress, SessionSummary } from "@claude-desktop/shared";
import type { QueryFn, SessionManagerDeps } from "./session-manager";
import {
  MAX_HYDRATED_CHANGES,
  MAX_HYDRATED_TRANSCRIPTS,
  SessionManager,
  humanizeAgentError,
} from "./session-manager";
import type { PermissionBroker } from "./permission-broker";
import { fileEditRecovery } from "./file-edit-recovery";
import { DiffTracker } from "./diff-tracker";
import type { CpaSupervisor } from "./cpa-supervisor";
import type { SettingsStore } from "./settings-store";
import { SessionArchive } from "./session-archive";
import { AppDatabase } from "./app-database";
import { compressContext } from "./context-compressor";
import { ToolOutputStore } from "./tool-output-store";
import type { ToolOutputBinding } from "./tool-output-policy";

const baseSettings: AppSettings = {
  cpaExePath: "cpa.exe",
  cpaConfigPath: "config.yaml",
  cpaPort: 8317,
  defaultModel: "kimi-for-coding",
  models: ["kimi-for-coding"],
  permissionMode: "default",
  shutdownCpaOnQuit: false,
  defaultContextLimit: 200_000,
  modelContextLimits: {},
};

function userTextFromPrompt(msg: unknown): string {
  if (typeof msg !== "object" || msg === null) return "";
  const rec = msg as { type?: string; message?: { content?: unknown } };
  if (rec.type !== "user") return "";
  const content = rec.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

/** Drain one user message from streaming prompt (MessageStream). */
async function takeFirstUserText(
  prompt: string | AsyncIterable<unknown>,
): Promise<string> {
  if (typeof prompt === "string") return prompt;
  for await (const msg of prompt) {
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { type?: string }).type === "user"
    ) {
      const m = msg as {
        message?: { content?: string | unknown[] };
      };
      if (typeof m.message?.content === "string") return m.message.content;
    }
    break;
  }
  return "";
}

/**
 * Default mock: consume first streaming user message, emit Hi + tool + result.
 */
function defaultQueryFn(): QueryFn {
  return async function* (args) {
    await takeFirstUserText(args.prompt);
    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hi" },
      },
    };
    yield {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "1", name: "Read", input: { file_path: "a" } },
        ],
      },
      session_id: "sdk-session-1",
    };
    yield { type: "result", subtype: "success", total_cost_usd: 0 };
  };
}

function makeDeps(overrides: {
  toolOutputDatabasePath?: string;
  pdfCompatibility?: SessionManagerDeps["pdfCompatibility"];
  queryFn?: QueryFn;
  ensureReady?: () => Promise<{ state: string; message?: string; port?: number; managedByApp?: boolean }>;
  canUseTool?: ReturnType<typeof vi.fn>;
  onToolUse?: ReturnType<typeof vi.fn>;
  listDiffs?: ReturnType<typeof vi.fn>;
  diffTracker?: DiffTracker;
  archive?: SessionManagerDeps["archive"];
  compressor?: SessionManagerDeps["compressor"];
} = {}) {
  const emitted: SdkNormalizedEvent[] = [];
  const sessions: SessionSummary[] = [];
  const diffs: Array<{ sessionId: string; changes: FileChange[] }> = [];

  const queryFn: QueryFn = overrides.queryFn ?? defaultQueryFn();

  const permissionBroker = {
    canUseTool:
      overrides.canUseTool ??
      vi.fn().mockResolvedValue({ behavior: "allow", updatedInput: {} }),
  } as unknown as PermissionBroker;

  const onToolUse = overrides.onToolUse ?? vi.fn();
  const listDiffs = overrides.listDiffs ?? vi.fn().mockReturnValue([]);
  const diffTracker =
    overrides.diffTracker ??
    ({
      onToolUse,
      list: listDiffs,
      remove: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      findByEvent: vi.fn().mockReturnValue(null),
      truncateAt: vi.fn(),
      markDeleted: vi.fn().mockReturnValue(false),
      refreshBashWritesFromDisk: vi.fn().mockResolvedValue(undefined),
      captureBashBaseline: vi.fn().mockResolvedValue(undefined),
      hydrate: vi.fn(),
      clearSession: vi.fn(),
    } as unknown as DiffTracker);

  const ensureReady =
    overrides.ensureReady ??
    vi.fn().mockResolvedValue({ state: "ready", port: 8317, managedByApp: false });
  const buildProcessEnv = vi.fn().mockReturnValue({
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
    ANTHROPIC_AUTH_TOKEN: "tok",
    ANTHROPIC_MODEL: "kimi-for-coding",
  });
  const cpa = {
    ensureReady,
    buildProcessEnv,
    getModelCatalog: vi.fn().mockReturnValue([]),
  } as unknown as CpaSupervisor;

  const settings = {
    get: vi.fn().mockReturnValue({ ...baseSettings }),
  } as unknown as SettingsStore;

  const emit = vi.fn((e: SdkNormalizedEvent) => {
    emitted.push(e);
  });
  const emitSession = vi.fn((s: SessionSummary) => {
    sessions.push(s);
  });
  const emitDiff = vi.fn((sessionId: string, changes: FileChange[]) => {
    diffs.push({ sessionId, changes });
  });

  const manager = new SessionManager({
    toolOutputDatabasePath: overrides.toolOutputDatabasePath,
    pdfCompatibility: overrides.pdfCompatibility,
    queryFn,
    permissionBroker,
    diffTracker,
    cpa,
    settings,
    emit,
    emitSession,
    emitDiff,
    archive: overrides.archive,
    compressor: overrides.compressor,
  });

  return {
    manager,
    emitted,
    sessions,
    diffs,
    emit,
    emitSession,
    emitDiff,
    queryFn,
    permissionBroker,
    diffTracker,
    cpa,
    onToolUse,
    listDiffs,
    ensureReady,
    buildProcessEnv,
    settings,
    capturedQueryArgs: [] as Array<{ prompt: string; options: Record<string, unknown> }>,
  };
}

describe("project symbol MCP", () => {
  const name = "agentos-code";
  const tool = "mcp__agentos-code__read_symbol";
  const prompt = { text: "find a symbol", attachments: [] };
  const serverOf = (options: Record<string, unknown>) =>
    (options.mcpServers as Record<string, ToolOutputBinding["server"]> | undefined)?.[name];

  it("attaches to an unmarked project, keeps broker denial and skips room and jail queries", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-symbol-session-"));
    const calls: Record<string, unknown>[] = [];
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "deny", message: "user declined" });
    const { manager } = makeDeps({ canUseTool, queryFn: ({ options }) => {
      calls.push(options);
      return (async function* () { yield { type: "result" }; })();
    } });
    try {
      const id = await manager.start(prompt, root);
      const own = serverOf(calls[0]);
      expect(own?.type).toBe("sdk");
      expect(calls[0].allowedTools).not.toContain(tool);
      const check = calls[0].canUseTool as (...args: unknown[]) => Promise<unknown>;
      expect(await check(tool, { name: "target" }, { signal: new AbortController().signal }))
        .toMatchObject({ behavior: "deny", message: "user declined" });
      await manager.continue(id, prompt, { roomReadOnly: true });
      expect(serverOf(calls[1])).toBeUndefined();
      await manager.start(prompt, root, { pathJail: root });
      expect(serverOf(calls[2])).toBeUndefined();
      await manager.start(prompt, root, { hiddenFromList: true });
      expect(serverOf(calls[3])).toBeUndefined();
    } finally { manager.disposeAll(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the host reader through a live MCP reload and gives a same-name server ordinary permissions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-symbol-reload-"));
    let options: Record<string, unknown> = {};
    const setMcpServers = vi.fn(async (_servers: Record<string, unknown>) => ({ added: [], removed: [], errors: {} }));
    const { manager, settings } = makeDeps({ queryFn: args => {
      options = args.options;
      return Object.assign((async function* () {
        for await (const _ of args.prompt as AsyncIterable<unknown>) yield { type: "result" };
      })(), { setMcpServers });
    } });
    const update = vi.fn((patch: Partial<AppSettings>) => vi.mocked(settings.get).mockReturnValue({ ...baseSettings, ...patch }));
    settings.update = update as unknown as SettingsStore["update"];
    try {
      const id = await manager.start(prompt, root);
      const own = serverOf(options);
      expect(own?.type).toBe("sdk");
      expect((await manager.setMcpServers(id, {})).ok).toBe(true);
      expect(setMcpServers.mock.calls[0][0][name]).toBe(own);
      const external = { type: "stdio", command: "fixture" } as const;
      expect((await manager.setMcpServers(id, { [name]: external })).ok).toBe(true);
      expect(setMcpServers.mock.calls[1][0][name]).toEqual(external);
      await manager.continue(id, prompt);
      expect(serverOf(options)).toEqual(external);
      const hooks = options.hooks as { PreToolUse: { hooks: ((input: unknown) => Promise<unknown>)[] }[] };
      const decision = await hooks.PreToolUse[0].hooks[0]({ tool_name: tool, mcp_server: { name, source: "dynamic" } });
      expect(decision).toEqual({});
    } finally { manager.disposeAll(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("binds the MCP call to the active query and aborts its worker with the session", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-symbol-active-"));
    const optionsReady = roomDeferred<Record<string, unknown>>();
    const finishTurn = roomDeferred<void>();
    const canRead = vi.fn(async () => ({ state: { rules: [] } }));
    const { manager } = makeDeps({ queryFn: args => Object.assign((async function* () {
      for await (const _ of args.prompt as AsyncIterable<unknown>) {
        optionsReady.resolve(args.options);
        await finishTurn.promise;
        yield { type: "result" };
      }
    })(), { listPermissionRules: canRead }) });
    const worker = await import("./code-symbol-runner");
    const lookup = vi.spyOn(worker, "runCodeSymbolLookup").mockResolvedValue({ status: "found" });
    let id = "";
    const session = manager.start(prompt, root, { onSessionId: value => { id = value; } });
    const options = await optionsReady.promise;
    const req = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    const client = new (req("@modelcontextprotocol/sdk/client/index.js").Client)({ name: "test", version: "1" });
    const [a, b] = req("@modelcontextprotocol/sdk/inMemory.js").InMemoryTransport.createLinkedPair();
    const server = serverOf(options)!;
    try {
      await server.instance.connect(b);
      await client.connect(a);
      const read = () => client.callTool({ name: "read_symbol", arguments: { name: "target" } });
      expect((await read()).content).toEqual([{ type: "text", text: '{"status":"found"}' }]);
      const pendingWorker = roomDeferred<unknown>();
      lookup.mockImplementationOnce(() => pendingWorker.promise);
      const pendingRead = read();
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
      manager.abort(id);
      expect(lookup.mock.calls[1][2]?.aborted).toBe(true);
      pendingWorker.resolve("old result");
      expect((await pendingRead).isError).toBe(true);
      expect((await read()).isError).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      finishTurn.resolve(); await session;
      await client.close(); await server.instance.close();
      lookup.mockRestore(); manager.disposeAll(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SDK session metering", () => {
  const prompt = { text: "hello", attachments: [] };

  it("uses the latest primary request with cache input, ignoring sidechains and turn totals", async () => {
    const { manager } = makeDeps({ queryFn: async function* () {
      for (const tokens of [500, 100]) yield { type: "assistant", message: { content: [], usage: {
        input_tokens: tokens, cache_read_input_tokens: 190000, cache_creation_input_tokens: 1000,
      } } };
      yield { type: "assistant", parent_tool_use_id: "task", message: { content: [], usage: { input_tokens: 15 } } };
      yield { type: "result", usage: { input_tokens: 600 } };
    } });
    const id = await manager.start(prompt, os.tmpdir(), { model: "selected-provider/selected-model" });
    expect(manager.list().find(item => item.id === id)?.contextUsage).toMatchObject({
      modelId: "selected-provider/selected-model", usedTokens: 191100, occupancySource: "request", estimated: true,
    });
    manager.disposeAll();
  });

  it("requests only the SDK summary and honors its policy window", async () => {
    const getContextUsage = vi.fn().mockResolvedValue({ model: "underlying", totalTokens: 125, rawMaxTokens: 1000 });
    const { manager } = makeDeps({ queryFn: () => Object.assign((async function* () {
      yield { type: "result", usage: { input_tokens: 30 } };
    })(), { getContextUsage }) });
    await manager.start(prompt, os.tmpdir(), { model: "account/underlying" });
    expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
    expect(manager.list()[0].contextUsage).toMatchObject({ modelId: "account/underlying", usedTokens: 125, limitTokens: 1000, source: "sdk", occupancySource: "sdk" });
    manager.disposeAll();
  });

  it.each(["override", "default"])("ignores another model's occupancy when the %s selection changes", async change => {
    const oldModel = "account-a/small";
    const newModel = "account-b/large";
    const ctx = makeDeps({ queryFn: ({ prompt: stream }) => (async function* () {
      for await (const _ of stream as AsyncIterable<unknown>) {
        yield { type: "assistant", context_usage: { model: "resolved-model", total_tokens: 900, raw_max_tokens: 1000 }, message: { content: [] } };
        yield { type: "result", session_id: "same-sdk-session" };
      }
    })() });
    vi.mocked(ctx.settings.get).mockReturnValue({ ...baseSettings, defaultModel: oldModel });
    const id = await ctx.manager.start(prompt, os.tmpdir(), change === "override" ? { model: oldModel } : undefined);
    const compact = vi.spyOn(ctx.manager, "compressSession");
    if (change === "default") vi.mocked(ctx.settings.get).mockReturnValue({ ...baseSettings, defaultModel: newModel });
    await ctx.manager.continue(id, { text: "next", attachments: [] }, change === "override" ? { model: newModel } : undefined);
    expect(compact).not.toHaveBeenCalled();
    await ctx.manager.continue(id, { text: "same model", attachments: [] });
    expect(compact).toHaveBeenCalledOnce();
    ctx.manager.disposeAll();
  });

  it("never treats result-only aggregate input as context occupancy", async () => {
    const { manager } = makeDeps({ queryFn: async function* () {
      yield { type: "result", usage: { input_tokens: 300, output_tokens: 60 } };
    } });
    await manager.start(prompt, os.tmpdir());
    expect(manager.list()[0].contextUsage).toBeUndefined();
    manager.disposeAll();
  });

  it("refreshes an SDK estimate after a later real request in the same turn", async () => {
    const getContextUsage = vi.fn().mockResolvedValue({ totalTokens: 720, rawMaxTokens: 1000 });
    const { manager } = makeDeps({ queryFn: () => Object.assign((async function* () {
      yield { type: "assistant", context_usage: { total_tokens: 310, raw_max_tokens: 1000 }, message: { id: "a", content: [] } };
      yield { type: "stream_event", event: { type: "message_start", message: { id: "b", usage: { input_tokens: 83 } } } };
      yield { type: "result" };
    })(), { getContextUsage }) });
    await manager.start(prompt, os.tmpdir());
    expect(manager.list()[0].contextUsage?.usedTokens).toBe(720);
    expect(getContextUsage).toHaveBeenCalledOnce();
    manager.disposeAll();
  });

  it("rebases on an explicit SDK conversation reset even when the next snapshot grows", async () => {
    let turns = 0;
    const { manager } = makeDeps({ queryFn: async function* ({ prompt: stream }) {
      for await (const _ of stream as AsyncIterable<unknown>) {
        if (++turns === 2) yield { type: "conversation_reset", session_id: "lineage", new_conversation_id: "new", trigger: "clear" };
        yield { type: "result", ...(turns === 1 ? { session_id: "lineage" } : {}), total_cost_usd: turns === 1 ? 1 : 3 };
      }
    } });
    const id = await manager.start(prompt, os.tmpdir());
    await manager.continue(id, { text: "/clear", attachments: [] });
    expect(manager.list()[0].usage?.costUsd).toBe(4);
    manager.disposeAll();
  });

  it("preserves the SDK cost baseline across reopen, restart, an error zero and a reset", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-meter-"));
    const archive = new SessionArchive(dir);
    const values = [1, 2, 0, 3, 0.5, 1.5];
    const queryFn: QueryFn = async function* ({ prompt: stream }) {
      for await (const _ of stream as AsyncIterable<unknown>) {
        const cost = values.shift();
        yield { type: "result", session_id: "lineage", is_error: cost === 0, total_cost_usd: cost };
      }
    };
    let ctx = makeDeps({ archive, queryFn });
    try {
      const id = await ctx.manager.start(prompt, os.tmpdir());
      await ctx.manager.continue(id, prompt);
      expect(ctx.manager.list()[0].usage?.costUsd).toBe(2);
      ctx.manager.disposeAll();
      ctx = makeDeps({ archive, queryFn });
      for (const expected of [2, 3, 3.5, 4.5]) {
        await ctx.manager.continue(id, prompt);
        expect(ctx.manager.list()[0].usage?.costUsd).toBe(expected);
      }
    } finally {
      ctx.manager.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["sqlite", "json"])("keeps pre-clear history read-only and out of the next handoff after restarting %s", async backend => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-clear-"));
    const db = backend === "sqlite" ? AppDatabase.open(dir)! : undefined;
    const reset = { type: "conversation_reset", trigger: "clear", session_id: randomUUID(), new_conversation_id: randomUUID(),
      uuid: randomUUID(), user_message_uuid: randomUUID(), timestamp: "2026-11-11T12:00:00Z" } satisfies import("@anthropic-ai/claude-agent-sdk").SDKConversationResetMessage;
    const rewindFiles = vi.fn(async () => ({ canRewind: true }));
    let lineage = reset.session_id;
    const prompts: string[] = [];
    const resume: unknown[] = [];
    let failedHandoff = false;
    const queryFn: QueryFn = ({ prompt: stream, options }) => {
      resume.push(options.resume);
      return Object.assign((async function* () {
        for await (const message of stream as AsyncIterable<unknown>) {
          const text = userTextFromPrompt(message);
          prompts.push(text);
          if (text.includes("after compact") && !failedHandoff) {
            failedHandoff = true;
            yield { type: "result", subtype: "error_during_execution", session_id: "failed-fresh", is_error: true };
            continue;
          }
          if (text === "/clear") {
            lineage = reset.new_conversation_id;
            yield reset;
            yield { type: "user", session_id: reset.session_id, uuid: reset.user_message_uuid, message: { role: "user", content: "/clear" } };
          } else {
            yield { type: "user", session_id: lineage, uuid: "checkpoint-" + prompts.length, message: { role: "user", content: text } };
            yield { type: "assistant", session_id: lineage, message: { content: [{ type: "text", text: "answer " + text }] } };
          }
          yield { type: "result", subtype: "success", session_id: text === "/clear" ? reset.session_id : lineage, total_cost_usd: text === "/clear" ? 0 : 1 };
        }
      })(), { rewindFiles });
    };
    const summarize = vi.fn(async () => "summary of new work");
    const open = () => makeDeps({ archive: new SessionArchive(dir, db), queryFn,
      compressor: { compress: (items, options) => compressContext(items, { summarize }, options) } });
    let ctx = open();
    try {
      const id = await ctx.manager.start({ text: "PRIVATE_BEFORE_CLEAR", attachments: [] }, dir);
      const stalePage = ctx.manager.getTranscript(id);
      const store = (ctx.manager as unknown as { toolOutputStore: import("./tool-output-store").ToolOutputStore }).toolOutputStore;
      const handle = store.save(id, "old-call", "old tool body")!;
      await ctx.manager.continue(id, { text: "/clear", attachments: [] });
      ctx.manager.saveTranscript(id, stalePage, { replace: true });
      ctx.manager.saveTranscript(id, stalePage);
      expect(store.read(id, "old-call", handle, 0, 20)).toBeUndefined();
      expect(ctx.manager.getTranscript(id).find(i => i.kind === "text" && i.text === "PRIVATE_BEFORE_CLEAR")).toMatchObject({ historicalTurn: true });
      expect((await ctx.manager.rewindToUserMessage(id, "checkpoint-1")).ok).toBe(false);
      expect(rewindFiles).not.toHaveBeenCalled();
      await ctx.manager.continue(id, { text: "new turn 1", attachments: [] });
      expect(resume).toEqual([undefined, reset.new_conversation_id]);
      ctx.manager.disposeAll();
      ctx = open();
      await ctx.manager.continue(id, { text: "new turn 2", attachments: [] });
      for (let n = 3; n <= 5; n++) await ctx.manager.continue(id, { text: "new turn " + n, attachments: [] });
      expect((await ctx.manager.rewindToUserMessage(id, "checkpoint-1")).ok).toBe(false);
      expect(ctx.manager.getTranscript(id)).toContainEqual(expect.objectContaining({ text: "new turn 1", sdkMsgId: "checkpoint-3" }));
      expect((await ctx.manager.compressSession(id)).ok).toBe(true);
      expect(summarize.mock.calls.flat().join(" ")).not.toContain("PRIVATE_BEFORE_CLEAR");
      ctx.manager.disposeAll();
      ctx = open();
      await ctx.manager.continue(id, { text: "after compact", attachments: [] });
      expect(prompts.at(-1)).toContain("new turn 5");
      expect(prompts.at(-1)).not.toContain("PRIVATE_BEFORE_CLEAR");
      await ctx.manager.continue(id, { text: "retry handoff", attachments: [] });
      expect(prompts.at(-1)).toContain("after compact");
      expect(prompts.at(-1)).not.toContain("PRIVATE_BEFORE_CLEAR");
      expect(ctx.manager.getTranscript(id)).toContainEqual(expect.objectContaining({ text: "PRIVATE_BEFORE_CLEAR" }));
    } finally { ctx.manager.disposeAll(); db?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("charges only new spend after resuming at an earlier user checkpoint", async () => {
    let ordinal = 0;
    const costs = [1, 2, 3, 2.5];
    const { manager } = makeDeps({ queryFn: ({ prompt: stream }) => Object.assign((async function* () {
      for await (const message of stream as AsyncIterable<unknown>) {
        yield { type: "user", session_id: "sdk", uuid: "uuid-" + ordinal, message: { role: "user", content: userTextFromPrompt(message) } };
        yield { type: "result", session_id: "sdk", total_cost_usd: costs[ordinal++] };
      }
    })(), { rewindFiles: async () => ({ canRewind: true }) }) });
    const id = await manager.start(prompt, os.tmpdir());
    await manager.continue(id, { text: "second", attachments: [] });
    await manager.continue(id, { text: "third", attachments: [] });
    expect((await manager.rewindToUserMessage(id, "uuid-1")).ok).toBe(true);
    await manager.continue(id, { text: "new work", attachments: [] });
    expect(manager.list()[0].usage?.costUsd).toBe(4.5);
    manager.disposeAll();
  });
});

describe("compaction handoff", () => {
  it("lets SDK compaction own the live query and shares its cooldown with manual compact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-compact-"));
    type Hooks = Record<"PreCompact" | "PostCompact", Array<{ hooks: Array<() => Promise<unknown>> }>>;
    let hooks: Hooks;
    const compress = vi.fn();
    const ctx = makeDeps({ archive: new SessionArchive(dir), compressor: { compress }, queryFn: args => {
      hooks = args.options.hooks as Hooks;
      return (async function* () {
        for await (const _ of args.prompt as AsyncIterable<unknown>) yield { type: "result", subtype: "success" };
      })();
    } });
    try {
      const id = await ctx.manager.start({ text: "fixture", attachments: [] }, dir);
      await hooks!.PreCompact[0].hooks[0]();
      expect((await ctx.manager.compressSession(id)).message).toMatch(/running/i);
      await hooks!.PostCompact[0].hooks[0]();
      expect((await ctx.manager.compressSession(id)).message).toMatch(/cooldown/i);
      expect(compress).not.toHaveBeenCalled();
    } finally {
      ctx.manager.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const history: ChatItem[] = Array.from({ length: 10 }, (_, i) => ({
    kind: "text", role: i % 2 ? "assistant" : "user", id: String(i), text: `sentinel-${i}`,
  }));
  history.splice(9, 0, { kind: "tool", id: "read", tool: {
    id: "call-1", name: "Read", summary: "answer.txt", resultPreview: "final-tool-result", status: "done",
  } });
  const compressor = { compress: (items: ChatItem[]) => compressContext(items, { summarize: async () => "prefix summary" }) };
  it.each(["compact", "rewind"])("reauthorizes only the %s branch's retained full tool result", async (branch) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-branch-"));
    const dbPath = path.join(dir, "tool.sqlite3");
    const store = new ToolOutputStore(dbPath);
    const archive = new SessionArchive(dir);
    const handles: string[] = [], replies: boolean[] = [], prompts: string[] = [];
    const queryFn: QueryFn = args => Object.assign((async function* () {
      for await (const msg of args.prompt as AsyncIterable<unknown>) {
        prompts.push(userTextFromPrompt(msg));
        if (handles.length) {
          const server = (args.options.mcpServers as Record<string, ToolOutputBinding["server"]>)["agentos-results"];
          const req = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
          const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
          const client = new Client({ name: "test", version: "1" });
          const [a, b] = req("@modelcontextprotocol/sdk/inMemory.js").InMemoryTransport.createLinkedPair();
          await server.instance.connect(b); await client.connect(a);
          try {
            for (const handle of handles) {
              const result = await client.callTool({ name: "result_read", arguments: { handle } });
              const search = await client.callTool({ name: "result_read", arguments: { handle, query: "fixture" } });
              expect(Boolean(search.isError)).toBe(Boolean(result.isError));
              replies.push(!result.isError);
            }
          } finally { await client.close(); await server.instance.close(); }
        }
        yield { type: "result", subtype: "success", session_id: "sdk-lineage" };
      }
    })(), { rewindFiles: async () => ({ canRewind: true, filesChanged: [] }) });
    const ctx = makeDeps({ archive, compressor, queryFn, toolOutputDatabasePath: dbPath });
    try {
      const id = await ctx.manager.start({ text: "start", attachments: [] }, dir);
      const items: ChatItem[] = [];
      for (let n = 0; n < 5; n++) {
        items.push({ kind: "text", id: "u" + n, role: "user", text: "turn " + n, sdkMsgId: "anchor" + n });
        if (n === 0 || n === 4) {
          const call = "call" + n;
          const handle = store.save(id, call, "full text for " + call)!;
          handles.push(handle);
          items.push({ kind: "tool", id: call, tool: { id: call, name: "mcp__browser__browser_console_messages",
            status: "done", summary: "", resultPreview: "preview lacking any handle", outputHandle: handle } });
        }
      }
      ctx.manager.saveTranscript(id, items, { replace: true });
      if (branch === "compact") expect((await ctx.manager.compressSession(id)).ok).toBe(true);
      else expect((await ctx.manager.rewindToUserMessage(id, "anchor2")).ok).toBe(true);
      await ctx.manager.continue(id, { text: "continue", attachments: [] });
      expect(replies).toEqual(branch === "compact" ? [false, true] : [true, false]);
      if (branch === "compact") {
        expect(prompts.at(-1)).toContain(handles[1]);
        expect(prompts.at(-1)).not.toContain(handles[0]);
      }
    } finally { ctx.manager.disposeAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["json", "sqlite"])("sends the retained turns on a fresh query after restart (%s)", async (backend) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-restart-"));
    const db = backend === "sqlite" ? AppDatabase.open(dir)! : null;
    if (backend === "sqlite") expect(db).toBeTruthy();
    const archive = new SessionArchive(dir, db);
    const messages: string[] = [];
    const options: Record<string, unknown>[] = [];
    const queryFn: QueryFn = args => (async function* () {
      options.push(args.options);
      for await (const msg of args.prompt as AsyncIterable<unknown>) {
        messages.push(userTextFromPrompt(msg));
        yield { type: "result", subtype: "success", session_id: "lineage-" + options.length };
      }
    })();
    let ctx = makeDeps({ archive, queryFn, compressor });
    try {
      const id = await ctx.manager.start({ text: "initial", attachments: [] }, dir);
      ctx.manager.saveTranscript(id, history, { replace: true });
      expect((await ctx.manager.compressSession(id)).ok).toBe(true);
      expect(messages).toHaveLength(1);
      ctx.manager.disposeAll();
      const reopened = new SessionArchive(dir, db);
      ctx = makeDeps({ archive: reopened, queryFn, compressor });
      await ctx.manager.continue(id, { text: "new question", attachments: [] });
      expect(options[1].resume).toBeUndefined();
      for (const part of ["prefix summary", "sentinel-8", "Read", "answer.txt", "final-tool-result", "sentinel-9", "new question"]) {
        expect(messages[1]).toContain(part);
      }
      expect(messages[1]).not.toContain("sentinel-0");
      const [snapshot] = reopened.listCompactions(id);
      expect(reopened.loadCompaction(id, snapshot.revision)?.original).toEqual(history);
      ctx.manager.closeSession(id);
      await ctx.manager.continue(id, { text: "ordinary", attachments: [] });
      expect(options[2].resume).toBe("lineage-2");
      expect(messages[2]).toBe("ordinary");
    } finally {
      ctx.manager.disposeAll(); db?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each(["abort", "new prompt", "close", "model", "rewind"])("discards a pending summary on %s", async action => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-fence-"));
    const archive = new SessionArchive(dir);
    const summary = roomDeferred<string>();
    const ctx = makeDeps({ archive, compressor: { compress: items => compressContext(items, { summarize: () => summary.promise }) } });
    try {
      const id = await ctx.manager.start({ text: "initial", attachments: [] }, dir);
      ctx.manager.saveTranscript(id, history, { replace: true });
      const compact = ctx.manager.compressSession(id, undefined, { autoContinue: true });
      if (action === "abort") ctx.manager.abort(id);
      if (action === "new prompt") await ctx.manager.continue(id, { text: "newer", attachments: [] });
      if (action === "close") ctx.manager.closeSession(id);
      if (action === "model") vi.mocked(ctx.settings.get).mockReturnValue({ ...baseSettings, defaultModel: "new-model" });
      if (action === "rewind") await ctx.manager.rewindToUserMessage(id, "anchor");
      summary.resolve("late summary");
      expect((await compact).ok).toBe(false);
      expect(ctx.manager.getTranscript(id)[0]).toEqual(history[0]);
      expect(archive.listCompactions(id)).toHaveLength(0);
    } finally { ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["json", "sqlite"])("retains the original transcript and lineage when publication fails (%s)", async backend => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-rollback-"));
    const db = backend === "sqlite" ? AppDatabase.open(dir)! : null;
    const archive = new SessionArchive(dir, db);
    const ctx = makeDeps({ archive, compressor });
    try {
      const id = await ctx.manager.start({ text: "go", attachments: [] }, dir);
      ctx.manager.saveTranscript(id, history, { replace: true });
      ctx.manager.flushPendingPersistence();
      const fail = () => { throw new Error("Cannot publish index"); };
      const fault = db ? vi.spyOn(db, "upsertSession").mockImplementationOnce(fail)
        : vi.spyOn(archive, "upsertSummary").mockImplementationOnce(fail);
      expect((await ctx.manager.compressSession(id)).ok).toBe(false);
      fault.mockRestore();
      const reopened = new SessionArchive(dir, db);
      expect(reopened.loadItems(id).map(i => i.id)).toEqual(history.map(i => i.id));
      expect(reopened.listCompactions(id)).toEqual([]);
      expect(reopened.loadIndex()[0].sdkSessionId).toBe("sdk-session-1");
    } finally { ctx.manager.disposeAll(); db?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("folds high occupancy into the next requested turn and retries a failed fresh launch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-next-"));
    const archive = new SessionArchive(dir);
    archive.upsertSummary({ id: "id", title: "session", cwd: dir, status: "idle", sdkSessionId: "old", updatedAt: 1,
      contextUsage: { modelId: baseSettings.defaultModel, ratio: 0.9, usedTokens: 180_000, limitTokens: 200_000, updatedAt: 1, source: "default", occupancySource: "request", estimated: true } });
    archive.saveItems("id", history);
    const messages: string[] = [];
    const resumes: unknown[] = [];
    const queryFn: QueryFn = args => (async function* () {
      resumes.push(args.options.resume);
      for await (const msg of args.prompt as AsyncIterable<unknown>) {
        messages.push(userTextFromPrompt(msg));
        if (messages.length === 1) {
          yield { type: "assistant", session_id: "bad", isApiErrorMessage: true, message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } };
          yield { type: "result", subtype: "error_during_execution", session_id: "bad", is_error: true };
        } else yield { type: "result", subtype: "success", session_id: "good" };
      }
    })();
    const ctx = makeDeps({ archive, compressor, queryFn });
    try {
      await ctx.manager.continue("id", { text: "first attempt", attachments: [] });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("prefix summary");
      expect(archive.loadIndex()[0].pendingHandoff).toBeTruthy();
      expect(archive.loadIndex()[0].sdkSessionId).toBeUndefined();
      await ctx.manager.continue("id", { text: "second attempt", attachments: [] });
      expect(resumes).toEqual([undefined, undefined]);
      for (const content of ["prefix summary", "sentinel-9", "first attempt", "second attempt"]) expect(messages[1]).toContain(content);
      expect(archive.loadIndex()[0]).toMatchObject({ sdkSessionId: "good" });
      expect(archive.loadIndex()[0].pendingHandoff).toBeUndefined();
    } finally { ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["default", "summary"])("sends a waiting prompt exactly once when the %s model changes during the auxiliary request", async setting => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-settings-"));
    const archive = new SessionArchive(dir);
    const summary = roomDeferred<string>();
    const summarize = vi.fn().mockImplementationOnce(() => summary.promise).mockResolvedValue("fresh summary");
    const calls: Array<{ model: unknown; text: string }> = [];
    const queryFn: QueryFn = ({ prompt, options }) => (async function* () {
      for await (const msg of prompt as AsyncIterable<unknown>) {
        calls.push({ model: options.model, text: userTextFromPrompt(msg) });
        yield { type: "assistant", context_usage: { total_tokens: 900, raw_max_tokens: 1000 }, message: { content: [] } };
        yield { type: "result", subtype: "success", session_id: "lineage" };
      }
    })();
    const ctx = makeDeps({ archive, queryFn, compressor: { compress: (items, opts) => compressContext(items, { summarize }, opts) } });
    try {
      const id = await ctx.manager.start({ text: "first", attachments: [] }, dir);
      ctx.manager.saveTranscript(id, history, { replace: true });
      const pending = ctx.manager.continue(id, { text: "original question", attachments: [] });
      await vi.waitFor(() => expect(summarize).toHaveBeenCalledOnce());
      const model = setting === "default" ? "new-model" : baseSettings.defaultModel;
      vi.mocked(ctx.settings.get).mockReturnValue({ ...baseSettings, defaultModel: model, tokenSavings: { mode: "balanced", summaryModel: "other" } });
      ctx.manager.cancelPendingCompressions();
      summary.resolve("obsolete");
      await pending;
      expect(calls.filter(item => item.text === "original question")).toEqual([{ model, text: "original question" }]);
      await vi.waitFor(() => expect(archive.listCompactions(id)).toHaveLength(1));
      const [compaction] = archive.listCompactions(id);
      expect(archive.loadCompaction(id, compaction.revision)?.summaryText).toBe("fresh summary");
      expect(ctx.manager.getSummary(id)?.status).toBe("idle");
    } finally { summary.resolve("late"); ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("automatically compacts after a completed high-occupancy turn without waiting for another prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-after-turn-"));
    const archive = new SessionArchive(dir);
    archive.upsertSummary({ id: "id", title: "fixture", cwd: dir, status: "idle", updatedAt: 1, sdkSessionId: "old" });
    archive.saveItems("id", history);
    const summarize = vi.fn(async () => "automatic summary");
    const prompts: string[] = [];
    const ctx = makeDeps({ archive, compressor: { compress: (items, opts) => compressContext(items, { summarize }, opts) },
      queryFn: ({ prompt }) => (async function* () {
        for await (const message of prompt as AsyncIterable<unknown>) {
          prompts.push(userTextFromPrompt(message));
          yield { type: "assistant", context_usage: { total_tokens: 180_000, raw_max_tokens: 200_000 }, message: { content: [] } };
          yield { type: "result", subtype: "success", session_id: "current" };
        }
      })(),
    });
    try {
      await ctx.manager.continue("id", { text: "finish this turn", attachments: [] });
      await vi.waitFor(() => expect(archive.listCompactions("id")).toHaveLength(1));
      expect(prompts).toEqual(["finish this turn"]);
      expect(ctx.sessions.some(session => session.contextCompression?.state === "running")).toBe(true);
      expect(ctx.manager.getSummary("id")?.contextCompression?.state).toBe("completed");
      await ctx.manager.continue("id", { text: "next task", attachments: [] });
      expect(prompts[1]).toContain("automatic summary");
      expect(prompts[1]).toContain("next task");
      expect(summarize).toHaveBeenCalledOnce();
    } finally { ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("publishes an automatic compression failure while retaining the transcript and SDK lineage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-auto-failure-"));
    const archive = new SessionArchive(dir);
    archive.upsertSummary({ id: "id", title: "fixture", cwd: dir, status: "idle", updatedAt: 1, sdkSessionId: "old" });
    archive.saveItems("id", history);
    const ctx = makeDeps({ archive, compressor: { compress: async () => { throw new Error("Summary provider unavailable"); } },
      queryFn: ({ prompt }) => (async function* () {
        for await (const _ of prompt as AsyncIterable<unknown>) {
          yield { type: "assistant", context_usage: { total_tokens: 180_000, raw_max_tokens: 200_000 }, message: { content: [] } };
          yield { type: "result", subtype: "success", session_id: "current" };
        }
      })(),
    });
    try {
      await ctx.manager.continue("id", { text: "finish this turn", attachments: [] });
      await vi.waitFor(() => expect(ctx.manager.getSummary("id")?.contextCompression?.state).toBe("failed"));
      expect(ctx.manager.getSummary("id")?.contextCompression?.message).toContain("Summary provider unavailable");
      expect(archive.listCompactions("id")).toEqual([]);
      expect(ctx.manager.getTranscript("id")).toContainEqual(expect.objectContaining({ text: "sentinel-0" }));
      expect(archive.loadIndex()[0].sdkSessionId).toBe("current");
    } finally { ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("lets a new prompt interrupt automatic compression without publishing the stale summary or a failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-auto-cancel-"));
    const archive = new SessionArchive(dir);
    archive.upsertSummary({ id: "id", title: "fixture", cwd: dir, status: "idle", updatedAt: 1, sdkSessionId: "old" });
    archive.saveItems("id", history);
    const pending = roomDeferred<string>();
    const summarize = vi.fn(() => pending.promise);
    let turn = 0;
    const ctx = makeDeps({ archive, compressor: { compress: (items, opts) => compressContext(items, { summarize }, opts) },
      queryFn: ({ prompt }) => (async function* () {
        for await (const _ of prompt as AsyncIterable<unknown>) {
          yield { type: "assistant", context_usage: { total_tokens: ++turn === 1 ? 180_000 : 100, raw_max_tokens: 200_000 }, message: { content: [] } };
          yield { type: "result", subtype: "success", session_id: "current" };
        }
      })(),
    });
    try {
      await ctx.manager.continue("id", { text: "finish first", attachments: [] });
      await vi.waitFor(() => expect(summarize).toHaveBeenCalledOnce());
      await ctx.manager.continue("id", { text: "newer task", attachments: [] });
      pending.resolve("STALE_SUMMARY");
      await vi.waitFor(() => expect(ctx.manager.getSummary("id")?.contextCompression).toBeUndefined());
      expect(archive.listCompactions("id")).toEqual([]);
      expect(ctx.manager.getTranscript("id")).toContainEqual(expect.objectContaining({ text: "newer task" }));
      expect(JSON.stringify(ctx.manager.getTranscript("id"))).not.toContain("STALE_SUMMARY");
    } finally { pending.resolve("late"); ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["text", "missing", "image", "oversized"])("preflights the original %s attachment of an older turn", async kind => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-attachment-"));
    const archive = new SessionArchive(dir);
    const file = path.join(dir, kind === "image" ? "fixture.png" : "fixture.txt");
    fs.writeFileSync(file, kind === "oversized" ? "large".repeat(6800) : "ORIGINAL_ATTACHMENT_RULE");
    const summarize = vi.fn(async (_text: string, _media?: unknown[]) => "summary");
    const ctx = makeDeps({ archive, compressor: { compress: (items, opts) => compressContext(items, { summarize }, opts) } });
    try {
      const id = await ctx.manager.start({ text: "earlier request", attachments: [{
        name: path.basename(file), path: file, size: fs.statSync(file).size, kind: kind === "image" ? "image" : "text",
        mimeType: kind === "image" ? "image/png" : "text/plain",
      }] }, dir);
      const [user] = ctx.manager.getTranscript(id);
      fs.writeFileSync(file, "DIFFERENT_CONTENT_AT_PATH");
      const source = [{ ...user, id: kind === "missing" ? "legacy-with-no-saved-bytes" : user.id }, ...history];
      ctx.manager.saveTranscript(id, source, { replace: true });
      const result = await ctx.manager.compressSession(id);
      if (kind !== "missing") {
        expect(result.ok).toBe(true);
        if (kind === "text") expect(summarize.mock.calls[0][0]).toContain("ORIGINAL_ATTACHMENT_RULE");
        if (kind === "image") expect(summarize.mock.calls.flatMap(call => call[1] ?? [])).toContainEqual(expect.objectContaining({
          type: "image", source: expect.objectContaining({ data: Buffer.from("ORIGINAL_ATTACHMENT_RULE").toString("base64") }),
        }));
        expect(summarize.mock.calls.map(call => call[0]).join(" ")).not.toContain("DIFFERENT_CONTENT_AT_PATH");
        const [index] = archive.listCompactions(id);
        expect(JSON.stringify(archive.loadCompaction(id, index.revision)?.original)).not.toContain("ORIGINAL_ATTACHMENT_RULE");
        expect(JSON.stringify(ctx.manager.getTranscript(id))).not.toContain("ORIGINAL_ATTACHMENT_RULE");
      } else {
        expect(result.ok).toBe(false);
        expect(summarize).not.toHaveBeenCalled();
        expect(archive.listCompactions(id)).toEqual([]);
        expect(ctx.manager.getTranscript(id)).toEqual(source);
      }
    } finally { ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("attachment validation", () => {
  it("wraps the final model endpoint, including borrowed-room endpoints, and disposes it", async () => {
    const compatibility = {
      environment: vi.fn(async (env: Record<string, string>) => ({ ...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:19191/pdf" })),
      dispose: vi.fn(),
    };
    let options: Record<string, unknown> = {};
    const ctx = makeDeps({ pdfCompatibility: compatibility, queryFn: async function* (args) {
      options = args.options;
      await takeFirstUserText(args.prompt);
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    } });
    try {
      await ctx.manager.start({ text: "read PDF", attachments: [] }, process.cwd(), {
        extraEnv: { ANTHROPIC_BASE_URL: "http://127.0.0.1:19292", ANTHROPIC_AUTH_TOKEN: "room-borrow:fixture" },
      });
      expect(compatibility.environment).toHaveBeenCalledWith(expect.objectContaining({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:19292", ANTHROPIC_AUTH_TOKEN: "room-borrow:fixture",
      }));
      expect(options.env).toMatchObject({ ANTHROPIC_BASE_URL: "http://127.0.0.1:19191/pdf", ANTHROPIC_AUTH_TOKEN: "room-borrow:fixture" });
    } finally { ctx.manager.disposeAll(); }
    expect(compatibility.dispose).toHaveBeenCalledOnce();
  });
  it("rejects unreadable attachments before creating a model query", async () => {
    const queryFn = vi.fn(defaultQueryFn());
    const { manager } = makeDeps({ queryFn });
    await expect(manager.start({ text: "Please read", attachments: [{ name: "missing.pdf",
      path: path.join(os.tmpdir(), `missing-${Date.now()}-${Math.random()}.pdf`),
      size: 12, mimeType: "application/pdf", kind: "binary" }] }, os.tmpdir())).rejects.toThrow("File not found");
    expect(queryFn).not.toHaveBeenCalled();
    manager.disposeAll();
  });
  it("ends the optimistic running state when a continuation attachment is unreadable", async () => {
    const queryFn = vi.fn(defaultQueryFn());
    const { manager, emitted } = makeDeps({ queryFn });
    const id = await manager.start({ text: "hello", attachments: [] }, os.tmpdir());
    const calls = queryFn.mock.calls.length;
    await expect(manager.continue(id, { text: "Read this", attachments: [{ name: "missing.pdf",
      path: path.join(os.tmpdir(), `missing-${Date.now()}-${Math.random()}.pdf`),
      size: 12, mimeType: "application/pdf", kind: "binary" }] })).rejects.toThrow("File not found");
    expect(queryFn).toHaveBeenCalledTimes(calls);
    expect(emitted.at(-1)).toMatchObject({ type: "result", sessionId: id, ok: false, error: expect.stringContaining("File not found") });
    manager.disposeAll();
  });
});

describe("official room sandbox", () => {
  it("enables strict sandboxing only for room queries and uses their workspace", async () => {
    const options: Record<string, unknown>[] = [];
    const queryFn: QueryFn = async function* (args) {
      options.push(args.options);
      await takeFirstUserText(args.prompt);
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };
    const { manager } = makeDeps({ queryFn });
    await manager.start({ text: "personal", attachments: [] }, "D:/personal");
    await manager.start({ text: "room", attachments: [] }, "D:/personal", {
      pathJail: "D:/room", permissionMode: "auto",
    });
    expect(options[0]?.sandbox).toBeUndefined();
    expect(options[0]?.cwd).toBe("D:/personal");
    expect(options[1]).toMatchObject({
      cwd: "D:/room",
      permissionMode: "auto",
      sandbox: {
        enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: false, excludedCommands: [],
        filesystem: { disabled: false },
      },
    });
    // Sandboxing must not replace the existing approval/hook layers.
    expect(options[1]?.canUseTool).toBeTypeOf("function");
    expect(options[1]?.hooks).toHaveProperty("PreToolUse");
  });

  it("reopens a live personal query when adding a jail, and on root changes", async () => {
    const options: Record<string, unknown>[] = [];
    const queryFn: QueryFn = async function* (args) {
      options.push(args.options);
      for await (const _message of args.prompt as AsyncIterable<unknown>) {
        yield { type: "result", subtype: "success", total_cost_usd: 0, session_id: "sdk-room" };
      }
    };
    const { manager } = makeDeps({ queryFn });
    const prompt = { text: "hi", attachments: [] };
    const id = await manager.start(prompt, "D:/personal");
    try {
      await manager.continue(id, prompt, { pathJail: "D:/room" });
      expect(options).toHaveLength(2);
      expect(options[1]).toMatchObject({ cwd: "D:/room", resume: "sdk-room", sandbox: { enabled: true } });
      await manager.continue(id, prompt, { pathJail: "D:/room" });
      expect(options).toHaveLength(2);
      await manager.continue(id, prompt, { pathJail: "D:/another-room" });
      expect(options).toHaveLength(3);
      expect(options[2]).toMatchObject({ cwd: "D:/another-room", sandbox: { enabled: true } });
    } finally {
      manager.abort(id);
    }
  });

  it("still reopens after preparation fails with a staged jail", async () => {
    const options: Record<string, unknown>[] = [];
    const queryFn: QueryFn = async function* (args) {
      options.push(args.options);
      for await (const _message of args.prompt as AsyncIterable<unknown>) {
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      }
    };
    const ctx = makeDeps({ queryFn });
    const prompt = { text: "hi", attachments: [] };
    const id = await ctx.manager.start(prompt, "D:/personal");
    try {
      (ctx.ensureReady as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("CPA unavailable"));
      await expect(ctx.manager.continue(id, prompt, { pathJail: "D:/room" })).rejects.toThrow("CPA unavailable");
      expect(options).toHaveLength(1);
      await ctx.manager.continue(id, prompt, { pathJail: "D:/room" });
      expect(options).toHaveLength(2);
      expect(options[1]?.sandbox).toMatchObject({ enabled: true });
    } finally {
      ctx.manager.abort(id);
    }
  });

  it.each(["throw", "result"])("surfaces sandbox startup failure (%s) without an unsandboxed retry", async (kind) => {
    const queryFn = vi.fn(async function* (args: Parameters<QueryFn>[0]) {
      await takeFirstUserText(args.prompt);
      const error = "Sandbox required but unavailable: the Windows sandbox is not active (feature gate off). Set sandbox.failIfUnavailable=false to allow unsandboxed execution.";
      if (kind === "throw") throw new Error(error);
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [error] };
    });
    const ctx = makeDeps({ queryFn });
    const id = await ctx.manager.start({ text: "hi", attachments: [] }, "D:/room", { pathJail: "D:/room" });
    expect(queryFn).toHaveBeenCalledTimes(1);
    const errors = ctx.emitted.filter(event => event.type === "result" && !event.ok).map(event => event.type === "result" ? event.error : "");
    expect(errors.some(error => error?.includes("官方内置沙箱不可用"))).toBe(true);
    expect(errors.join("\n")).not.toContain("failIfUnavailable=false");
    expect(ctx.manager.list().find(session => session.id === id)?.status).toBe("error");
  });
});

describe("SessionManager progress snapshots", () => {
  const agentStart = { type: "system", subtype: "task_started", task_id: "agent-a", task_type: "local_agent", tool_use_id: "call-a", description: "Inspect code" };
  const warmAgentQuery: QueryFn = async function* (args) {
    for await (const _ of args.prompt as AsyncIterable<unknown>) {
      yield agentStart;
      yield { type: "result", subtype: "success" };
    }
  };
  const taskQuery: QueryFn = async function* (args) {
    await takeFirstUserText(args.prompt);
    yield { type: "assistant", message: { content: [{ type: "tool_use", id: "create", name: "TaskCreate", input: { subject: "Verify implementation", description: "Run the tests" } }] } };
    // The SDK normally omits name on tool_result: resolve it from the start.
    yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "create", content: JSON.stringify({ task: { id: "7", subject: "Verify implementation" } }) }] } };
    yield { type: "assistant", message: { content: [{ type: "tool_use", id: "update", name: "TaskUpdate", input: { taskId: "7", status: "completed" } }] } };
    yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "update", content: JSON.stringify({ success: true, taskId: "7", updatedFields: ["status"], statusChange: { from: "pending", to: "completed" } }) }] } };
    for (let i = 0; i < 60; i++) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: `read-${i}`, name: "Read", input: { file_path: "src/index.ts" } }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `read-${i}`, content: "ok" }] } };
    }
    yield { type: "result", subtype: "success", total_cost_usd: 0 };
  };

  it("keeps task progress when task creation is outside the visible transcript page", async () => {
    const ctx = makeDeps({ queryFn: taskQuery });
    try {
      const id = await ctx.manager.start({ text: "go", attachments: [] }, "D:/project");
      expect(ctx.manager.getTranscriptPage(id).items.some(item => item.id === "create")).toBe(false);
      expect(ctx.manager.getSummary(id)?.progress?.tasks).toEqual([
        expect.objectContaining({ id: "7", title: "Verify implementation", status: "completed" }),
      ]);
      expect(ctx.sessions.some(summary => summary.progress?.tasks[0]?.status === "completed")).toBe(true);
    } finally { ctx.manager.disposeAll(); }
  });

  it("restores a progress snapshot without loading a session's full transcript", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-progress-"));
    const archive = new SessionArchive(dir);
    const ctx = makeDeps({ queryFn: taskQuery, archive });
    let reopened: ReturnType<typeof makeDeps> | undefined;
    try {
      const id = await ctx.manager.start({ text: "go", attachments: [] }, "D:/project");
      ctx.manager.setTaskPlanClosed(id, true);
      ctx.manager.flushPendingPersistence(); ctx.manager.disposeAll();
      const loadItems = vi.spyOn(archive, "loadItems");
      reopened = makeDeps({ archive });
      expect(reopened.manager.getSummary(id)?.progress?.tasks[0]).toMatchObject({ id: "7", status: "completed" });
      expect(reopened.manager.getSummary(id)?.taskPlan).toEqual({ closedAt: expect.any(Number), changedSinceClose: false });
      expect(loadItems).not.toHaveBeenCalled();
      reopened.manager.setTaskPlanClosed(id, false);
      expect(archive.loadIndex().find(session => session.id === id)?.taskPlan).toBeUndefined();
      loadItems.mockRestore();
    } finally {
      ctx.manager.disposeAll(); reopened?.manager.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds progress after an authoritative transcript replacement", async () => {
    const ctx = makeDeps({ queryFn: taskQuery });
    try {
      const id = await ctx.manager.start({ text: "go", attachments: [] }, "D:/project");
      expect(ctx.manager.getSummary(id)?.progress?.tasks).toHaveLength(1);
      ctx.manager.saveTranscript(id, [{ kind: "text", id: "u", role: "user", text: "Before task creation" }], { replace: true });
      expect(ctx.manager.getSummary(id)?.progress?.tasks ?? []).toEqual([]);
      expect(ctx.sessions.at(-1)?.progress?.tasks ?? []).toEqual([]);
    } finally { ctx.manager.disposeAll(); }
  });

  it("keeps closure independent of successful SDK task updates and broadcasts reopening", async () => {
    let id = "";
    const ctx = makeDeps({ queryFn: async function* (args) {
      let closed = false;
      for await (const message of taskQuery(args) as AsyncIterable<any>) {
        if (!closed && message.type === "assistant" && message.message?.content?.[0]?.name === "TaskUpdate") {
          id = ctx.manager.list()[0].id;
          ctx.manager.setTaskPlanClosed(id, true);
          closed = true;
          expect(ctx.manager.getSummary(id)?.progress?.tasks[0].status).toBe("pending");
        }
        yield message;
      }
    } });
    try {
      await ctx.manager.start({ text: "go", attachments: [] }, "D:/project");
      expect(ctx.manager.getSummary(id)).toMatchObject({ taskPlan: { changedSinceClose: true }, progress: { tasks: [{ status: "completed" }] } });
      expect(ctx.sessions.at(-1)?.taskPlan?.changedSinceClose).toBe(true);
      const closedAt = ctx.manager.getSummary(id)?.taskPlan?.closedAt;
      ctx.manager.setTaskPlanClosed(id, true);
      expect(ctx.manager.getSummary(id)?.taskPlan?.closedAt).toBe(closedAt);
      ctx.manager.setTaskPlanClosed(id, false);
      expect(ctx.manager.getSummary(id)?.taskPlan).toBeUndefined();
      expect(ctx.sessions.at(-1)?.taskPlan).toBeUndefined();
      expect(ctx.manager.getSummary(id)?.progress?.tasks[0].status).toBe("completed");
      expect(ctx.manager.setTaskPlanClosed("missing", true)).toBeUndefined();
    } finally { ctx.manager.disposeAll(); }
  });

  it.each([false, true])("lazily backfills and caches archived progress without hydrating history (TodoWrite: %s)", (withTodos) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-progress-legacy-"));
    const archive = new SessionArchive(dir);
    archive.upsertSummary({ id: "legacy", title: "Legacy", cwd: "D:/project", status: "idle", updatedAt: 1 });
    const items: ChatItem[] = Array.from({ length: 90 }, (_, i) => ({ kind: "text", id: `text-${i}`, role: "assistant", text: "History" }));
    if (withTodos) items.unshift({ kind: "tool", id: "todo", tool: { id: "todo", name: "TodoWrite", summary: "", status: "done", todos: [{ content: "Legacy plan", status: "in_progress" }] } });
    archive.saveItems("legacy", items);
    archive.releaseItems("legacy");
    const full = vi.spyOn(archive, "loadItems");
    const pages = vi.spyOn(archive, "loadItemsPage");
    const ctx = makeDeps({ archive });
    let reopened: ReturnType<typeof makeDeps> | undefined;
    try {
      expect(pages).not.toHaveBeenCalled();
      const tail = ctx.manager.getTranscriptPage("legacy");
      expect(tail.items).toHaveLength(40);
      expect(tail.items.some(item => item.id === "todo")).toBe(false);
      const expected: SessionProgress = { tasks: withTodos ? [{ id: "todo-1", title: "Legacy plan", status: "in_progress", scope: "todos" }] : [], agents: [] };
      expect(ctx.manager.getSummary("legacy")?.progress).toEqual(expected);
      expect(ctx.sessions.at(-1)?.progress).toEqual(expected);
      expect(ctx.manager.getMemoryStats().hydratedTranscripts).toBe(0);
      const scannedPages = pages.mock.calls.length;
      ctx.manager.getTranscriptPage("legacy");
      expect(pages).toHaveBeenCalledTimes(scannedPages + 1);
      ctx.manager.disposeAll();
      reopened = makeDeps({ archive });
      reopened.manager.getTranscriptPage("legacy");
      expect(pages).toHaveBeenCalledTimes(scannedPages + 2);
      expect(reopened.manager.getSummary("legacy")?.progress).toEqual(expected);
      expect(full).not.toHaveBeenCalled();
    } finally {
      ctx.manager.disposeAll(); reopened?.manager.disposeAll();
      full.mockRestore(); pages.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])("preserves compressed tasks when rewinding a later turn (restart: %s)", async (restart) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-progress-rewind-"));
    const archive = new SessionArchive(dir);
    let queries = 0;
    const queryFn: QueryFn = (args) => {
      const first = queries++ === 0;
      const gen = (async function* () {
        if (first) { yield* taskQuery(args); return; }
        for await (const _ of args.prompt as AsyncIterable<unknown>) {
          yield { type: "user", uuid: "after-compact", session_id: "sdk-after-compact", message: { role: "user", content: "Continue" } };
          yield { type: "assistant", message: { content: [{ type: "tool_use", id: "later-create", name: "TaskCreate", input: { subject: "Later task" } }] } };
          yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "later-create", content: JSON.stringify({ task: { id: "8", subject: "Later task" } }) }] } };
          yield { type: "result", subtype: "success" };
        }
      })();
      return Object.assign(gen, { rewindFiles: vi.fn().mockResolvedValue({ canRewind: true, filesChanged: [] }), close: vi.fn() });
    };
    const compressor = { compress: async (items: ChatItem[]) => ({ items: [{ kind: "text" as const, id: "summary", role: "system" as const, text: "Compressed" }], summaryText: "Compressed", compressedCount: items.length }) };
    const ctx = makeDeps({ archive, queryFn, compressor });
    let reopened: ReturnType<typeof makeDeps> | undefined;
    try {
      const id = await ctx.manager.start({ text: "go", attachments: [] }, "D:/project");
      ctx.manager.setTaskPlanClosed(id, true);
      expect((await ctx.manager.compressSession(id)).ok).toBe(true);
      expect(ctx.manager.getSummary(id)?.taskPlan?.changedSinceClose).toBe(false);
      await ctx.manager.continue(id, { text: "Continue", attachments: [] });
      expect(ctx.manager.getSummary(id)?.progress?.tasks.map(task => task.id)).toEqual(["7", "8"]);
      let manager = ctx.manager;
      if (restart) {
        manager.disposeAll();
        reopened = makeDeps({ archive, queryFn });
        manager = reopened.manager;
      }
      expect((await manager.rewindToUserMessage(id, "after-compact")).ok).toBe(true);
      expect(manager.getTranscriptPage(id).items.at(-1)).not.toHaveProperty("turnOutcome");
      expect(manager.getSummary(id)?.taskPlan).toBeUndefined();
      expect(archive.loadIndex().find(session => session.id === id)?.taskPlan).toBeUndefined();
      expect(manager.getSummary(id)?.progress?.tasks).toEqual([expect.objectContaining({ id: "7", status: "completed" })]);
      expect(manager.getSummary(id)).not.toHaveProperty("progressBaseline");
      expect(archive.loadIndex().find(summary => summary.id === id)?.progressBaseline?.tasks[0]).toMatchObject({ id: "7", status: "completed" });
    } finally {
      ctx.manager.disposeAll(); reopened?.manager.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears a compression baseline on authoritative transcript replacement", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-progress-replace-"));
    const archive = new SessionArchive(dir);
    const progress: SessionProgress = { tasks: [{ id: "7", title: "Old task", status: "pending" }], agents: [] };
    archive.upsertSummary({ id: "s", title: "Compressed", cwd: "D:/project", status: "idle", updatedAt: 1, progress, progressBaseline: progress });
    const ctx = makeDeps({ archive });
    try {
      ctx.manager.saveTranscript("s", [], { replace: true });
      expect(ctx.manager.getSummary("s")?.progress?.tasks ?? []).toEqual([]);
      expect(archive.loadIndex()[0]?.progressBaseline).toBeUndefined();
    } finally { ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("leaves a background agent live after the parent result and settles it on abort", async () => {
    const ctx = makeDeps({ queryFn: warmAgentQuery });
    try {
      const id = await ctx.manager.start({ text: "go", attachments: [] }, "D:/project");
      expect(ctx.manager.getSummary(id)).toMatchObject({ status: "idle", progress: { agents: [{ status: "running" }] } });
      ctx.manager.abort(id);
      expect(ctx.manager.getSummary(id)?.progress?.agents[0].status).toBe("stopped");
      expect(ctx.emitted).toContainEqual(expect.objectContaining({ type: "agent_progress", agent: expect.objectContaining({ id: "agent-a", status: "stopped" }) }));
      const tool = ctx.manager.getTranscript(id).find(item => item.kind === "tool");
      expect(tool).toMatchObject({ tool: { agent: { status: "stopped" } } });
    } finally { ctx.manager.disposeAll(); }
  });

  it("marks agents unknown when their SDK stream exits without a terminal notification", async () => {
    const queryFn: QueryFn = async function* (args) {
      await takeFirstUserText(args.prompt);
      yield agentStart;
      yield { type: "result", subtype: "success" };
    };
    const ctx = makeDeps({ queryFn });
    try {
      const id = await ctx.manager.start({ text: "go", attachments: [] }, "D:/project");
      expect(ctx.manager.getSummary(id)?.progress?.agents[0].status).toBe("unknown");
    } finally { ctx.manager.disposeAll(); }
  });

  it("flushes the final agent state after shutdown closes warm queries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-progress-close-"));
    const archive = new SessionArchive(dir);
    const ctx = makeDeps({ queryFn: warmAgentQuery, archive });
    try {
      const id = await ctx.manager.start({ text: "go", attachments: [] }, "D:/project");
      ctx.manager.disposeAll();
      expect(archive.loadItems(id).find(item => item.kind === "tool")).toMatchObject({ tool: { agent: { status: "unknown" } } });
      const save = vi.spyOn(archive, "saveItems");
      ctx.manager.flushPendingPersistence();
      expect(save).not.toHaveBeenCalled();
    } finally { ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("restores an unconfirmed agent as unknown in paginated and fully hydrated history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-progress-restore-"));
    const archive = new SessionArchive(dir);
    const agent = { id: "agent-a", toolUseId: "call-a", title: "Inspect", status: "running" as const };
    archive.upsertSummary({ id: "s", title: "Inspect", cwd: "D:/project", updatedAt: 1, status: "idle", progress: { tasks: [], agents: [agent] } });
    archive.saveItems("s", [{ kind: "tool", id: "call-a", tool: { id: "call-a", name: "Agent", summary: "Inspect", status: "done", agent } }]);
    const ctx = makeDeps({ archive });
    try {
      const loadItems = vi.spyOn(archive, "loadItems");
      expect(ctx.manager.getTranscriptPage("s").items[0]).toMatchObject({ tool: { agent: { status: "unknown" } } });
      expect(loadItems).not.toHaveBeenCalled();
      expect(ctx.manager.getTranscript("s")[0]).toMatchObject({ tool: { agent: { status: "unknown" } } });
    } finally { ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("retains progress when context compression removes the original task events", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-progress-compact-"));
    const archive = new SessionArchive(dir);
    const compressor = { compress: vi.fn(async () => ({ items: [{ kind: "text", id: "sum", role: "system", text: "summary" }], summaryText: "summary", compressedCount: 60 })) };
    const ctx = makeDeps({ queryFn: taskQuery, archive, compressor: compressor as never });
    try {
      const id = await ctx.manager.start({ text: "go", attachments: [] }, "D:/project");
      expect((await ctx.manager.compressSession(id)).ok).toBe(true);
      expect(ctx.manager.getTranscript(id).some(item => item.kind === "tool")).toBe(false);
      expect(ctx.manager.getSummary(id)?.progress?.tasks[0]).toMatchObject({ id: "7", status: "completed" });
    } finally { ctx.manager.disposeAll(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["uses medium for a new compatible model", "compatible/custom", "medium", undefined, "high", "medium"],
    ["uses the upstream model default", "custom/upstream", "high", undefined, "low", "high"],
    ["prefers an explicit model choice over its default", "compatible/custom", "medium", "max", "low", "max"],
    ["keeps the legacy fallback when an official model has no default", "openai/gpt-4o", undefined, undefined, "high", "high"],
    ["omits effort when no choice or default exists", "openai/gpt-4o", undefined, undefined, undefined, undefined],
  ] as const)("%s in actual SDK query options", async (_name, model, catalogDefault, explicitEffort, legacyEffort, expected) => {
    let options: Record<string, unknown> = {};
    const ctx = makeDeps({ queryFn: async function* (args) {
      options = args.options;
      await takeFirstUserText(args.prompt);
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    } });
    vi.mocked(ctx.settings.get).mockReturnValue({
      ...baseSettings, defaultModel: model, effort: legacyEffort,
      ...(explicitEffort ? { modelEfforts: { [model]: explicitEffort } } : {}),
    });
    vi.mocked(ctx.cpa.getModelCatalog).mockReturnValue([{ id: model, ...(catalogDefault ? { defaultReasoningEffort: catalogDefault } : {}) }]);
    try {
      await ctx.manager.start({ text: "hello", attachments: [] }, process.cwd());
      expect(options.model).toBe(model);
      expect(options.effort).toBe(expected);
      if (!expected) expect(options).not.toHaveProperty("effort");
    } finally { ctx.manager.disposeAll(); }
  });

  it("reopens a warm query with newly selected effort and resumes its SDK context", async () => {
    const queryOptions: Record<string, unknown>[] = [];
    const appliedEfforts: unknown[] = [];
    const ctx = makeDeps({ queryFn: args => {
      queryOptions.push(args.options);
      return (async function* () {
        for await (const _message of args.prompt as AsyncIterable<unknown>) {
          appliedEfforts.push(args.options.effort);
          yield { type: "assistant", session_id: "sdk-effort", message: { content: [{ type: "text", text: "OK" }] } };
          yield { type: "result", subtype: "success", total_cost_usd: 0 };
        }
      })();
    } });
    const model = "compatible/custom";
    const settings: AppSettings = { ...baseSettings, defaultModel: model };
    vi.mocked(ctx.settings.get).mockImplementation(() => settings);
    vi.mocked(ctx.cpa.getModelCatalog).mockReturnValue([{ id: model, defaultReasoningEffort: "medium" }]);
    try {
      const id = await ctx.manager.start({ text: "first", attachments: [] }, process.cwd());
      settings.modelEfforts = { [model]: "max" };
      await ctx.manager.continue(id, { text: "second", attachments: [] });
      expect(appliedEfforts).toEqual(["medium", "max"]);
      expect(queryOptions).toHaveLength(2);
      expect(queryOptions[1].resume).toBe("sdk-effort");
      expect(ctx.manager.getTranscript(id).filter(item => item.kind === "text" && item.role === "user").map(item => item.kind === "text" ? item.text : "")).toEqual(["first", "second"]);
    } finally { ctx.manager.disposeAll(); }
  });

  it("keeps a query warm when its resolved effort is unchanged", async () => {
    const queryOptions: Record<string, unknown>[] = [];
    const ctx = makeDeps({ queryFn: args => {
      queryOptions.push(args.options);
      return (async function* () {
        for await (const _message of args.prompt as AsyncIterable<unknown>) yield { type: "result", subtype: "success", total_cost_usd: 0 };
      })();
    } });
    vi.mocked(ctx.cpa.getModelCatalog).mockReturnValue([{ id: baseSettings.defaultModel, defaultReasoningEffort: "medium" }]);
    try {
      const id = await ctx.manager.start({ text: "first", attachments: [] }, process.cwd());
      vi.mocked(ctx.settings.get).mockReturnValue({ ...baseSettings, modelEfforts: { [baseSettings.defaultModel]: "medium" } });
      await ctx.manager.continue(id, { text: "second", attachments: [] });
      expect(queryOptions).toHaveLength(1);
      expect(queryOptions[0].effort).toBe("medium");
    } finally { ctx.manager.disposeAll(); }
  });

  it("waits for an active turn before reopening with its next effort", async () => {
    let finishFirst!: () => void;
    const firstTurn = new Promise<void>(resolve => { finishFirst = resolve; });
    const queryOptions: Record<string, unknown>[] = [];
    let turns = 0;
    const ctx = makeDeps({ queryFn: args => {
      queryOptions.push(args.options);
      return (async function* () {
        for await (const _message of args.prompt as AsyncIterable<unknown>) {
          if (++turns === 1) await firstTurn;
          yield { type: "assistant", session_id: "sdk-effort", message: { content: [{ type: "text", text: "OK" }] } };
          yield { type: "result", subtype: "success", total_cost_usd: 0 };
        }
      })();
    } });
    const settings: AppSettings = { ...baseSettings, modelEfforts: { [baseSettings.defaultModel]: "medium" } };
    vi.mocked(ctx.settings.get).mockImplementation(() => settings);
    let id = "";
    try {
      const start = ctx.manager.start({ text: "first", attachments: [] }, process.cwd(), { onSessionId: value => { id = value; } });
      await vi.waitFor(() => expect(turns).toBe(1));
      settings.modelEfforts![baseSettings.defaultModel] = "max";
      const continuation = ctx.manager.continue(id, { text: "second", attachments: [] });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(queryOptions).toHaveLength(1);
      finishFirst();
      await Promise.all([start, continuation]);
      expect(queryOptions.map(options => options.effort)).toEqual(["medium", "max"]);
      expect(queryOptions[1].resume).toBe("sdk-effort");
    } finally { finishFirst(); ctx.manager.disposeAll(); }
  });

  it("cancels an effort-change wait without interrupting the active turn", async () => {
    let finishFirst!: () => void;
    const firstTurn = new Promise<void>(resolve => { finishFirst = resolve; });
    const queryOptions: Record<string, unknown>[] = [];
    let turns = 0;
    const ctx = makeDeps({ queryFn: args => {
      queryOptions.push(args.options);
      return (async function* () {
        for await (const _message of args.prompt as AsyncIterable<unknown>) {
          if (++turns === 1) await firstTurn;
          yield { type: "result", subtype: "success", total_cost_usd: 0 };
        }
      })();
    } });
    const settings: AppSettings = { ...baseSettings, modelEfforts: { [baseSettings.defaultModel]: "medium" } };
    vi.mocked(ctx.settings.get).mockImplementation(() => settings);
    let id = "";
    const controller = new AbortController();
    try {
      const start = ctx.manager.start({ text: "first", attachments: [] }, process.cwd(), { onSessionId: value => { id = value; } });
      await vi.waitFor(() => expect(turns).toBe(1));
      settings.modelEfforts![baseSettings.defaultModel] = "max";
      const continuation = ctx.manager.continue(id, { text: "cancelled second", attachments: [] }, { roomAbortSignal: controller.signal }).then(
        () => ({ status: "resolved" }), error => ({ status: "rejected", error: error.message }),
      );
      controller.abort(new Error("cancelled next effort"));
      const outcome = await Promise.race([continuation, new Promise(resolve => setTimeout(() => resolve({ status: "waiting" }), 75))]);
      expect(outcome).toEqual({ status: "rejected", error: "cancelled next effort" });
      expect(queryOptions).toHaveLength(1);
      expect((queryOptions[0].abortController as AbortController).signal.aborted).toBe(false);
      expect(ctx.manager.getSummary(id)?.status).toBe("running");
      expect(ctx.manager.getTranscript(id).filter(item => item.kind === "text" && item.role === "user")).toHaveLength(1);
      finishFirst();
      await Promise.all([start, continuation]);
    } finally { finishFirst(); ctx.manager.disposeAll(); }
  });

  it("start emits normalized events from mock query generator", async () => {
    const ctx = makeDeps();
    const sessionId = await ctx.manager.start({ text: "hello", attachments: [] }, "D:/proj");

    expect(sessionId).toBeTruthy();
    expect(ctx.ensureReady).toHaveBeenCalled();
    expect(ctx.emit).toHaveBeenCalled();
    expect(ctx.emitted.some((e) => e.type === "text_delta" && e.text === "Hi")).toBe(
      true,
    );
    expect(ctx.emitted.some((e) => e.type === "tool_start")).toBe(true);
    expect(ctx.manager.list().some((s) => s.id === sessionId)).toBe(true);
  });

  it("coalesces adjacent text deltas and keeps only the latest tool progress", async () => {
    const queryFn: QueryFn = async function* (args) {
      await takeFirstUserText(args.prompt);
      for (const text of ["a", "b", "c"]) {
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        };
      }
      for (const elapsed_time_seconds of [1, 2, 3]) {
        yield {
          type: "tool_progress",
          tool_use_id: "tool-1",
          tool_name: "Bash",
          elapsed_time_seconds,
        };
      }
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };
    const ctx = makeDeps({ queryFn });
    await ctx.manager.start({ text: "go", attachments: [] }, "D:/p");

    const deltas = ctx.emitted.filter((event) => event.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ text: "abc" });
    const progress = ctx.emitted.filter((event) => event.type === "tool_progress");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ elapsedSeconds: 3 });
  });

  it("closes the desktop MCP transport on the result even without an explicit release tool call", async () => {
    const close = vi.fn();
    const queryFn: QueryFn = args => {
      const gen = (async function* () {
        await takeFirstUserText(args.prompt);
        const hooks = args.options.hooks as { PreToolUse: { hooks: ((input: { tool_name: string }) => Promise<unknown>)[] }[] };
        await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: "mcp__my_desktop__click" });
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
        for await (const _ of args.prompt as AsyncIterable<unknown>) { }
      })();
      return Object.assign(gen, { close }) as never;
    };
    const ctx = makeDeps({ queryFn });
    vi.mocked(ctx.settings.get).mockReturnValue({ ...baseSettings, mcpServers: { my_desktop: { type: "windows-computer" } } });
    await ctx.manager.start({ text: "click", attachments: [] }, "D:/p");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([undefined, "extension", "cdp", "isolated"] as const)("releases attached browser control at turn completion (%s)", async connection => {
    const close = vi.fn();
    const queryFn: QueryFn = args => Object.assign((async function* () {
      await takeFirstUserText(args.prompt);
      const hooks = args.options.hooks as { PreToolUse: { hooks: ((input: { tool_name: string }) => Promise<unknown>)[] }[] };
      await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: "mcp__work_browser__browser_navigate" });
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
      for await (const _ of args.prompt as AsyncIterable<unknown>) { }
    })(), { close }) as never;
    const ctx = makeDeps({ queryFn });
    vi.mocked(ctx.settings.get).mockReturnValue({ ...baseSettings, mcpServers: {
      work_browser: { type: "playwright", browser: "chrome", connection,
        ...(connection === "cdp" ? { cdpEndpoint: "http://127.0.0.1:9222" } : {}) },
    } });
    const id = await ctx.manager.start({ text: "read the page", attachments: [] }, "D:/p");
    expect(close).toHaveBeenCalledTimes(connection === "isolated" ? 0 : 1);
    ctx.manager.closeSession(id);
  });

  it("closes an idle live query when its session is deleted", async () => {
    const close = vi.fn();
    const queryFn: QueryFn = (args) => {
      const gen = (async function* () {
        await takeFirstUserText(args.prompt);
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
        for await (const _ of args.prompt as AsyncIterable<unknown>) {
          // Keep the streaming query warm across turns.
        }
      })();
      return Object.assign(gen, { close }) as never;
    };
    const ctx = makeDeps({ queryFn });
    const sessionId = await ctx.manager.start(
      { text: "go", attachments: [] },
      "D:/p",
    );

    expect(ctx.manager.delete(sessionId)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps at most two warm SDK queries", async () => {
    const closes = [vi.fn(), vi.fn(), vi.fn()];
    let opened = 0;
    const queryFn: QueryFn = (args) => {
      const close = closes[opened++];
      const gen = (async function* () {
        await takeFirstUserText(args.prompt);
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
        for await (const _ of args.prompt as AsyncIterable<unknown>) {
          // Keep the streaming query warm across turns.
        }
      })();
      return Object.assign(gen, { close }) as never;
    };
    const ctx = makeDeps({ queryFn });
    for (let i = 0; i < 3; i += 1) {
      await ctx.manager.start(
        { text: `go-${i}`, attachments: [] },
        "D:/p",
      );
    }

    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).not.toHaveBeenCalled();
    expect(closes[2]).not.toHaveBeenCalled();
    ctx.manager.disposeAll();
  });

  it("collapses transcript persistence into one delayed write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-save-batch-"));
    const archive = new SessionArchive(dir);
    const saveItems = vi.spyOn(archive, "saveItems");
    const ctx = makeDeps();
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });

    await manager.start({ text: "go", attachments: [] }, "D:/p");
    expect(saveItems).not.toHaveBeenCalled();
    manager.flushPendingPersistence();
    expect(saveItems).toHaveBeenCalledTimes(1);
    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes expected options to queryFn", async () => {
    const captured: Array<{
      prompt: string | AsyncIterable<unknown>;
      options: Record<string, unknown>;
    }> = [];
    const queryFn: QueryFn = async function* (args) {
      captured.push(args);
      const text = await takeFirstUserText(args.prompt);
      expect(text).toBe("prompt-1");
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };

    const ctx = makeDeps({ queryFn });
    const sessionId = await ctx.manager.start({ text: "prompt-1", attachments: [] }, "D:/work");

    expect(captured).toHaveLength(1);
    // Streaming mode: prompt is AsyncIterable, not a raw string
    expect(typeof captured[0].prompt !== "string").toBe(true);
    const opts = captured[0].options;
    expect(opts.cwd).toBe("D:/work");
    expect(opts.includePartialMessages).toBe(true);
    expect(opts.permissionMode).toBe("default");
    // tools = full Claude Code preset (availability); allowedTools = auto-allow
    // (read-only + TodoWrite) so canUseTool still gates writes
    expect(opts.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(opts.allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
    ]);
    // CLAUDE.md hierarchy auto-loaded into the system prompt
    expect(opts.settingSources).toEqual(["user", "project", "local"]);
    const failureHooks = (opts.hooks as { PostToolUseFailure: Array<{ hooks: Array<typeof fileEditRecovery> }> }).PostToolUseFailure;
    const recovery = await failureHooks[0].hooks[0]({ tool_name: "Edit" });
    expect(recovery.hookSpecificOutput?.additionalContext).toContain("AskUserQuestion");
    expect(opts.env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
    });
    expect(typeof opts.canUseTool).toBe("function");
    expect(opts.abortController).toBeInstanceOf(AbortController);
    expect(ctx.buildProcessEnv).toHaveBeenCalledWith("kimi-for-coding");
    expect(sessionId).toBeTruthy();
  });

  it("wires canUseTool to permissionBroker with sessionId", async () => {
    const canUseTool = vi
      .fn()
      .mockResolvedValue({ behavior: "allow", updatedInput: { file_path: "a" } });
    let passedCanUseTool:
      | ((name: string, input: Record<string, unknown>, opts: { signal: AbortSignal }) => Promise<unknown>)
      | undefined;

    const queryFn: QueryFn = async function* (args) {
      passedCanUseTool = args.options.canUseTool as typeof passedCanUseTool;
      await takeFirstUserText(args.prompt);
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };

    const ctx = makeDeps({ queryFn, canUseTool });
    const sessionId = await ctx.manager.start({ text: "hi", attachments: [] }, "D:/p");

    expect(passedCanUseTool).toBeTypeOf("function");
    const request = new AbortController();
    await passedCanUseTool!("Read", { file_path: "a" }, { signal: request.signal });
    expect(canUseTool).toHaveBeenCalledWith("Read", { file_path: "a" }, sessionId, expect.any(AbortSignal));
    request.abort();
    expect(canUseTool.mock.calls[0]![3].aborted).toBe(true);
  });

  it("tracks Edit/Write via diffTracker and emitDiff", async () => {
    const changes: FileChange[] = [
      {
        path: "src/a.ts",
        status: "M",
        hunks: "+b",
        updatedAt: 1,
        events: [{ id: "ev-1", tool: "Edit", at: 1, hunk: "+b" }],
      },
    ];
    const onToolUse = vi.fn();
    const listDiffs = vi.fn().mockReturnValue(changes);
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    let markToolResultConsumed!: () => void;
    const toolResultConsumed = new Promise<void>((resolve) => {
      markToolResultConsumed = resolve;
    });

    const queryFn: QueryFn = async function* (args) {
      await takeFirstUserText(args.prompt);
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "e1",
              name: "Edit",
              input: {
                file_path: "src/a.ts",
                old_string: "a",
                new_string: "b",
              },
            },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "e1", name: "Edit", content: "ok" },
          ],
        },
      };
      // Keep the turn open after the tool result so the test can prove there
      // is no intermediate Git scan or renderer diff update.
      markToolResultConsumed();
      await resultGate;
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };

    const ctx = makeDeps({ queryFn, onToolUse, listDiffs });
    const started = ctx.manager.start(
      { text: "edit please", attachments: [] },
      "D:/p",
    );
    await toolResultConsumed;
    expect(ctx.diffTracker.refreshBashWritesFromDisk).not.toHaveBeenCalled();
    expect(ctx.emitDiff).not.toHaveBeenCalled();

    releaseResult();
    const sessionId = await started;

    expect(onToolUse).toHaveBeenCalledWith(
      sessionId,
      "Edit",
      expect.objectContaining({ file_path: "src/a.ts" }),
      expect.objectContaining({ cwd: "D:/p" }),
    );
    expect(ctx.diffTracker.refreshBashWritesFromDisk).toHaveBeenCalledTimes(1);
    expect(ctx.emitDiff).toHaveBeenCalledWith(sessionId, changes);
    expect(ctx.emitDiff).toHaveBeenCalledTimes(1);
  });

  it("emits a persisted file summary only for changes added in this turn", async () => {
    const previous: FileChange = {
      path: "D:/p/src/old.ts",
      status: "M",
      hunks: "@@ -1,1 +1,1 @@\n-old\n+older",
      updatedAt: 1,
      events: [
        {
          id: "ev-old",
          tool: "Edit",
          at: 1,
          hunk: "@@ -1,1 +1,1 @@\n-old\n+older",
        },
      ],
    };
    const current: FileChange[] = [
      previous,
      {
        path: "D:/p/src/a.ts",
        status: "M",
        hunks: "@@ -11,2 +11,3 @@\n-old\n+new\n+extra\n keep",
        updatedAt: 2,
        events: [
          {
            id: "ev-new",
            tool: "Edit",
            at: 2,
            hunk: "@@ -11,2 +11,3 @@\n-old\n+new\n+extra\n keep",
          },
        ],
      },
    ];
    const listDiffs = vi
      .fn()
      .mockReturnValueOnce([previous])
      .mockReturnValue(current);
    const queryFn: QueryFn = async function* (args) {
      await takeFirstUserText(args.prompt);
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-edit",
              name: "Edit",
              input: {
                file_path: "D:/p/src/a.ts",
                old_string: "old",
                new_string: "new\nextra",
              },
            },
          ],
        },
      };
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };

    const ctx = makeDeps({ queryFn, listDiffs });
    const sessionId = await ctx.manager.start(
      { text: "edit", attachments: [] },
      "D:/p",
    );

    expect(
      ctx.emitted.find((event) => event.type === "turn_changes"),
    ).toEqual({
      type: "turn_changes",
      sessionId,
      item: {
        kind: "changes",
        id: expect.stringContaining("changes-"),
        files: [
          {
            path: "D:/p/src/a.ts",
            additions: 2,
            deletions: 1,
            line: 11,
            eventIds: ["ev-new"],
          },
        ],
      },
    });
  });

  it("emits a per-turn file-changes card and does not repeat earlier files", async () => {
    const byPath = new Map<string, FileChange>();
    let seq = 0;
    const onToolUse = vi.fn(
      (_sessionId: string, name: string, input: Record<string, unknown>) => {
        const filePath = String(input.file_path ?? "");
        seq += 1;
        const hunk = [
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@ -12,1 +12,2 @@",
          "-old",
          "+new",
          "+extra",
        ].join("\n");
        const event = {
          id: `ev-${seq}`,
          tool: name === "Write" ? ("Write" as const) : ("Edit" as const),
          at: seq,
          hunk,
        };
        const existing = byPath.get(filePath);
        if (existing) {
          existing.events = [...existing.events, event];
          existing.hunks = hunk;
          existing.updatedAt = seq;
        } else {
          byPath.set(filePath, {
            path: filePath,
            status: "M",
            hunks: hunk,
            updatedAt: seq,
            events: [event],
          });
        }
      },
    );
    const listDiffs = vi.fn(() => [...byPath.values()]);
    const queryFn: QueryFn = async function* (args) {
      for await (const msg of args.prompt as AsyncIterable<unknown>) {
        const text = userTextFromPrompt(msg);
        if (!text) continue;
        const filePath = text.includes("second") ? "src/b.ts" : "src/a.ts";
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: filePath,
                name: "Edit",
                input: {
                  file_path: filePath,
                  old_string: "old",
                  new_string: "new\nextra",
                },
              },
            ],
          },
        };
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      }
    };

    const ctx = makeDeps({ queryFn, onToolUse, listDiffs });
    const sessionId = await ctx.manager.start(
      { text: "first", attachments: [] },
      "D:/p",
    );
    const first = ctx.emitted.filter((event) => event.type === "turn_changes");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: "turn_changes",
      item: {
        kind: "changes",
        files: [{ path: "src/a.ts", additions: 2, deletions: 1, line: 12 }],
      },
    });

    await ctx.manager.continue(sessionId, {
      text: "second",
      attachments: [],
    });
    const all = ctx.emitted.filter((event) => event.type === "turn_changes");
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      type: "turn_changes",
      item: {
        kind: "changes",
        files: [{ path: "src/b.ts", additions: 2, deletions: 1, line: 12 }],
      },
    });
  });

  it("summarizes only this turn's events when the same file is edited again", async () => {
    const byPath = new Map<string, FileChange>();
    let seq = 0;
    const onToolUse = vi.fn(
      (_sessionId: string, _name: string, input: Record<string, unknown>) => {
        const filePath = String(input.file_path ?? "");
        seq += 1;
        const hunk =
          seq === 1
            ? [
                "--- a/src/a.ts",
                "+++ b/src/a.ts",
                "@@ -12,1 +12,2 @@",
                "-old",
                "+new",
                "+extra",
              ].join("\n")
            : [
                "--- a/src/a.ts",
                "+++ b/src/a.ts",
                "@@ -80,0 +80,1 @@",
                "+only",
              ].join("\n");
        const event = {
          id: `ev-${seq}`,
          tool: "Edit" as const,
          at: seq,
          hunk,
        };
        const existing = byPath.get(filePath);
        if (existing) {
          existing.events = [...existing.events, event];
          existing.hunks = hunk;
          existing.updatedAt = seq;
        } else {
          byPath.set(filePath, {
            path: filePath,
            status: "M",
            hunks: hunk,
            updatedAt: seq,
            events: [event],
          });
        }
      },
    );
    const listDiffs = vi.fn(() => [...byPath.values()]);
    const queryFn: QueryFn = async function* (args) {
      for await (const msg of args.prompt as AsyncIterable<unknown>) {
        if (!userTextFromPrompt(msg)) continue;
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: `e-${seq + 1}`,
                name: "Edit",
                input: {
                  file_path: "src/a.ts",
                  old_string: "a",
                  new_string: "b",
                },
              },
            ],
          },
        };
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      }
    };

    const ctx = makeDeps({ queryFn, onToolUse, listDiffs });
    const sessionId = await ctx.manager.start(
      { text: "first", attachments: [] },
      "D:/p",
    );
    await ctx.manager.continue(sessionId, {
      text: "again",
      attachments: [],
    });
    const cards = ctx.emitted.filter((event) => event.type === "turn_changes");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      item: { files: [{ path: "src/a.ts", additions: 2, deletions: 1, line: 12 }] },
    });
    expect(cards[1]).toMatchObject({
      item: { files: [{ path: "src/a.ts", additions: 1, deletions: 0, line: 80 }] },
    });
  });

  it("real tracker omits earlier dirty files from a later turn card", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-card-"));
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      fs.writeFileSync(path.join(root, "legacy.ts"), "old work\n", "utf8");
      const tracker = new DiffTracker({
        readFile: (p) => fs.readFileSync(p, "utf8"),
      });
      const queryFn: QueryFn = async function* (args) {
        for await (const msg of args.prompt as AsyncIterable<unknown>) {
          const text = userTextFromPrompt(msg);
          if (!text) continue;
          const fileName = text.includes("second") ? "other.ts" : "fresh.ts";
          const abs = path.join(root, fileName);
          fs.writeFileSync(abs, `${fileName}\n`, "utf8");
          yield {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: fileName,
                  name: "Write",
                  input: { file_path: abs, content: `${fileName}\n` },
                },
              ],
            },
          };
          yield { type: "result", subtype: "success", total_cost_usd: 0 };
        }
      };
      const ctx = makeDeps({ queryFn, diffTracker: tracker });
      const sessionId = await ctx.manager.start(
        { text: "first", attachments: [] },
        root,
      );
      await ctx.manager.continue(sessionId, {
        text: "second",
        attachments: [],
      });
      const cards = ctx.emitted.filter((event) => event.type === "turn_changes");
      expect(cards).toHaveLength(2);
      const names = (event: SdkNormalizedEvent) =>
        event.type === "turn_changes"
          ? event.item.files.map((file) => path.basename(file.path))
          : [];
      expect(names(cards[0]!)).toEqual(["fresh.ts"]);
      expect(names(cards[1]!)).toEqual(["other.ts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("continue reuses streaming session (single queryFn open)", async () => {
    const openCount = { n: 0 };
    const texts: string[] = [];
    const queryFn: QueryFn = async function* (args) {
      openCount.n += 1;
      // Keep consuming user messages from the stream for each turn
      if (typeof args.prompt === "string") {
        texts.push(args.prompt);
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
        return;
      }
      for await (const msg of args.prompt) {
        if (
          typeof msg === "object" &&
          msg !== null &&
          (msg as { type?: string }).type === "user"
        ) {
          const content = (msg as { message?: { content?: string } }).message
            ?.content;
          if (typeof content === "string") texts.push(content);
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "ok" },
            },
          };
          yield { type: "result", subtype: "success", total_cost_usd: 0 };
          // Stay open for next push — don't return until stream ends
        }
      }
    };

    const ctx = makeDeps({ queryFn });
    const sessionId = await ctx.manager.start({ text: "first", attachments: [] }, "D:/p");
    await ctx.manager.continue(sessionId, { text: "second", attachments: [] });

    expect(openCount.n).toBe(1);
    expect(texts).toEqual(["first", "second"]);
    expect(ctx.manager.list()[0]?.status).toBe("idle");
  });

  it.each([false, true])("abort persists cancellation/interruption and ignores late success (activity: %s)", async activity => {
    let controller: AbortController | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queryFn: QueryFn = async function* (args) {
      controller = args.options.abortController as AbortController;
      await takeFirstUserText(args.prompt);
      if (activity) yield { type: "assistant", message: { content: [{ type: "tool_use", id: "pending-read", name: "Read", input: { file_path: "a" } }] } };
      await gate;
      // After abort/release, end the turn so waitForTurnIdle unblocks
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-outcome-"));
    const archive = new SessionArchive(dir);
    const ctx = makeDeps({ queryFn, archive });
    const startPromise = ctx.manager.start({ text: "slow", attachments: [] }, "D:/p");

    // allow start to reach queryFn
    await vi.waitFor(() => {
      expect(controller).toBeDefined();
      if (activity) expect(ctx.emitted.some(event => event.type === "tool_start")).toBe(true);
    });

    const id = ctx.manager.list()[0]?.id;
    expect(id).toBeTruthy();
    ctx.manager.abort(id!);
    expect(controller!.signal.aborted).toBe(true);
    release();
    await startPromise;
    ctx.manager.flushPendingPersistence();
    const saved = archive.loadItems(id!);
    expect(saved.find(item => item.kind === "text" && item.role === "user")).toMatchObject({ turnOutcome: activity ? "interrupted" : "cancelled" });
    if (activity) expect(saved.find(item => item.kind === "tool")).toMatchObject({ tool: { status: "stopped" } });
    expect(ctx.emitted).toContainEqual(expect.objectContaining({ type: "result", ok: false, outcome: "interrupted" }));
    ctx.manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws and emits result error when CPA ensureReady fails", async () => {
    const ensureReady = vi.fn().mockResolvedValue({
      state: "error",
      message: "CPA did not become ready",
    });
    const queryFn = vi.fn(async function* () {
      yield { type: "result" };
    });

    const ctx = makeDeps({ ensureReady, queryFn: queryFn as unknown as QueryFn });

    await expect(ctx.manager.start({ text: "hi", attachments: [] }, "D:/p")).rejects.toThrow(/CPA/i);
    expect(queryFn).not.toHaveBeenCalled();
    expect(
      ctx.emitted.some(
        (e) => e.type === "result" && e.ok === false && String(e.error).includes("CPA"),
      ),
    ).toBe(true);
  });

  it("list returns session summaries", async () => {
    const ctx = makeDeps({
      queryFn: async function* () {
        /* empty */
      },
    });
    const id = await ctx.manager.start({ text: "title prompt", attachments: [] }, "D:/proj");
    const list = ctx.manager.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      cwd: "D:/proj",
      status: "idle",
    });
    expect(list[0].title.length).toBeGreaterThan(0);
  });

  it("humanizeAgentError explains image_url rejection", () => {
    const raw =
      "Failed to deserialize the JSON body into the target type: messages[14]: unknown variant `image_url`, expected `text`";
    const msg = humanizeAgentError(raw, "deepseek-v4-flash");
    expect(msg).toContain("deepseek-v4-flash");
    expect(msg).toMatch(/does not accept image content/i);
    expect(msg).toMatch(/new chat|vision-capable/i);
  });

  it("passes strictMcpConfig and configured mcpServers to queryFn", async () => {
    const captured: Array<{ options: Record<string, unknown> }> = [];
    const queryFn: QueryFn = async function* (args) {
      captured.push({ options: args.options });
      await takeFirstUserText(args.prompt);
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };
    const ctx = makeDeps({ queryFn });
    (ctx.settings.get as ReturnType<typeof vi.fn>).mockReturnValue({
      ...baseSettings,
      mcpServers: { fs: { command: "node", args: ["srv.js"] } },
    });
    await ctx.manager.start({ text: "hi", attachments: [] }, "D:/p");
    expect(captured[0]?.options.strictMcpConfig).toBe(true);
    expect(captured[0]?.options.mcpServers).toEqual({
      fs: { command: "node", args: ["srv.js"] },
    });
  });

  it.each(["balanced", "standard"] as const)("applies the %s SDK shell budget and browser result policy", async (mode) => {
    let captured: Record<string, unknown> = {};
    const ctx = makeDeps({ queryFn: async function* (args) {
      captured = args.options;
      await takeFirstUserText(args.prompt);
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    } });
    vi.mocked(ctx.settings.get).mockReturnValue({
      ...baseSettings, tokenSavings: { mode },
      mcpServers: { browser: { type: "playwright", browser: "chrome", connection: "isolated" } },
    });
    await ctx.manager.start({ text: "fixture", attachments: [] }, "D:/p");
    expect(captured.settings).toEqual(mode === "balanced" ? { bashOutputMaxChars: 16000 } : undefined);
    const hooks = captured.hooks as Record<string, unknown>;
    const servers = captured.mcpServers as Record<string, unknown>;
    if (mode === "balanced") {
      expect(servers["agentos-results"]).toMatchObject({ type: "sdk" });
      expect(hooks.PostToolUse).toHaveLength(1);
      // Name-based auto-approve would outlive a dynamically replaced server.
      expect(captured.allowedTools).not.toContain("mcp__agentos-results__result_read");
    } else {
      expect(servers["agentos-results"]).toBeUndefined();
      expect(hooks.PostToolUse).toBeUndefined();
    }
    ctx.manager.disposeAll();
  });

  it.each([
    { hiddenFromList: true }, { pathJail: "D:/p" }, { roomAbortSignal: new AbortController().signal },
    { roomReadOnly: true }, { extraMcpServers: { browser: { command: "fixture-server" } } },
    { extraMcpServers: { "agentos-results": { command: "user-reader" } } },
  ])("keeps outputs exact without a personal, host-owned browser and reader binding", async (opts) => {
    let captured: Record<string, unknown> = {};
    const ctx = makeDeps({ queryFn: async function* (args) {
      captured = args.options;
      await takeFirstUserText(args.prompt);
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    } });
    vi.mocked(ctx.settings.get).mockReturnValue({ ...baseSettings, mcpServers: {
      browser: { type: "playwright", browser: "chrome", connection: "isolated" },
    } });
    await ctx.manager.start({ text: "fixture", attachments: [] }, "D:/p", opts);
    if (opts.pathJail) expect(captured.settings).toBeUndefined();
    expect((captured.hooks as Record<string, unknown>).PostToolUse).toBeUndefined();
    expect((captured.mcpServers as Record<string, unknown>)?.["agentos-results"]).toEqual(opts.extraMcpServers?.["agentos-results"]);
    ctx.manager.disposeAll();
  });

  it("mcp control requests route to the live query handle", async () => {
    const control = {
      mcpServerStatus: vi.fn().mockResolvedValue([
        {
          name: "fs",
          status: "connected",
          serverInfo: { name: "fs", version: "1.0" },
          tools: [{ name: "read_file" }],
        },
      ]),
      reconnectMcpServer: vi.fn().mockResolvedValue(undefined),
      toggleMcpServer: vi.fn().mockResolvedValue(undefined),
      setMcpServers: vi
        .fn()
        .mockResolvedValue({ added: ["fs"], removed: [], errors: {} }),
    };
    const queryFn: QueryFn = function (args) {
      const gen = (async function* () {
        await takeFirstUserText(args.prompt);
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      })();
      return Object.assign(gen, control) as never;
    };
    const ctx = makeDeps({ queryFn });
    const settingsUpdate = vi.fn();
    (ctx.settings as unknown as { update: unknown }).update = settingsUpdate;
    const sessionId = await ctx.manager.start(
      { text: "hi", attachments: [] },
      "D:/p",
    );

    const statuses = await ctx.manager.getMcpStatus(sessionId);
    expect(statuses?.[0]).toMatchObject({
      name: "fs",
      status: "connected",
      serverInfo: { name: "fs", version: "1.0" },
    });
    expect(statuses?.[0]?.tools).toHaveLength(1);

    expect(await ctx.manager.reconnectMcpServer(sessionId, "fs")).toEqual({
      ok: true,
    });
    expect(control.reconnectMcpServer).toHaveBeenCalledWith("fs");

    expect(await ctx.manager.toggleMcpServer(sessionId, "fs", false)).toEqual({
      ok: true,
    });
    expect(control.toggleMcpServer).toHaveBeenCalledWith("fs", false);

    const servers = { fs: { command: "node" } };
    const setRes = await ctx.manager.setMcpServers(sessionId, servers);
    expect(setRes.ok).toBe(true);
    expect(setRes.result).toEqual({ added: ["fs"], removed: [], errors: {} });
    expect(control.setMcpServers).toHaveBeenCalledWith(servers);
    // persisted to settings
    expect(settingsUpdate).toHaveBeenCalledWith({ mcpServers: servers });
  });

  it("mcp control requests fail gracefully without a live query", async () => {
    const ctx = makeDeps({
      queryFn: async function* () {
        /* no control methods attached */
      },
    });
    const sessionId = await ctx.manager.start(
      { text: "hi", attachments: [] },
      "D:/p",
    );
    expect(await ctx.manager.getMcpStatus(sessionId)).toBeNull();
    expect(await ctx.manager.reconnectMcpServer(sessionId, "fs")).toMatchObject(
      { ok: false },
    );
    expect(
      await ctx.manager.toggleMcpServer(sessionId, "fs", true),
    ).toMatchObject({ ok: false });
    expect(await ctx.manager.setMcpServers(sessionId, {})).toMatchObject({
      ok: false,
    });
  });

  it("probeMcpServers spawns a throwaway query with strict config", async () => {
    const captured: Array<{
      prompt: unknown;
      options: Record<string, unknown>;
    }> = [];
    const control = {
      mcpServerStatus: vi.fn().mockResolvedValue([
        { name: "api", status: "connected", tools: [{ name: "ping" }] },
      ]),
      close: vi.fn(),
    };
    const queryFn: QueryFn = function (args) {
      captured.push({ prompt: args.prompt, options: args.options });
      const gen = (async function* () {
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      })();
      return Object.assign(gen, control) as never;
    };
    const ctx = makeDeps({ queryFn });
    const statuses = await ctx.manager.probeMcpServers({
      api: { type: "http", url: "https://x.test/mcp" },
    });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ name: "api", status: "connected" });
    expect(captured[0]?.options.strictMcpConfig).toBe(true);
    expect(captured[0]?.options.mcpServers).toEqual({
      api: { type: "http", url: "https://x.test/mcp" },
    });
    expect(captured[0]?.options.permissionMode).toBe("bypassPermissions");
    expect(control.close).toHaveBeenCalled();
  });

  it("restoreChangeEvent rolls back one operation and truncates later events", async () => {
    const ctx = makeDeps();
    const change = {
      path: "demo.txt",
      status: "M" as const,
      hunks: "h3",
      updatedAt: 3,
      events: [
        { id: "ev-1", tool: "Write" as const, at: 1, hunk: "h1" },
        { id: "ev-2", tool: "Edit" as const, at: 2, hunk: "h2" },
        { id: "ev-3", tool: "Edit" as const, at: 3, hunk: "h3" },
      ],
    };
    const snapshots = {
      has: vi.fn().mockReturnValue(true),
      pathOf: vi.fn().mockReturnValue("demo.txt"),
      restore: vi.fn().mockReturnValue(true),
      list: vi.fn().mockReturnValue(["ev-1", "ev-2", "ev-3"]),
      drop: vi.fn(),
      dropAll: vi.fn(),
    };
    (ctx.manager as unknown as { snapshots: unknown }).snapshots = snapshots;
    (ctx.diffTracker.findByEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      path: "demo.txt",
      change,
    });
    const sessionId = await ctx.manager.start(
      { text: "hi", attachments: [] },
      "D:/p",
    );

    // Roll back the SECOND op: file returns to after-op1 content, and
    // ev-2 + ev-3 events/snapshots are dropped.
    const res = ctx.manager.restoreChangeEvent(sessionId, "ev-2");
    expect(res).toEqual({ ok: true });
    expect(snapshots.restore).toHaveBeenCalledWith(sessionId, "ev-2");
    expect(snapshots.drop).toHaveBeenCalledWith(sessionId, "ev-2");
    expect(snapshots.drop).toHaveBeenCalledWith(sessionId, "ev-3");
    expect(snapshots.drop).not.toHaveBeenCalledWith(sessionId, "ev-1");
    expect(ctx.diffTracker.truncateAt).toHaveBeenCalledWith(
      sessionId,
      "demo.txt",
      "ev-2",
    );
    expect(ctx.emitDiff).toHaveBeenCalled();
  });

  it("restoreChangeEvent fails cleanly without a snapshot or event", async () => {
    const ctx = makeDeps();
    const snapshots = {
      has: vi.fn().mockReturnValue(false),
      pathOf: vi.fn().mockReturnValue(null),
      restore: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      drop: vi.fn(),
      dropAll: vi.fn(),
    };
    (ctx.manager as unknown as { snapshots: unknown }).snapshots = snapshots;
    const sessionId = await ctx.manager.start(
      { text: "hi", attachments: [] },
      "D:/p",
    );
    const res = ctx.manager.restoreChangeEvent(sessionId, "ev-x");
    expect(res.ok).toBe(false);
    expect(snapshots.restore).not.toHaveBeenCalled();
  });

  it("restoreTurnChanges restores only the latest task suffix", async () => {
    const change: FileChange = {
      path: "demo.txt",
      status: "M",
      hunks: "task-2",
      updatedAt: 3,
      events: [
        { id: "ev-old", tool: "Edit", at: 1, hunk: "old" },
        { id: "ev-task-1", tool: "Edit", at: 2, hunk: "task-1" },
        { id: "ev-task-2", tool: "Edit", at: 3, hunk: "task-2" },
      ],
    };
    const ctx = makeDeps({ listDiffs: vi.fn().mockReturnValue([change]) });
    const snapshots = {
      has: vi.fn().mockReturnValue(true),
      pathOf: vi.fn(),
      restore: vi.fn().mockReturnValue(true),
      list: vi.fn(),
      drop: vi.fn(),
      dropAll: vi.fn(),
    };
    (ctx.manager as unknown as { snapshots: unknown }).snapshots = snapshots;
    const sessionId = await ctx.manager.start(
      { text: "hi", attachments: [] },
      "D:/p",
    );

    const result = ctx.manager.restoreTurnChanges(sessionId, [
      { path: "demo.txt", eventIds: ["ev-task-1", "ev-task-2"] },
    ]);

    expect(result).toEqual({ restored: ["demo.txt"], failed: [] });
    expect(snapshots.restore).toHaveBeenCalledWith(sessionId, "ev-task-1");
    expect(snapshots.drop).toHaveBeenCalledWith(sessionId, "ev-task-1");
    expect(snapshots.drop).toHaveBeenCalledWith(sessionId, "ev-task-2");
    expect(snapshots.drop).not.toHaveBeenCalledWith(sessionId, "ev-old");
    expect(ctx.diffTracker.truncateAt).toHaveBeenCalledWith(
      sessionId,
      "demo.txt",
      "ev-task-1",
    );
  });

  it("restoreTurnChanges rejects an older task when later edits exist", async () => {
    const change: FileChange = {
      path: "demo.txt",
      status: "M",
      hunks: "newer",
      updatedAt: 3,
      events: [
        { id: "ev-old-task", tool: "Edit", at: 1, hunk: "old task" },
        { id: "ev-new-task", tool: "Edit", at: 2, hunk: "new task" },
      ],
    };
    const ctx = makeDeps({ listDiffs: vi.fn().mockReturnValue([change]) });
    const snapshots = {
      has: vi.fn().mockReturnValue(true),
      pathOf: vi.fn(),
      restore: vi.fn().mockReturnValue(true),
      list: vi.fn(),
      drop: vi.fn(),
      dropAll: vi.fn(),
    };
    (ctx.manager as unknown as { snapshots: unknown }).snapshots = snapshots;
    const sessionId = await ctx.manager.start(
      { text: "hi", attachments: [] },
      "D:/p",
    );

    const result = ctx.manager.restoreTurnChanges(sessionId, [
      { path: "demo.txt", eventIds: ["ev-old-task"] },
    ]);

    expect(result.restored).toEqual([]);
    expect(result.failed).toEqual(["demo.txt"]);
    expect(result.error).toMatch(/no files were changed/i);
    expect(snapshots.restore).not.toHaveBeenCalled();
    expect(ctx.diffTracker.truncateAt).not.toHaveBeenCalled();
  });

  it("tracks SDK user message uuids and emits user_msg_ids", async () => {
    const queryFn: QueryFn = async function* (args) {
      await takeFirstUserText(args.prompt);
      // SDK replay of the persisted user turn (has uuid, no tool_result).
      yield {
        type: "user",
        uuid: "u-1",
        session_id: "sdk-1",
        message: { role: "user", content: "hello" },
      };
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };
    const ctx = makeDeps({ queryFn });
    const sessionId = await ctx.manager.start(
      { text: "hello", attachments: [] },
      "D:/p",
    );
    const evt = ctx.emitted.find((e) => e.type === "user_msg_ids");
    expect(evt).toBeTruthy();
    expect(evt && "uuids" in evt ? evt.uuids : []).toEqual(["u-1"]);

    // tool_result frames must NOT be tracked as user turns
    void sessionId;
  });

  it("does not track tool_result user frames as rewind anchors", async () => {
    const queryFn: QueryFn = async function* (args) {
      await takeFirstUserText(args.prompt);
      yield {
        type: "user",
        uuid: "tr-1",
        session_id: "sdk-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
        },
      };
      yield {
        type: "user",
        uuid: "u-2",
        session_id: "sdk-1",
        isSynthetic: true,
        message: { role: "user", content: "synthetic" },
      };
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };
    const ctx = makeDeps({ queryFn });
    await ctx.manager.start({ text: "hi", attachments: [] }, "D:/p");
    expect(ctx.emitted.some((e) => e.type === "user_msg_ids")).toBe(false);
  });

  it("rewindToUserMessage uses the live query and sets a resume anchor", async () => {
    const rewindFiles = vi.fn().mockResolvedValue({
      canRewind: true,
      filesChanged: ["demo.txt"],
      insertions: 1,
      deletions: 2,
    });
    const close = vi.fn();
    const queryFn: QueryFn = function (args) {
      const gen = (async function* () {
        await takeFirstUserText(args.prompt);
        yield {
          type: "user",
          uuid: "u-1",
          session_id: "sdk-1",
          message: { role: "user", content: "first" },
        };
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
        // Stay open for further pushes until closed
        for await (const _ of args.prompt as AsyncIterable<unknown>) {
          yield { type: "result", subtype: "success", total_cost_usd: 0 };
        }
      })();
      return Object.assign(gen, { rewindFiles, close }) as never;
    };
    const ctx = makeDeps({ queryFn });
    const sessionId = await ctx.manager.start(
      { text: "first", attachments: [] },
      "D:/p",
    );

    const res = await ctx.manager.rewindToUserMessage(sessionId, "u-1");
    expect(res.ok).toBe(true);
    expect(res.filesChanged).toEqual(["demo.txt"]);
    expect(rewindFiles).toHaveBeenCalledWith("u-1", { dryRun: false });

    // Next continue must open a NEW query with resume + resumeSessionAt.
    const captured: Array<Record<string, unknown>> = [];
    const queryFn2: QueryFn = function (args) {
      captured.push(args.options);
      const gen = (async function* () {
        await takeFirstUserText(args.prompt);
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      })();
      return Object.assign(gen, {}) as never;
    };
    (ctx.manager as unknown as { queryFn: QueryFn }).queryFn = queryFn2;
    await ctx.manager.continue(sessionId, { text: "again", attachments: [] });
    expect(captured[0]?.resume).toBe("sdk-1");
    expect(captured[0]?.resumeSessionAt).toBe("u-1");
  });

  it("rewindToUserMessage reports canRewind=false without tearing down", async () => {
    const rewindFiles = vi
      .fn()
      .mockResolvedValue({ canRewind: false, error: "no checkpoint" });
    const queryFn: QueryFn = function (args) {
      const gen = (async function* () {
        await takeFirstUserText(args.prompt);
        yield {
          type: "result",
          subtype: "success",
          total_cost_usd: 0,
          session_id: "sdk-1",
        };
        for await (const _ of args.prompt as AsyncIterable<unknown>) {
          yield { type: "result", subtype: "success", total_cost_usd: 0 };
        }
      })();
      return Object.assign(gen, { rewindFiles }) as never;
    };
    const ctx = makeDeps({ queryFn });
    const sessionId = await ctx.manager.start(
      { text: "hi", attachments: [] },
      "D:/p",
    );
    const res = await ctx.manager.rewindToUserMessage(sessionId, "u-x");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no checkpoint/);
    // Stream still usable: continue pushes to the same query.
    await ctx.manager.continue(sessionId, { text: "next", attachments: [] });
  });

  it("restoreAllChanges restores each file's earliest op snapshot", async () => {
    const ctx = makeDeps();
    (ctx.listDiffs as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        path: "a.ts",
        status: "M",
        hunks: "h2",
        updatedAt: 2,
        events: [
          { id: "ev-a1", tool: "Write", at: 1, hunk: "h1" },
          { id: "ev-a2", tool: "Edit", at: 2, hunk: "h2" },
        ],
      },
      {
        path: "b.ts",
        status: "M",
        hunks: "hb",
        updatedAt: 3,
        events: [{ id: "ev-b1", tool: "Edit", at: 3, hunk: "hb" }],
      },
    ]);
    const snapshots = {
      has: vi.fn().mockReturnValue(true),
      pathOf: vi.fn(),
      restore: vi.fn().mockReturnValue(true),
      list: vi.fn(),
      drop: vi.fn(),
      dropAll: vi.fn(),
    };
    (ctx.manager as unknown as { snapshots: unknown }).snapshots = snapshots;
    const sessionId = await ctx.manager.start(
      { text: "hi", attachments: [] },
      "D:/p",
    );
    const res = ctx.manager.restoreAllChanges(sessionId);
    expect(res.failed).toEqual([]);
    expect(res.restored.sort()).toEqual(["a.ts", "b.ts"]);
    // earliest op per file
    expect(snapshots.restore).toHaveBeenCalledWith(sessionId, "ev-a1");
    expect(snapshots.restore).toHaveBeenCalledWith(sessionId, "ev-b1");
    // all events of restored files dropped
    expect(snapshots.drop).toHaveBeenCalledWith(sessionId, "ev-a1");
    expect(snapshots.drop).toHaveBeenCalledWith(sessionId, "ev-a2");
    expect(ctx.diffTracker.remove).toHaveBeenCalledWith(sessionId, "a.ts");
    expect(ctx.diffTracker.remove).toHaveBeenCalledWith(sessionId, "b.ts");
    expect(ctx.emitDiff).toHaveBeenCalled();
  });

  it("accumulates transcript in memory and persists without renderer save", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-main-"));
    const archive = new SessionArchive(dir);
    const emitted: SdkNormalizedEvent[] = [];
    const ctx = makeDeps();
    // Rebuild manager with archive — copy makeDeps fields.
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: (e) => {
        emitted.push(e);
        ctx.emit(e);
      },
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });

    const sessionId = await manager.start(
      { text: "hello", attachments: [] },
      "D:/proj",
    );
    const items = manager.getTranscript(sessionId);
    expect(items.some((i) => i.kind === "text" && i.role === "user" && i.text === "hello")).toBe(true);
    expect(items.some((i) => i.kind === "text" && i.role === "assistant" && String((i as { text: string }).text).includes("Hi"))).toBe(true);
    expect(items.some((i) => i.kind === "tool")).toBe(true);

    manager.flushPendingPersistence();
    const disk = archive.loadItems(sessionId);
    expect(disk.some((i) => i.kind === "text" && i.role === "user")).toBe(true);
    expect(disk.some((i) => i.kind === "text" && i.role === "assistant")).toBe(true);
    // streaming flags stripped on disk
    expect(disk.filter((i) => i.kind === "text").every((i) => i.kind === "text" && !i.streaming)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hides room-mod sessions from list and keeps hiddenFromList after restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-hide-"));
    const archive = new SessionArchive(dir);
    const ctx = makeDeps();
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    const hiddenId = await manager.start(
      { text: "[room_mod]\nsecret-view", attachments: [] },
      "D:/proj",
      {
        hiddenFromList: true,
        title: "[room_mod] Bot",
        persistText: "[room_mod] room-1 seat-1",
      },
    );
    const visibleId = await manager.start(
      { text: "hello", attachments: [] },
      "D:/proj",
    );
    expect(manager.list().map((s) => s.id)).toEqual([visibleId]);
    expect(archive.loadIndex().find((s) => s.id === hiddenId)?.hiddenFromList).toBe(
      true,
    );
    expect(
      manager
        .getTranscript(hiddenId)
        .some((i) => i.kind === "text" && i.role === "user" && i.text.includes("secret-view")),
    ).toBe(false);
    expect(
      manager
        .getTranscript(hiddenId)
        .some(
          (i) =>
            i.kind === "text" &&
            i.role === "user" &&
            i.text === "[room_mod] room-1 seat-1",
        ),
    ).toBe(true);

    const restarted = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    expect(restarted.list().map((s) => s.id)).toEqual([visibleId]);
    expect(restarted.getSummary(hiddenId)?.hiddenFromList).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pin, rename and delete a session (persisted via archive)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-pin-"));
    const archive = new SessionArchive(dir);
    const ctx = makeDeps();
    const snapshots = {
      has: vi.fn().mockReturnValue(false),
      pathOf: vi.fn().mockReturnValue(null),
      restore: vi.fn().mockReturnValue(false),
      list: vi.fn().mockReturnValue([]),
      drop: vi.fn(),
      dropAll: vi.fn(),
    };
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
      snapshots,
    });
    const a = await manager.start({ text: "first", attachments: [] }, "D:/proj");
    const b = await manager.start({ text: "second", attachments: [] }, "D:/proj");

    // Newer first by default.
    expect(manager.list().map((s) => s.id)).toEqual([b, a]);

    // Pin the older one → jumps to top, persisted.
    const pinned = manager.setPinned(a, true);
    expect(pinned?.pinned).toBe(true);
    expect(manager.list().map((s) => s.id)).toEqual([a, b]);
    expect(archive.loadIndex().find((s) => s.id === a)?.pinned).toBe(true);

    // Rename → trimmed, updated, persisted; empty title rejected.
    const renamed = manager.rename(a, "  重要会话  ");
    expect(renamed?.title).toBe("重要会话");
    expect(archive.loadIndex().find((s) => s.id === a)?.title).toBe("重要会话");
    expect(manager.rename(a, "   ")).toBeUndefined();

    // Unpin → flag gone.
    manager.setPinned(a, false);
    expect(manager.getSummary(a)?.pinned).toBeUndefined();

    // Delete → gone from list, index and transcript files.
    expect(manager.delete(b)).toBe(true);
    expect(manager.list().map((s) => s.id)).toEqual([a]);
    expect(manager.getSummary(b)).toBeUndefined();
    expect(archive.loadIndex().map((s) => s.id)).toEqual([a]);
    expect(fs.existsSync(path.join(dir, "sessions", `${b}.json`))).toBe(false);
    expect(snapshots.dropAll).toHaveBeenCalledWith(b);
    expect(manager.delete("missing")).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("continue appends the next user turn onto hydrated disk items", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-cont-"));
    const archive = new SessionArchive(dir);
    const ctx = makeDeps();
    const manager = new SessionManager({
      queryFn: async function* (args) {
        await takeFirstUserText(args.prompt);
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hi" },
          },
        };
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      },
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    const sessionId = await manager.start(
      { text: "first", attachments: [] },
      "D:/p",
    );
    await manager.continue(sessionId, { text: "second", attachments: [] });
    const texts = manager
      .getTranscript(sessionId)
      .filter((i) => i.kind === "text")
      .map((i) => (i.kind === "text" ? i.text : ""));
    expect(texts).toContain("first");
    expect(texts).toContain("second");
    manager.flushPendingPersistence();
    expect(
      archive
        .loadItems(sessionId)
        .some((i) => i.kind === "text" && i.text === "second"),
    ).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rewind truncates items at the user message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-rw-"));
    const archive = new SessionArchive(dir);
    const rewindFiles = vi.fn().mockResolvedValue({
      canRewind: true,
      filesChanged: [],
    });
    const queryFn: QueryFn = (args) => {
      const gen = (async function* () {
        await takeFirstUserText(args.prompt);
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hi" },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          total_cost_usd: 0,
          session_id: "sdk-1",
        };
        for await (const _ of args.prompt as AsyncIterable<unknown>) {
          yield {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            session_id: "sdk-1",
          };
        }
      })();
      return Object.assign(gen, { rewindFiles }) as never;
    };
    const ctx = makeDeps({ queryFn });
    const manager = new SessionManager({
      queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    const sessionId = await manager.start(
      { text: "hello", attachments: [] },
      "D:/p",
    );
    const stamped = manager.getTranscript(sessionId).map((i) =>
      i.kind === "text" && i.role === "user"
        ? { ...i, sdkMsgId: "uuid-hello" }
        : i,
    );
    manager.saveTranscript(sessionId, stamped, { replace: true });

    const res = await manager.rewindToUserMessage(sessionId, "uuid-hello");
    expect(res.ok).toBe(true);
    const after = manager.getTranscript(sessionId);
    const last = after[after.length - 1];
    expect(last?.kind === "text" && last.role === "user").toBe(true);
    if (last && last.kind === "text") {
      expect(last.sdkMsgId).toBe("uuid-hello");
      expect(last.text).toBe("hello");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("compressSession prefers in-memory items over a stale disk copy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-cp-"));
    const archive = new SessionArchive(dir);
    const compressor = {
      compress: vi.fn(async (items: import("@claude-desktop/shared").ChatItem[]) => ({
        items: [
          {
            kind: "text" as const,
            id: "sum",
            role: "system" as const,
            text: `n=${items.length}`,
          },
        ],
        summaryText: "sum",
        compressedCount: Math.max(0, items.length - 1),
      })),
    };
    const ctx = makeDeps();
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      compressor: compressor as never,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    const sessionId = await manager.start(
      { text: "hello", attachments: [] },
      "D:/p",
    );
    // Ensure enough history for compress (KEEP_RECENT_ITEMS = 6).
    const padded = Array.from({ length: 10 }, (_, i) => ({
      kind: "text" as const,
      id: `pad-${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `msg-${i}`,
    }));
    manager.saveTranscript(sessionId, padded, { replace: true });
    // Stale short disk snapshot should be ignored once memory is non-empty.
    archive.saveItems(sessionId, [
      { kind: "text", id: "stale", role: "user", text: "stale" },
    ]);
    const memLen = manager.getTranscript(sessionId).length;
    expect(memLen).toBe(10);
    const res = await manager.compressSession(sessionId);
    expect(res.ok).toBe(true);
    expect(compressor.compress).toHaveBeenCalled();
    const passed = compressor.compress.mock.calls[0][0] as import("@claude-desktop/shared").ChatItem[];
    expect(passed.length).toBe(memLen);
    expect(manager.getTranscript(sessionId)[0]).toMatchObject({ id: "sum" });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pages complete user turns despite hundreds of tool records within a turn", async () => {
    const ctx = makeDeps();
    const id = await ctx.manager.start({ text: "start", attachments: [] }, "D:/p");
    const turns: ChatItem[][] = Array.from({ length: 30 }, (_, turn) => [
      { kind: "text", role: "user", id: `user-${turn}`, text: `Question ${turn}` },
      ...Array.from({ length: turn === 20 ? 350 : 3 }, (_, step): ChatItem => ({
        kind: "tool", id: `tool-${turn}-${step}`,
        tool: { id: `tool-${turn}-${step}`, name: "Read", summary: "Read file", status: "done" },
      })),
      { kind: "text", role: "assistant", id: `answer-${turn}`, text: `Answer ${turn}` },
    ]);
    ctx.manager.saveTranscript(id, turns.flat(), { replace: true });
    const tail = ctx.manager.getTranscriptPage(id, { turnLimit: 12 });
    expect(tail.items).toEqual(turns.slice(18).flat());
    expect(tail.hasMore).toBe(true);
    expect(tail.hasNewer).toBe(false);
    const older = ctx.manager.getTranscriptPage(id, { beforeId: tail.items[0]!.id, turnLimit: 12 });
    expect(older.items).toEqual(turns.slice(6, 18).flat());
    const newer = ctx.manager.getTranscriptPage(id, { afterId: older.items.at(-1)!.id, turnLimit: 12 });
    expect(newer.items).toEqual(tail.items);
    const first = ctx.manager.getTranscriptPage(id, { beforeId: older.items[0]!.id, turnLimit: 12 });
    expect(first.items).toEqual(turns.slice(0, 6).flat());
    expect(first.hasMore).toBe(false);
  });

  it("getTranscriptPage returns shallow-copied items", async () => {
    const ctx = makeDeps();
    const sessionId = await ctx.manager.start(
      { text: "hello", attachments: [] },
      "D:/p",
    );
    const page = ctx.manager.getTranscriptPage(sessionId, { limit: 50 });
    expect(page.items.length).toBeGreaterThan(0);
    const original = ctx.manager.getTranscript(sessionId);
    expect(page.items[0]).not.toBe(original[0]);
    // Mutating the page must not pollute the authority array.
    const first = page.items[0];
    if (first.kind === "text") {
      (first as { text: string }).text = "mutated-by-caller";
    }
    const after = ctx.manager.getTranscript(sessionId);
    expect(after.some((i) => i.kind === "text" && i.text === "mutated-by-caller")).toBe(
      false,
    );
  });

  it("keeps page reads unhydrated and caps full transcript memory with LRU", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-lru-"));
    const archive = new SessionArchive(dir);
    const ids = Array.from(
      { length: MAX_HYDRATED_TRANSCRIPTS + 2 },
      (_, i) => `stored-${i}`,
    );
    for (const [i, id] of ids.entries()) {
      archive.upsertSummary({
        id,
        title: id,
        cwd: "D:/p",
        updatedAt: i + 1,
        status: "idle",
      });
      archive.saveItems(id, [
        { kind: "text", id: `${id}-m`, role: "user", text: id },
      ]);
    }
    const ctx = makeDeps();
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });

    for (const id of ids) {
      expect(manager.getTranscriptPage(id, { limit: 1 }).items).toHaveLength(1);
    }
    expect(manager.getMemoryStats().hydratedTranscripts).toBe(0);

    for (const id of ids) manager.getTranscript(id);
    expect(manager.getMemoryStats()).toMatchObject({
      hydratedTranscripts: MAX_HYDRATED_TRANSCRIPTS,
      hydratedItems: MAX_HYDRATED_TRANSCRIPTS,
    });

    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads archived changes on demand and evicts them with LRU", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-changes-lru-"));
    const archive = new SessionArchive(dir);
    const ids = Array.from(
      { length: MAX_HYDRATED_CHANGES + 1 },
      (_, i) => `changes-${i}`,
    );
    for (const [i, id] of ids.entries()) {
      archive.upsertSummary({
        id,
        title: id,
        cwd: "D:/p",
        updatedAt: i + 1,
        status: "idle",
      });
      archive.saveChanges(id, [
        {
          path: `src/${i}.ts`,
          status: "M",
          hunks: `h${i}`,
          updatedAt: i + 1,
          events: [
            { id: `ev-${i}`, tool: "Edit", at: i + 1, hunk: `h${i}` },
          ],
        },
      ]);
    }
    const loadChanges = vi.spyOn(archive, "loadChanges");
    const ctx = makeDeps();
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: new DiffTracker({ fileExists: () => true }),
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });

    expect(loadChanges).not.toHaveBeenCalled();
    expect(manager.getMemoryStats().hydratedChanges).toBe(0);
    for (const [i, id] of ids.entries()) {
      expect(manager.listChanges(id)[0]?.path).toBe(`src/${i}.ts`);
    }
    expect(manager.getMemoryStats()).toMatchObject({
      hydratedChanges: MAX_HYDRATED_CHANGES,
      trackedChangeFiles: MAX_HYDRATED_CHANGES,
    });

    // The least-recently used first session was evicted and is read again.
    manager.listChanges(ids[0]!);
    expect(loadChanges.mock.calls.filter(([id]) => id === ids[0])).toHaveLength(2);

    manager.disposeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists sdkMsgId when user_msg_ids binds user turns", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-uuid-"));
    const archive = new SessionArchive(dir);
    const queryFn: QueryFn = async function* (args) {
      await takeFirstUserText(args.prompt);
      yield {
        type: "user",
        uuid: "u-bind-1",
        session_id: "sdk-1",
        message: { role: "user", content: "hello" },
      };
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };
    const ctx = makeDeps({ queryFn });
    const manager = new SessionManager({
      queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    const sessionId = await manager.start(
      { text: "hello", attachments: [] },
      "D:/p",
    );
    manager.flushPendingPersistence();
    const disk = archive.loadItems(sessionId);
    const user = disk.find((i) => i.kind === "text" && i.role === "user");
    expect(user && user.kind === "text" ? user.sdkMsgId : undefined).toBe(
      "u-bind-1",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("releaseForCli tears down the desktop stream and returns resume info", async () => {
    const ctx = makeDeps();
    const sessionId = await ctx.manager.start(
      { text: "hello", attachments: [] },
      "D:/proj",
    );
    const snap = ctx.manager.releaseForCli(sessionId);
    expect(snap.cwd).toBe("D:/proj");
    expect(snap.sdkSessionId).toBe("sdk-session-1");
    expect(snap.model).toBe("kimi-for-coding");
    expect(snap.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    const summary = ctx.manager.getSummary(sessionId);
    expect(summary?.status).not.toBe("running");
  });
});

type HookToolAttempt = {
  name: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
};

type PreToolResult = {
  hookSpecificOutput?: {
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
  };
};

type PreToolHook = (
  input: { tool_name: string; tool_input: Record<string, unknown> },
  toolUseId: string,
  options: { signal: AbortSignal },
) => Promise<PreToolResult>;

/** Exercise the actual hooks built by SessionManager at the SDK query boundary. */
function makeRoomHookSession(
  turns: HookToolAttempt[][],
  canUseTool?: ReturnType<typeof vi.fn>,
  extras: Pick<SessionManagerDeps, "archive" | "compressor"> = {},
) {
  const outcomes: Array<{
    name: string;
    hook: PreToolResult;
    executed: boolean;
    permission?: { behavior: string };
  }> = [];
  const queryOptions: Record<string, unknown>[] = [];
  let turn = 0;
  const queryFn: QueryFn = (args) => {
    queryOptions.push(args.options);
    return (async function* () {
      for await (const _message of args.prompt as AsyncIterable<unknown>) {
        for (const attempt of turns[turn++] ?? []) {
          const groups = (args.options.hooks as {
            PreToolUse: Array<{ hooks: PreToolHook[] }>;
          }).PreToolUse;
          let hook: PreToolResult = {};
          for (const callback of groups.flatMap((group) => group.hooks)) {
            hook = await callback(
              { tool_name: attempt.name, tool_input: attempt.input },
              `tool-${outcomes.length}`,
              {
                signal: attempt.signal ??
                  (args.options.abortController as AbortController).signal,
              },
            );
            if (hook.hookSpecificOutput?.permissionDecision === "deny") break;
          }
          const denied = hook.hookSpecificOutput?.permissionDecision === "deny";
          // Mirror SDK auto-allow/bypass: these calls still MUST pass PreToolUse.
          const autoAllowed = ["auto", "bypassPermissions"].includes(String(args.options.permissionMode)) ||
            (args.options.allowedTools as string[]).includes(attempt.name);
          const permission = !denied && !autoAllowed
            ? await (args.options.canUseTool as (
                name: string,
                input: Record<string, unknown>,
                options: { signal: AbortSignal },
              ) => Promise<{ behavior: string }>)(attempt.name, attempt.input, {
                signal: (args.options.abortController as AbortController).signal,
              })
            : undefined;
          outcomes.push({
            name: attempt.name,
            hook,
            executed: !denied && (!permission || permission.behavior === "allow"),
            permission,
          });
        }
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      }
    })();
  };
  return { ...makeDeps({ queryFn, canUseTool, ...extras }), outcomes, queryOptions };
}

const roomPrompt = { text: "room turn", attachments: [] };
const roomWrite = { name: "Write", input: { file_path: "a.txt", content: "hi" } };
const roomChatTools = [
  "mcp__room-chat__room_members",
  "mcp__room-chat__room_message",
];
const roomChatBinding = {
  extraMcpServers: { "room-chat": { type: "sdk", name: "room-chat", instance: {} } },
  extraAllowedTools: roomChatTools,
};

describe("SessionManager room read-only query hooks", () => {
  it.each(["default", "acceptEdits", "auto", "plan"] as const)(
    "denies unsafe tools without a room approval callback in %s mode",
    async (permissionMode) => {
      const names = [
        "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Task", "Agent",
        "mcp__unknown__read_file", "mcp__room-chat__other", "TodoWrite", "WebFetch", "",
      ];
      const ctx = makeRoomHookSession([names.map((name) => ({ name, input: {} }))]);
      try {
        await ctx.manager.start(roomPrompt, "D:/room", {
          roomReadOnly: true,
          permissionMode,
          // Even explicit auto-approval must not bypass the execution hook.
          extraAllowedTools: names,
        });
        expect(ctx.outcomes).toHaveLength(names.length);
        expect(ctx.outcomes.every((outcome) => !outcome.executed)).toBe(true);
        for (const outcome of ctx.outcomes) {
          expect(outcome.hook.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
        }
      } finally {
        ctx.manager.disposeAll();
      }
    },
  );

  it("allows Read/Glob/Grep only within pathJail without requesting write access", async () => {
    const requestRoomWriteAccess = vi.fn().mockResolvedValue(true);
    const ctx = makeRoomHookSession([[
      { name: "Read", input: { file_path: "a.txt" } },
      { name: "Glob", input: { pattern: "**/*" } },
      { name: "Grep", input: { pattern: "hi", path: "." } },
      { name: "Read", input: { file_path: "../outside.txt" } },
      { name: "Glob", input: { path: "..", pattern: "*" } },
      { name: "Grep", input: { path: "../outside", pattern: "hi" } },
    ]]);
    try {
      await ctx.manager.start(roomPrompt, "D:/room", {
        roomReadOnly: true, pathJail: "D:/room", requestRoomWriteAccess,
      });
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([true, true, true, false, false, false]);
      expect(requestRoomWriteAccess).not.toHaveBeenCalled();
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("allows only the two room-chat tools attached by the current room task", async () => {
    const requestRoomWriteAccess = vi.fn().mockResolvedValue(false);
    const attempts = roomChatTools.map((name) => ({ name, input: {} }));
    const ctx = makeRoomHookSession([attempts, attempts, attempts]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", {
        roomReadOnly: true, requestRoomWriteAccess, ...roomChatBinding,
      });
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([true, true]);
      expect(requestRoomWriteAccess).not.toHaveBeenCalled();
      await ctx.manager.continue(id, roomPrompt, {
        roomReadOnly: true, requestRoomWriteAccess, replaceExtras: true,
      });
      // Same names in user-configured MCP/allowedTools are not a task binding.
      await ctx.manager.continue(id, roomPrompt, {
        roomReadOnly: true, requestRoomWriteAccess, replaceExtras: true,
        extraAllowedTools: roomChatTools,
        extraMcpServers: { "room-chat": { command: "untrusted-server" } },
      });
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([true, true, false, false, false, false]);
      expect(requestRoomWriteAccess).toHaveBeenCalledTimes(4);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it.each([false, "throw"])("fails closed when write approval returns %s", async (answer) => {
    const requestRoomWriteAccess = vi.fn(async () => {
      if (answer === "throw") throw new Error("approval unavailable");
      return false;
    });
    const ctx = makeRoomHookSession([[roomWrite, { name: "Bash", input: { command: "echo hi" } }]]);
    try {
      await ctx.manager.start(roomPrompt, "D:/room", { roomReadOnly: true, requestRoomWriteAccess });
      expect(requestRoomWriteAccess).toHaveBeenNthCalledWith(1, roomWrite.name, roomWrite.input);
      expect(requestRoomWriteAccess).toHaveBeenCalledTimes(2);
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([false, false]);
      expect(ctx.permissionBroker.canUseTool).not.toHaveBeenCalled();
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("waits for approval then unlocks only this turn and preserves existing permissions", async () => {
    let approve!: (value: boolean) => void;
    const requestRoomWriteAccess = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    const canUseTool = vi.fn().mockResolvedValue({ behavior: "deny", message: "existing policy" });
    const ctx = makeRoomHookSession([[roomWrite, { name: "Bash", input: { command: "echo hi" } }]], canUseTool);
    try {
      const started = ctx.manager.start(roomPrompt, "D:/room", { roomReadOnly: true, requestRoomWriteAccess });
      await vi.waitFor(() => expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1));
      expect(ctx.outcomes).toEqual([]);
      expect(canUseTool).not.toHaveBeenCalled();
      approve(true);
      await started;
      expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1);
      expect(canUseTool).toHaveBeenCalledTimes(2);
      expect(ctx.outcomes.map((outcome) => outcome.hook)).toEqual([{}, {}]);
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([false, false]);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("still denies out-of-jail writes after the turn was approved", async () => {
    const requestRoomWriteAccess = vi.fn().mockResolvedValue(true);
    const ctx = makeRoomHookSession([[
      roomWrite,
      { name: "Write", input: { file_path: "../outside.txt" } },
      { name: "Bash", input: { command: "echo hi > ../outside.txt" } },
    ]]);
    try {
      await ctx.manager.start(roomPrompt, "D:/room", {
        roomReadOnly: true, requestRoomWriteAccess, pathJail: "D:/room",
      });
      expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1);
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([true, false, false]);
      expect(ctx.outcomes.slice(1).every((outcome) =>
        outcome.hook.hookSpecificOutput?.permissionDecisionReason?.includes("工作区外"),
      )).toBe(true);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("rejects out-of-jail writes before asking to leave read-only", async () => {
    const requestRoomWriteAccess = vi.fn().mockResolvedValue(true);
    const ctx = makeRoomHookSession([[
      { name: "Write", input: { file_path: "../outside.txt" } },
      { name: "Bash", input: { command: "echo hi > ../outside.txt" } },
    ]]);
    try {
      await ctx.manager.start(roomPrompt, "D:/room", {
        roomReadOnly: true, requestRoomWriteAccess, pathJail: "D:/room",
      });
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([false, false]);
      expect(requestRoomWriteAccess).not.toHaveBeenCalled();
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("reads fresh flags and callbacks on every turn of the same reused query", async () => {
    const oldApproval = vi.fn().mockResolvedValue(true);
    const newApproval = vi.fn().mockResolvedValue(false);
    const ctx = makeRoomHookSession(Array.from({ length: 6 }, () => [roomWrite]));
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room");
      await ctx.manager.continue(id, roomPrompt, { roomReadOnly: true, requestRoomWriteAccess: oldApproval });
      await ctx.manager.continue(id, roomPrompt, { roomReadOnly: true, requestRoomWriteAccess: newApproval });
      await ctx.manager.continue(id, roomPrompt, { roomReadOnly: true });
      await ctx.manager.continue(id, roomPrompt, { roomReadOnly: false, requestRoomWriteAccess: newApproval });
      await ctx.manager.continue(id, roomPrompt);
      expect(ctx.queryOptions).toHaveLength(1);
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([true, true, false, false, true, true]);
      expect(oldApproval).toHaveBeenCalledTimes(1);
      expect(newApproval).toHaveBeenCalledTimes(1);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("resets an approved start turn on reused continue and clears the callback when omitted", async () => {
    const requestRoomWriteAccess = vi.fn().mockResolvedValue(true);
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite], [roomWrite], [roomWrite]]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { roomReadOnly: true, requestRoomWriteAccess });
      await ctx.manager.continue(id, roomPrompt, { roomReadOnly: true, requestRoomWriteAccess });
      await ctx.manager.continue(id, roomPrompt, { roomReadOnly: true });
      await ctx.manager.continue(id, roomPrompt);
      expect(ctx.queryOptions).toHaveLength(1);
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([true, true, false, true]);
      expect(requestRoomWriteAccess).toHaveBeenCalledTimes(2);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("does not apply room restrictions or callbacks to ordinary sessions", async () => {
    const requestRoomWriteAccess = vi.fn().mockResolvedValue(false);
    const ctx = makeRoomHookSession([[roomWrite, { name: "Agent", input: {} }]]);
    try {
      await ctx.manager.start(roomPrompt, "D:/room", { requestRoomWriteAccess });
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([true, true]);
      expect(requestRoomWriteAccess).not.toHaveBeenCalled();
      expect(ctx.permissionBroker.canUseTool).toHaveBeenCalledTimes(2);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("denies late approval after abort even when a new query has already started", async () => {
    let approve!: (value: boolean) => void;
    const requestRoomWriteAccess = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite]]);
    let id = "";
    try {
      const started = ctx.manager.start(roomPrompt, "D:/room", {
        roomReadOnly: true, requestRoomWriteAccess, onSessionId: (value) => { id = value; },
      });
      await vi.waitFor(() => expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1));
      ctx.manager.abort(id);
      await started;
      await ctx.manager.continue(id, roomPrompt, { roomReadOnly: true });
      approve(true);
      await vi.waitFor(() => expect(ctx.outcomes).toHaveLength(2));
      expect(ctx.queryOptions).toHaveLength(2);
      expect(ctx.outcomes.every((outcome) => !outcome.executed)).toBe(true);
      expect(ctx.permissionBroker.canUseTool).not.toHaveBeenCalled();
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("honors the SDK hook signal when cancellation races with approval", async () => {
    const hookController = new AbortController();
    let approve!: (value: boolean) => void;
    const requestRoomWriteAccess = vi.fn(() => new Promise<boolean>((resolve) => { approve = resolve; }));
    const ctx = makeRoomHookSession([[{ ...roomWrite, signal: hookController.signal }, roomWrite]]);
    try {
      const started = ctx.manager.start(roomPrompt, "D:/room", { roomReadOnly: true, requestRoomWriteAccess });
      await vi.waitFor(() => expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1));
      hookController.abort();
      requestRoomWriteAccess.mockResolvedValue(false);
      approve(true);
      await started;
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([false, false]);
      expect(requestRoomWriteAccess).toHaveBeenCalledTimes(2);
    } finally {
      ctx.manager.disposeAll();
    }
  });
});

function roomDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SessionManager MCP extras binding", () => {
  const roomMessage = { name: "mcp__room-chat__room_message", input: { text: "delegate" } };
  const readyStatus = { state: "ready" as const, port: 8317, managedByApp: false };
  const sdkServer = (instance: object) => ({ type: "sdk", name: "room-chat", instance });
  const boundServer = (options: Record<string, unknown>) =>
    (options.mcpServers as Record<string, {
      type?: string; instance?: unknown; command?: string; args?: string[]; env?: Record<string, string>;
    }>)["room-chat"];

  it.each(["replace", "merge"])("rebinds a same-name stdio server to SDK via %s", async (mode) => {
    const requestRoomWriteAccess = vi.fn().mockResolvedValue(false);
    const instance = {};
    const ctx = makeRoomHookSession([[roomMessage], [roomMessage]]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", {
        roomReadOnly: true, requestRoomWriteAccess, extraAllowedTools: roomChatTools,
        extraMcpServers: { "room-chat": { command: "old-stdio" } },
      });
      await ctx.manager.continue(id, roomPrompt, {
        roomReadOnly: true, requestRoomWriteAccess, replaceExtras: mode === "replace",
        extraAllowedTools: roomChatTools, extraMcpServers: { "room-chat": sdkServer(instance) },
      });
      expect(ctx.queryOptions).toHaveLength(2);
      expect(boundServer(ctx.queryOptions[0]).command).toBe("old-stdio");
      expect(boundServer(ctx.queryOptions[1]).instance).toBe(instance);
      expect(ctx.outcomes.map((outcome) => outcome.executed)).toEqual([false, true]);
      expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it.each(["replace", "merge"])("binds SDK instance B instead of task A through %s", async (mode) => {
    // Structurally identical instances still belong to different task closures.
    const instanceA = {};
    const instanceB = {};
    const requestRoomWriteAccess = vi.fn().mockResolvedValue(false);
    const ctx = makeRoomHookSession([[roomMessage], [roomMessage]]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", {
        roomReadOnly: true, requestRoomWriteAccess, roomAbortSignal: new AbortController().signal,
        extraMcpServers: { "room-chat": sdkServer(instanceA) }, extraAllowedTools: roomChatTools,
      });
      await ctx.manager.continue(id, roomPrompt, {
        roomReadOnly: true, requestRoomWriteAccess, roomAbortSignal: new AbortController().signal,
        replaceExtras: mode === "replace",
        extraMcpServers: { "room-chat": sdkServer(instanceB) }, extraAllowedTools: roomChatTools,
      });
      expect(ctx.queryOptions).toHaveLength(2);
      expect(boundServer(ctx.queryOptions[0]).instance).toBe(instanceA);
      expect(boundServer(ctx.queryOptions[1]).instance).toBe(instanceB);
      expect(ctx.outcomes.every((outcome) => outcome.executed)).toBe(true);
      expect(requestRoomWriteAccess).not.toHaveBeenCalled();
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it.each(["replace", "merge"])("reopens when same-name stdio configuration changes via %s", async (mode) => {
    const configs = [
      { command: "server", args: ["A"], env: { TASK: "A" } },
      { command: "server", args: ["B"], env: { TASK: "A" } },
      { command: "server", args: ["B"], env: { TASK: "B" } },
      { command: "new-server", args: ["B"], env: { TASK: "B" } },
    ];
    const ctx = makeRoomHookSession(configs.map(() => []));
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { extraMcpServers: { "room-chat": configs[0] } });
      for (const config of configs.slice(1)) {
        await ctx.manager.continue(id, roomPrompt, {
          replaceExtras: mode === "replace", extraMcpServers: { "room-chat": config },
        });
      }
      expect(ctx.queryOptions).toHaveLength(configs.length);
      expect(ctx.queryOptions.map(boundServer)).toEqual(configs);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it.each(["replace", "merge"])("keeps equivalent configs and the same SDK instance warm via %s", async (mode) => {
    const instance = {};
    const ctx = makeRoomHookSession([[], []]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", {
        extraMcpServers: { "room-chat": sdkServer(instance), log: { command: "log", args: ["x"], env: { A: "a", B: "b" } } },
        extraAllowedTools: roomChatTools,
      });
      await ctx.manager.continue(id, roomPrompt, {
        replaceExtras: mode === "replace",
        extraMcpServers: { log: { env: { B: "b", A: "a" }, args: ["x"], command: "log" }, "room-chat": sdkServer(instance) },
        extraAllowedTools: [...roomChatTools].reverse(),
      });
      expect(ctx.queryOptions).toHaveLength(1);
      expect(boundServer(ctx.queryOptions[0]).instance).toBe(instance);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it.each(["replace", "merge"])("does not overwrite a required model reopen with unchanged %s extras", async (mode) => {
    const servers = { "room-chat": sdkServer({}) };
    const ctx = makeRoomHookSession([[], []]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { extraMcpServers: servers });
      await ctx.manager.continue(id, roomPrompt, {
        model: "next-model", extraMcpServers: servers, replaceExtras: mode === "replace",
      });
      expect(ctx.queryOptions).toHaveLength(2);
      expect(ctx.queryOptions[1].model).toBe("next-model");
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it.each(["server", "allowed tools"])("does not grant old query exemptions from staged %s during CPA preparation", async (change) => {
    const approval = roomDeferred<boolean>();
    const ready = roomDeferred<typeof readyStatus>();
    const requestRoomWriteAccess = vi.fn().mockResolvedValue(false).mockReturnValueOnce(approval.promise);
    const server = sdkServer({});
    const ctx = makeRoomHookSession([[roomWrite], []]);
    let id = "";
    let continued: Promise<void> | undefined;
    const started = ctx.manager.start(roomPrompt, "D:/room", {
      roomReadOnly: true, requestRoomWriteAccess,
      extraMcpServers: { "room-chat": change === "server" ? { command: "old-stdio" } : server },
      extraAllowedTools: change === "server" ? roomChatTools : [],
      onSessionId: (value) => { id = value; },
    });
    try {
      await vi.waitFor(() => expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1));
      vi.mocked(ctx.cpa.ensureReady).mockReturnValueOnce(ready.promise);
      continued = ctx.manager.continue(id, roomPrompt, {
        roomReadOnly: true, requestRoomWriteAccess, replaceExtras: true,
        extraMcpServers: { "room-chat": server }, extraAllowedTools: roomChatTools,
      });
      const oldOptions = ctx.queryOptions[0];
      const hook = (oldOptions.hooks as { PreToolUse: Array<{ hooks: PreToolHook[] }> }).PreToolUse[0].hooks[0];
      const result = await hook({ tool_name: roomMessage.name, tool_input: roomMessage.input }, "old-query", {
        signal: (oldOptions.abortController as AbortController).signal,
      });
      expect(ctx.queryOptions).toHaveLength(1);
      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(requestRoomWriteAccess).toHaveBeenCalledTimes(2);
    } finally {
      approval.resolve(false);
      await started;
      ready.resolve(readyStatus);
      await continued;
      ctx.manager.disposeAll();
    }
  });

  it("rebinds staged extras after failed preparation even when retry omits extras", async () => {
    const instanceA = {};
    const instanceB = {};
    const ctx = makeRoomHookSession([[], []]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { extraMcpServers: { "room-chat": sdkServer(instanceA) } });
      vi.mocked(ctx.cpa.ensureReady).mockRejectedValueOnce(new Error("CPA unavailable"));
      await expect(ctx.manager.continue(id, roomPrompt, {
        extraMcpServers: { "room-chat": sdkServer(instanceB) }, replaceExtras: true,
      })).rejects.toThrow("CPA unavailable");
      expect(ctx.queryOptions).toHaveLength(1);
      await ctx.manager.continue(id, roomPrompt);
      expect(ctx.queryOptions).toHaveLength(2);
      expect(boundServer(ctx.queryOptions[1]).instance).toBe(instanceB);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it.each(["stdio", "SDK"])("syncExtras invalidates a same-name %s binding before the next turn", async (kind) => {
    const serverA = kind === "SDK" ? sdkServer({}) : { command: "stdio-A" };
    const serverB = kind === "SDK" ? sdkServer({}) : { command: "stdio-B" };
    const ctx = makeRoomHookSession([[], []]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { extraMcpServers: { "room-chat": serverA } });
      ctx.manager.syncExtras(id, { extraMcpServers: { "room-chat": serverB } });
      await ctx.manager.continue(id, roomPrompt);
      expect(ctx.queryOptions).toHaveLength(2);
      expect(boundServer(ctx.queryOptions[1])).toEqual(serverB);
      if (kind === "SDK") expect(boundServer(ctx.queryOptions[1]).instance).toBe((serverB as ReturnType<typeof sdkServer>).instance);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("snapshots mutable SDK wrappers and rebinds their replacement instance", async () => {
    const instanceA = {};
    const instanceB = {};
    const server = sdkServer(instanceA);
    const ctx = makeRoomHookSession([[], []]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { extraMcpServers: { "room-chat": server } });
      server.instance = instanceB;
      await ctx.manager.continue(id, roomPrompt, { extraMcpServers: { "room-chat": server } });
      expect(boundServer(ctx.queryOptions[0]).instance).toBe(instanceA);
      expect(ctx.queryOptions).toHaveLength(2);
      expect(boundServer(ctx.queryOptions[1]).instance).toBe(instanceB);
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("snapshots mutable stdio arguments and environment before the next binding", async () => {
    const server = { command: "stdio", args: ["A"], env: { TASK: "A" } };
    const ctx = makeRoomHookSession([[], []]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { extraMcpServers: { "room-chat": server } });
      server.args[0] = "B";
      server.env.TASK = "B";
      await ctx.manager.continue(id, roomPrompt, { extraMcpServers: { "room-chat": server } });
      expect(boundServer(ctx.queryOptions[0]).args).toEqual(["A"]);
      expect(boundServer(ctx.queryOptions[0]).env).toEqual({ TASK: "A" });
      expect(ctx.queryOptions).toHaveLength(2);
      expect(boundServer(ctx.queryOptions[1]).args).toEqual(["B"]);
      expect(boundServer(ctx.queryOptions[1]).env).toEqual({ TASK: "B" });
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("keeps ordinary sessions without extras on the same query", async () => {
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite], [roomWrite]]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room");
      await ctx.manager.continue(id, roomPrompt);
      await ctx.manager.continue(id, roomPrompt, { replaceExtras: true, extraMcpServers: {}, extraAllowedTools: [] });
      expect(ctx.queryOptions).toHaveLength(1);
      expect(ctx.queryOptions[0].mcpServers).toBeUndefined();
      expect(ctx.outcomes.every((outcome) => outcome.executed)).toBe(true);
    } finally {
      ctx.manager.disposeAll();
    }
  });
});

describe("SessionManager room abort signal", () => {
  const readyStatus = { state: "ready" as const, port: 8317, managedByApp: false };

  it("does not prepare or open a query for an already cancelled room start", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeRoomHookSession([[roomWrite]]);
    try {
      const error = await ctx.manager.start(roomPrompt, "D:/room", {
        roomAbortSignal: controller.signal,
      }).catch((reason: unknown) => reason);
      expect(ctx.queryOptions).toHaveLength(0);
      expect(ctx.ensureReady).not.toHaveBeenCalled();
      expect(error).toMatchObject({ name: "AbortError" });
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("does not open a query when a room start is cancelled during CPA preparation", async () => {
    const controller = new AbortController();
    const ready = roomDeferred<typeof readyStatus>();
    const ctx = makeRoomHookSession([[roomWrite]]);
    vi.mocked(ctx.cpa.ensureReady).mockReturnValueOnce(ready.promise);
    const onSessionId = vi.fn();
    try {
      const started = ctx.manager.start(roomPrompt, "D:/room", {
        roomAbortSignal: controller.signal, onSessionId,
      }).catch((reason: unknown) => reason);
      expect(ctx.ensureReady).toHaveBeenCalledTimes(1);
      controller.abort();
      ready.resolve(readyStatus);
      const error = await started;
      expect(ctx.queryOptions).toHaveLength(0);
      expect(onSessionId).not.toHaveBeenCalled();
      expect(error).toMatchObject({ name: "AbortError" });
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it.each(["signal", "session abort"])("does not open a query after %s in onSessionId", async (cancel) => {
    const controller = new AbortController();
    const ctx = makeRoomHookSession([[roomWrite]]);
    let id = "";
    try {
      const error = await ctx.manager.start(roomPrompt, "D:/room", {
        roomAbortSignal: controller.signal,
        onSessionId(value) {
          id = value;
          if (cancel === "signal") controller.abort();
          else ctx.manager.abort(value);
        },
      }).catch((reason: unknown) => reason);
      expect(id).not.toBe("");
      expect(ctx.queryOptions).toHaveLength(0);
      expect(ctx.manager.list().find((session) => session.id === id)?.status).toBe("idle");
      expect(error).toMatchObject({ name: "AbortError" });
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it.each([false, true])("does not send or open a query after cancelled continue preparation (parked=%s)", async (parked) => {
    const controller = new AbortController();
    const ready = roomDeferred<typeof readyStatus>();
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite]]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room");
      if (parked) ctx.manager.closeSession(id);
      vi.mocked(ctx.cpa.ensureReady).mockReturnValueOnce(ready.promise);
      const continued = ctx.manager.continue(id, roomPrompt, {
        roomAbortSignal: controller.signal,
      }).catch((reason: unknown) => reason);
      controller.abort();
      ready.resolve(readyStatus);
      const error = await continued;
      expect(ctx.queryOptions).toHaveLength(1);
      expect(ctx.outcomes).toHaveLength(1);
      expect(error).toMatchObject({ name: "AbortError" });
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("does not revive a room continue after session abort during CPA preparation", async () => {
    const controller = new AbortController();
    const ready = roomDeferred<typeof readyStatus>();
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite]]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room");
      vi.mocked(ctx.cpa.ensureReady).mockReturnValueOnce(ready.promise);
      const continued = ctx.manager.continue(id, roomPrompt, {
        roomAbortSignal: controller.signal,
      }).catch((reason: unknown) => reason);
      ctx.manager.abort(id);
      ready.resolve(readyStatus);
      const error = await continued;
      expect(ctx.queryOptions).toHaveLength(1);
      expect(ctx.outcomes).toHaveLength(1);
      expect(error).toMatchObject({ name: "AbortError" });
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("aborts the live query and denies late room approval and subsequent tools", async () => {
    const controller = new AbortController();
    const approval = roomDeferred<boolean>();
    const requestRoomWriteAccess = vi.fn(() => approval.promise);
    const ctx = makeRoomHookSession([[roomWrite, { name: "Read", input: { file_path: "a.txt" } }]]);
    try {
      const started = ctx.manager.start(roomPrompt, "D:/room", {
        roomReadOnly: true, roomAbortSignal: controller.signal, requestRoomWriteAccess,
      });
      await vi.waitFor(() => expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1));
      controller.abort();
      approval.resolve(true);
      await started;
      await vi.waitFor(() => expect(ctx.outcomes).toHaveLength(2));
      expect((ctx.queryOptions[0].abortController as AbortController).signal.aborted).toBe(true);
      expect(ctx.outcomes.every((outcome) => !outcome.executed)).toBe(true);
      expect(ctx.permissionBroker.canUseTool).not.toHaveBeenCalled();
    } finally {
      approval.resolve(false);
      ctx.manager.disposeAll();
    }
  });

  it("denies a late permission broker answer for a cancelled writable room turn", async () => {
    const controller = new AbortController();
    const permission = roomDeferred<{ behavior: "allow"; updatedInput: Record<string, unknown> }>();
    const canUseTool = vi.fn(() => permission.promise);
    const ctx = makeRoomHookSession([[roomWrite, roomWrite]], canUseTool);
    try {
      const started = ctx.manager.start(roomPrompt, "D:/room", { roomAbortSignal: controller.signal });
      await vi.waitFor(() => expect(canUseTool).toHaveBeenCalledTimes(1));
      controller.abort();
      permission.resolve({ behavior: "allow", updatedInput: {} });
      await started;
      await vi.waitFor(() => expect(ctx.outcomes).toHaveLength(2));
      expect(ctx.outcomes.every((outcome) => !outcome.executed)).toBe(true);
      expect(canUseTool).toHaveBeenCalledTimes(1);
    } finally {
      permission.resolve({ behavior: "allow", updatedInput: {} });
      ctx.manager.disposeAll();
    }
  });

  it("isolates previous signals from a reused room turn and an ordinary turn", async () => {
    const previous = new AbortController();
    const current = new AbortController();
    const approval = roomDeferred<boolean>();
    const requestRoomWriteAccess = vi.fn(() => approval.promise);
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite], [roomWrite]]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { roomAbortSignal: previous.signal });
      const continued = ctx.manager.continue(id, roomPrompt, {
        roomReadOnly: true, roomAbortSignal: current.signal, requestRoomWriteAccess,
      });
      await vi.waitFor(() => expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1));
      previous.abort();
      expect((ctx.queryOptions[0].abortController as AbortController).signal.aborted).toBe(false);
      approval.resolve(true);
      await continued;
      const permission = roomDeferred<{ behavior: "allow"; updatedInput: Record<string, unknown> }>();
      vi.mocked(ctx.permissionBroker.canUseTool).mockReturnValueOnce(permission.promise);
      const ordinary = ctx.manager.continue(id, roomPrompt);
      await vi.waitFor(() => expect(ctx.permissionBroker.canUseTool).toHaveBeenCalledTimes(3));
      current.abort();
      permission.resolve({ behavior: "allow", updatedInput: {} });
      await ordinary;
      expect(ctx.queryOptions).toHaveLength(1);
      expect(ctx.outcomes.every((outcome) => outcome.executed)).toBe(true);
    } finally {
      approval.resolve(false);
      ctx.manager.disposeAll();
    }
  });

  it("does not let a superseded CPA continuation replace the newer room turn", async () => {
    const previous = new AbortController();
    const current = new AbortController();
    const ready = roomDeferred<typeof readyStatus>();
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite], [roomWrite]]);
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room");
      vi.mocked(ctx.cpa.ensureReady).mockReturnValueOnce(ready.promise);
      const stale = ctx.manager.continue(id, roomPrompt, {
        roomAbortSignal: previous.signal,
      }).catch((reason: unknown) => reason);
      await ctx.manager.continue(id, roomPrompt, { roomAbortSignal: current.signal });
      ready.resolve(readyStatus);
      const error = await stale;
      expect(ctx.outcomes).toHaveLength(2);
      expect(error).toMatchObject({ name: "AbortError" });
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("does not open a query if cancellation arrives while building its options", async () => {
    const controller = new AbortController();
    const ctx = makeRoomHookSession([[roomWrite]]);
    vi.mocked(ctx.buildProcessEnv).mockImplementationOnce(() => {
      controller.abort();
      return {};
    });
    try {
      const error = await ctx.manager.start(roomPrompt, "D:/room", {
        roomAbortSignal: controller.signal, skipCpa: true,
      }).catch((reason: unknown) => reason);
      expect(ctx.queryOptions).toHaveLength(0);
      expect(error).toMatchObject({ name: "AbortError" });
    } finally {
      ctx.manager.disposeAll();
    }
  });

  it("denies stale query hooks while a newer writable room turn is active", async () => {
    const previous = new AbortController();
    const approval = roomDeferred<boolean>();
    const permission = roomDeferred<{ behavior: "allow"; updatedInput: Record<string, unknown> }>();
    const canUseTool = vi.fn(() => permission.promise);
    const requestRoomWriteAccess = vi.fn(() => approval.promise);
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite]], canUseTool);
    let id = "";
    let continued: Promise<void> | undefined;
    try {
      const started = ctx.manager.start(roomPrompt, "D:/room", {
        roomReadOnly: true, roomAbortSignal: previous.signal, requestRoomWriteAccess,
        onSessionId: (value) => { id = value; },
      });
      await vi.waitFor(() => expect(requestRoomWriteAccess).toHaveBeenCalledTimes(1));
      previous.abort();
      await started;
      continued = ctx.manager.continue(id, roomPrompt, { roomAbortSignal: new AbortController().signal });
      await vi.waitFor(() => expect(canUseTool).toHaveBeenCalledTimes(1));
      const oldOptions = ctx.queryOptions[0];
      const hook = (oldOptions.hooks as { PreToolUse: Array<{ hooks: PreToolHook[] }> }).PreToolUse[0].hooks[0];
      const result = await hook({ tool_name: "Read", tool_input: { file_path: "a.txt" } }, "stale-tool", {
        signal: (oldOptions.abortController as AbortController).signal,
      });
      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny");
    } finally {
      approval.resolve(false);
      permission.resolve({ behavior: "allow", updatedInput: {} });
      await continued;
      ctx.manager.disposeAll();
    }
  });

  it.each(["cancel", "new turn"])("does not auto-continue after %s while compression is pending", async (action) => {
    const controller = new AbortController();
    const compressed = roomDeferred<import("./context-compressor").CompressionResult>();
    const compressor = { compress: vi.fn(() => compressed.promise) };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-room-abort-"));
    const archive = new SessionArchive(dir);
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite], [roomWrite]], undefined, { archive, compressor });
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { roomAbortSignal: controller.signal });
      const items = Array.from({ length: 10 }, (_, i) => ({
        kind: "text" as const, id: `room-abort-${i}`, role: "user" as const, text: `message ${i}`,
      }));
      ctx.manager.saveTranscript(id, items, { replace: true });
      const compacting = ctx.manager.compressSession(id, undefined, { autoContinue: true });
      expect(compressor.compress).toHaveBeenCalledTimes(1);
      if (action === "cancel") controller.abort();
      else await ctx.manager.continue(id, roomPrompt, { roomAbortSignal: new AbortController().signal });
      const queryCount = ctx.queryOptions.length;
      const turnCount = ctx.outcomes.length;
      const transcript = ctx.manager.getTranscript(id);
      compressed.resolve({ items: items.slice(0, 1), summaryText: "summary", compressedCount: 9 });
      expect((await compacting).ok).toBe(false);
      expect(ctx.queryOptions).toHaveLength(queryCount);
      expect(ctx.outcomes).toHaveLength(turnCount);
      expect(ctx.manager.getTranscript(id)).toEqual(transcript);
    } finally {
      ctx.manager.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a successful room auto-continuation cancellable", async () => {
    const controller = new AbortController();
    const permission = roomDeferred<{ behavior: "allow"; updatedInput: Record<string, unknown> }>();
    const compressor = {
      compress: async (items: import("@claude-desktop/shared").ChatItem[]) => ({
        items: items.slice(0, 1), summaryText: "summary", compressedCount: 9,
      }),
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-room-auto-abort-"));
    const ctx = makeRoomHookSession([[roomWrite], [roomWrite]], undefined, {
      archive: new SessionArchive(dir), compressor,
    });
    try {
      const id = await ctx.manager.start(roomPrompt, "D:/room", { roomAbortSignal: controller.signal });
      ctx.manager.saveTranscript(id, Array.from({ length: 10 }, (_, i) => ({
        kind: "text" as const, id: `room-auto-${i}`, role: "user" as const, text: `message ${i}`,
      })), { replace: true });
      vi.mocked(ctx.permissionBroker.canUseTool).mockReturnValueOnce(permission.promise);
      expect((await ctx.manager.compressSession(id, undefined, { autoContinue: true })).ok).toBe(true);
      await vi.waitFor(() => expect(ctx.permissionBroker.canUseTool).toHaveBeenCalledTimes(2));
      controller.abort();
      permission.resolve({ behavior: "allow", updatedInput: {} });
      await vi.waitFor(() => expect(ctx.outcomes).toHaveLength(2));
      expect(ctx.queryOptions).toHaveLength(2);
      expect((ctx.queryOptions[1].abortController as AbortController).signal.aborted).toBe(true);
      expect(ctx.outcomes[1].executed).toBe(false);
    } finally {
      permission.resolve({ behavior: "allow", updatedInput: {} });
      ctx.manager.disposeAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function getSessionId(manager: SessionManager): Promise<string> {
  const list = manager.list();
  if (list[0]) return list[0].id;
  throw new Error("no session");
}
