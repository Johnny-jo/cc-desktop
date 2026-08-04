import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppSettings, FileChange, SdkNormalizedEvent, SessionSummary } from "@claude-desktop/shared";
import type { QueryFn } from "./session-manager";
import { SessionManager, humanizeAgentError } from "./session-manager";
import type { PermissionBroker } from "./permission-broker";
import type { DiffTracker } from "./diff-tracker";
import type { CpaSupervisor } from "./cpa-supervisor";
import type { SettingsStore } from "./settings-store";

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
    const sessionId = await ctx.manager.start("hello", "D:/proj");

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
    const sessionId = await ctx.manager.start("prompt-1", "D:/work");

    expect(captured).toHaveLength(1);
    // Streaming mode: prompt is AsyncIterable, not a raw string
    expect(typeof captured[0].prompt !== "string").toBe(true);
    const opts = captured[0].options;
    expect(opts.cwd).toBe("D:/work");
    expect(opts.includePartialMessages).toBe(true);
    expect(opts.permissionMode).toBe("default");
    // tools = availability; allowedTools = auto-allow (read-only) so canUseTool still gates writes
    expect(opts.tools).toEqual([
      "Read",
      "Edit",
      "Write",
      "Bash",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
    ]);
    expect(opts.allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch",
    ]);
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
    const sessionId = await ctx.manager.start("hi", "D:/p");

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
        events: [{ tool: "Edit", at: 1, hunk: "+b" }],
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
    const sessionId = await ctx.manager.start("edit please", "D:/p");

    expect(onToolUse).toHaveBeenCalledWith(
      sessionId,
      "Edit",
      expect.objectContaining({ file_path: "src/a.ts" }),
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
    const sessionId = await ctx.manager.start("first", "D:/p");
    await ctx.manager.continue(sessionId, "second");

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
    const startPromise = ctx.manager.start("slow", "D:/p");

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

    await expect(ctx.manager.start("hi", "D:/p")).rejects.toThrow(/CPA/i);
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
    const id = await ctx.manager.start("title prompt", "D:/proj");
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
});

async function getSessionId(manager: SessionManager): Promise<string> {
  const list = manager.list();
  if (list[0]) return list[0].id;
  throw new Error("no session");
}
