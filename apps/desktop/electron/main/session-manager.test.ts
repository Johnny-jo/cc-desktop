import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AppSettings, FileChange, SdkNormalizedEvent, SessionSummary } from "@claude-desktop/shared";
import type { QueryFn } from "./session-manager";
import {
  MAX_HYDRATED_CHANGES,
  MAX_HYDRATED_TRANSCRIPTS,
  SessionManager,
  humanizeAgentError,
} from "./session-manager";
import type { PermissionBroker } from "./permission-broker";
import { DiffTracker } from "./diff-tracker";
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
  queryFn?: QueryFn;
  ensureReady?: () => Promise<{ state: string; message?: string; port?: number; managedByApp?: boolean }>;
  canUseTool?: ReturnType<typeof vi.fn>;
  onToolUse?: ReturnType<typeof vi.fn>;
  listDiffs?: ReturnType<typeof vi.fn>;
  diffTracker?: DiffTracker;
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

async function getSessionId(manager: SessionManager): Promise<string> {
  const list = manager.list();
  if (list[0]) return list[0].id;
  throw new Error("no session");
}
