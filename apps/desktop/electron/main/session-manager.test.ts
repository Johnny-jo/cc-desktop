import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppSettings, FileChange, SdkNormalizedEvent, SessionSummary } from "@claude-desktop/shared";
import type { QueryFn } from "./session-manager";
import { SessionManager, humanizeAgentError } from "./session-manager";
import type { PermissionBroker } from "./permission-broker";
import type { DiffTracker } from "./diff-tracker";
import type { CpaSupervisor } from "./cpa-supervisor";
import type { SettingsStore } from "./settings-store";
import { SessionArchive } from "./session-archive";

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
  queryFn?: QueryFn;
  ensureReady?: () => Promise<{ state: string; message?: string; port?: number; managedByApp?: boolean }>;
  canUseTool?: ReturnType<typeof vi.fn>;
  onToolUse?: ReturnType<typeof vi.fn>;
  listDiffs?: ReturnType<typeof vi.fn>;
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
  const diffTracker = {
    onToolUse,
    list: listDiffs,
    remove: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    findByEvent: vi.fn().mockReturnValue(null),
    truncateAt: vi.fn(),
    refreshBashWritesFromDisk: vi.fn().mockResolvedValue(undefined),
    captureBashBaseline: vi.fn().mockResolvedValue(undefined),
  } as unknown as DiffTracker;

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
    queryFn,
    permissionBroker,
    diffTracker,
    cpa,
    settings,
    emit,
    emitSession,
    emitDiff,
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

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      | ((name: string, input: Record<string, unknown>) => Promise<unknown>)
      | undefined;

    const queryFn: QueryFn = async function* (args) {
      passedCanUseTool = args.options.canUseTool as typeof passedCanUseTool;
      await takeFirstUserText(args.prompt);
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };

    const ctx = makeDeps({ queryFn, canUseTool });
    const sessionId = await ctx.manager.start({ text: "hi", attachments: [] }, "D:/p");

    expect(passedCanUseTool).toBeTypeOf("function");
    await passedCanUseTool!("Read", { file_path: "a" });
    expect(canUseTool).toHaveBeenCalledWith("Read", { file_path: "a" }, sessionId);
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
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };

    const ctx = makeDeps({ queryFn, onToolUse, listDiffs });
    const sessionId = await ctx.manager.start({ text: "edit please", attachments: [] }, "D:/p");

    expect(onToolUse).toHaveBeenCalledWith(
      sessionId,
      "Edit",
      expect.objectContaining({ file_path: "src/a.ts" }),
      expect.objectContaining({ cwd: "D:/p" }),
    );
    expect(ctx.emitDiff).toHaveBeenCalledWith(sessionId, changes);
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

  it("abort aborts the active AbortController", async () => {
    let controller: AbortController | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queryFn: QueryFn = async function* (args) {
      controller = args.options.abortController as AbortController;
      await takeFirstUserText(args.prompt);
      await gate;
      // After abort/release, end the turn so waitForTurnIdle unblocks
      yield { type: "result", subtype: "success", total_cost_usd: 0 };
    };

    const ctx = makeDeps({ queryFn });
    const startPromise = ctx.manager.start({ text: "slow", attachments: [] }, "D:/p");

    // allow start to reach queryFn
    await vi.waitFor(() => {
      expect(controller).toBeDefined();
    });

    const id = ctx.manager.list()[0]?.id;
    expect(id).toBeTruthy();
    ctx.manager.abort(id!);
    expect(controller!.signal.aborted).toBe(true);
    release();
    await startPromise;
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

    const disk = archive.loadItems(sessionId);
    expect(disk.some((i) => i.kind === "text" && i.role === "user")).toBe(true);
    expect(disk.some((i) => i.kind === "text" && i.role === "assistant")).toBe(true);
    // streaming flags stripped on disk
    expect(disk.filter((i) => i.kind === "text").every((i) => i.kind === "text" && !i.streaming)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

async function getSessionId(manager: SessionManager): Promise<string> {
  const list = manager.list();
  if (list[0]) return list[0].id;
  throw new Error("no session");
}
