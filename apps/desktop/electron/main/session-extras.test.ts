import { describe, expect, it, vi } from "vitest";
import type { QueryFn } from "./session-manager";
import { SessionManager } from "./session-manager";
import type { PermissionBroker } from "./permission-broker";
import type { DiffTracker } from "./diff-tracker";
import type { CpaSupervisor } from "./cpa-supervisor";
import type { SettingsStore } from "./settings-store";
import { mergeSessionRunOpts } from "./mod-kernel-compile";

async function takeFirstUserText(
  prompt: string | AsyncIterable<unknown>,
): Promise<void> {
  if (typeof prompt === "string") return;
  for await (const _msg of prompt) break;
}

function queryFn(): QueryFn {
  return async function* (args) {
    await takeFirstUserText(args.prompt);
    yield { type: "result", subtype: "success", total_cost_usd: 0 };
  };
}

function manager(qf: QueryFn = queryFn()): SessionManager {
  return new SessionManager({
    queryFn: qf,
    permissionBroker: { canUseTool: vi.fn() } as unknown as PermissionBroker,
    diffTracker: {
      onToolUse: vi.fn(),
      list: vi.fn().mockReturnValue([]),
    } as unknown as DiffTracker,
    cpa: {
      ensureReady: vi.fn().mockResolvedValue({
        state: "ready",
        port: 8317,
        managedByApp: false,
      }),
      buildProcessEnv: vi.fn().mockReturnValue({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      }),
    } as unknown as CpaSupervisor,
    settings: {
      get: vi.fn().mockReturnValue({
        defaultModel: "kimi-for-coding",
        permissionMode: "default",
        defaultContextLimit: 200_000,
        modelContextLimits: {},
        models: [],
        mcpServers: {},
        pluginPaths: [],
        agents: [],
      }),
    } as unknown as SettingsStore,
    emit: vi.fn(),
    emitSession: vi.fn(),
    emitDiff: vi.fn(),
  });
}

describe("mergeSessionRunOpts", () => {
  it("unions keys so empty kernel extras do not wipe room-mod", () => {
    const merged = mergeSessionRunOpts(
      { extraMcpServers: { "room-mod": { kind: "play" } }, extraAllowedTools: ["room_mod_act"] },
      {},
    );
    expect(Object.keys(merged.extraMcpServers ?? {})).toEqual(["room-mod"]);
    expect(merged.extraAllowedTools).toEqual(["room_mod_act"]);
  });
});

describe("SessionManager extras replace / sync", () => {
  it("replaceExtras drops disappeared servers; default continue only adds", async () => {
    const sm = manager();
    const id = await sm.start(
      { text: "hi", attachments: [] },
      "D:/p",
      { extraMcpServers: { a: 1, b: 2 }, extraAllowedTools: ["A", "B"] },
    );
    await sm.continue(
      id,
      { text: "keep-add", attachments: [] },
      { extraMcpServers: { c: 3 }, extraAllowedTools: ["C"] },
    );
    await sm.continue(
      id,
      { text: "replace", attachments: [] },
      {
        replaceExtras: true,
        extraMcpServers: { a: 1 },
        extraAllowedTools: ["A"],
      },
    );
    const entry = (sm as unknown as { sessions: Map<string, { extraMcpServers?: Record<string, unknown>; extraAllowedTools?: string[] }> }).sessions.get(id);
    expect(Object.keys(entry?.extraMcpServers ?? {}).sort()).toEqual(["a"]);
    expect(entry?.extraAllowedTools).toEqual(["A"]);
  });

  it("syncExtras aborts the live stream when a server is removed", async () => {
    const sm = manager();
    const id = await sm.start(
      { text: "hi", attachments: [] },
      "D:/p",
      { extraMcpServers: { "mod-memory": { n: 1 } }, extraAllowedTools: ["memory_set"] },
    );
    const before = (sm as unknown as { sessions: Map<string, { streamGen: number }> }).sessions.get(id)!.streamGen;
    sm.syncExtras(id, { extraMcpServers: {}, extraAllowedTools: [] });
    const after = (sm as unknown as { sessions: Map<string, { streamGen: number; extraMcpServers?: Record<string, unknown> }> }).sessions.get(id)!;
    expect(Object.keys(after.extraMcpServers ?? {})).toEqual([]);
    expect(after.streamGen).toBe(before + 1);
  });
});

type CapturedOptions = {
  hooks?: {
    PreToolUse?: Array<{
      hooks: Array<(input: unknown) => Promise<Record<string, unknown>>>;
    }>;
  };
};

function capturingQueryFn(captured: { options?: CapturedOptions }): QueryFn {
  return async function* (args) {
    captured.options = args.options as CapturedOptions;
    await takeFirstUserText(args.prompt);
    yield { type: "result", subtype: "success", total_cost_usd: 0 };
  };
}

async function preToolUse(
  options: CapturedOptions,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  expect(hook).toBeTruthy();
  return hook!({ tool_name: toolName, tool_input: input });
}

describe("pathJail PreToolUse hook（只读工具也拦）", () => {
  it("越界 Read 被 deny，区内路径放行", async () => {
    const captured: { options?: CapturedOptions } = {};
    const sm = manager(capturingQueryFn(captured));
    await sm.start(
      { text: "hi", attachments: [] },
      "D:/p",
      { pathJail: "D:/p" },
    );
    const out = await preToolUse(captured.options!, "Read", {
      file_path: "D:/other/secrets.txt",
    }) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");

    const inside = await preToolUse(captured.options!, "Read", {
      file_path: "D:/p/src/a.ts",
    });
    expect(inside).toEqual({});

    const rel = await preToolUse(captured.options!, "Edit", {
      file_path: "../escape.ts",
    }) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(rel.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(rel.hookSpecificOutput?.permissionDecisionReason).toContain("已拒绝");
  });

  it("无 pathJail 的会话 hook 完全放行", async () => {
    const captured: { options?: CapturedOptions } = {};
    const sm = manager(capturingQueryFn(captured));
    await sm.start({ text: "hi", attachments: [] }, "D:/p");
    const out = await preToolUse(captured.options!, "Read", {
      file_path: "D:/other/secrets.txt",
    });
    expect(out).toEqual({});
  });

  it("continue 带上 pathJail 后围栏立即生效", async () => {
    const captured: { options?: CapturedOptions } = {};
    const sm = manager(capturingQueryFn(captured));
    const id = await sm.start({ text: "hi", attachments: [] }, "D:/p");
    await sm.continue(
      id,
      { text: "next", attachments: [] },
      { pathJail: "D:/p" },
    );
    const entry = (sm as unknown as {
      sessions: Map<string, { pathJail?: string }>;
    }).sessions.get(id);
    expect(entry?.pathJail).toBe("D:/p");
    const out = await preToolUse(captured.options!, "Glob", {
      pattern: "**/*",
      path: "D:/other",
    }) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
