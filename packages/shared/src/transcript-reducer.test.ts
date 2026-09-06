import { describe, expect, it } from "vitest";
import type { ChatItem, SdkNormalizedEvent, ToolCardState } from "./models";
import { rebuildSessionProgress } from "./session-progress";
import {
  applySdkEvent,
  bindSdkUserMsgIds,
  createIdFactory,
  emptyTranscript,
  shouldPersistTranscript,
  type TranscriptState,
} from "./transcript-reducer";

function ids() {
  let n = 0;
  return (prefix: string) => `${prefix}-fixed-${++n}`;
}

function apply(state: TranscriptState, event: SdkNormalizedEvent): TranscriptState {
  return applySdkEvent(state, event, { nextId: ids() });
}

describe("applySdkEvent", () => {
  it("appends user_message", () => {
    const next = apply(emptyTranscript(), {
      type: "user_message",
      sessionId: "s",
      text: "hi",
    });
    expect(next.items).toEqual([
      { kind: "text", id: "user-fixed-1", role: "user", text: "hi" },
    ]);
  });

  it("drops optimistic echo", () => {
    const start: TranscriptState = {
      items: [{ kind: "text", id: "u1", role: "user", text: "hi" }],
      optimisticUserTexts: ["hi"],
    };
    const next = apply(start, { type: "user_message", sessionId: "s", text: "hi" });
    expect(next.items).toHaveLength(1);
    expect(next.optimisticUserTexts).toEqual([]);
  });

  it("drops post-compact continuation prefix", () => {
    const next = apply(emptyTranscript(), {
      type: "user_message",
      sessionId: "s",
      text: "This session is being continued from a previous conversation that ran out of context.",
    });
    expect(next.items).toEqual([]);
  });

  it("drops Earlier conversation summary prefix", () => {
    const next = apply(emptyTranscript(), {
      type: "user_message",
      sessionId: "s",
      text: "Earlier conversation summary:\nfoo",
    });
    expect(next.items).toEqual([]);
  });

  it("drops duplicate user text already in items", () => {
    const start: TranscriptState = {
      items: [{ kind: "text", id: "u1", role: "user", text: "hi" }],
      optimisticUserTexts: [],
    };
    const next = apply(start, { type: "user_message", sessionId: "s", text: "hi" });
    expect(next.items).toHaveLength(1);
  });

  it("shows a thinking placeholder then replaces it with the first text_delta", () => {
    let s = apply(emptyTranscript(), {
      type: "thinking_delta",
      sessionId: "s",
      text: "",
    });
    expect(s.items[0]).toMatchObject({
      role: "assistant",
      thinking: true,
      streaming: true,
      text: "",
    });
    s = apply(s, { type: "thinking_delta", sessionId: "s", text: "more" });
    expect(s.items).toHaveLength(1);
    s = apply(s, { type: "text_delta", sessionId: "s", text: "Hi" });
    expect(s.items[0]).toMatchObject({
      role: "assistant",
      text: "Hi",
      streaming: true,
    });
    expect(s.items[0]).not.toHaveProperty("thinking", true);
  });

  it("accumulates thinkingText and keeps it collapsed after the answer starts", () => {
    let s = apply(emptyTranscript(), {
      type: "thinking_delta",
      sessionId: "s",
      text: "先想",
    });
    s = apply(s, { type: "thinking_delta", sessionId: "s", text: "一想" });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      role: "assistant",
      thinking: true,
      streaming: true,
      thinkingText: "先想一想",
    });
    s = apply(s, { type: "text_delta", sessionId: "s", text: "答" });
    expect(s.items[0]).toMatchObject({
      text: "答",
      thinkingText: "先想一想",
      streaming: true,
    });
    expect(s.items[0]).not.toHaveProperty("thinking", true);
    // Late thinking deltas after the answer started are ignored.
    s = apply(s, { type: "thinking_delta", sessionId: "s", text: "迟到" });
    expect(s.items[0]).toMatchObject({ thinkingText: "先想一想" });
    // Result settles the turn but keeps the thinking content.
    s = apply(s, { type: "result", sessionId: "s", ok: true });
    expect(s.items[0]).toMatchObject({
      text: "答",
      thinkingText: "先想一想",
      streaming: false,
    });
  });

  it("deduplicates a completed thinking block after partial deltas", () => {
    let s = apply(emptyTranscript(), {
      type: "thinking_delta",
      sessionId: "s",
      text: "先检查",
    });
    s = apply(s, {
      type: "thinking_delta",
      sessionId: "s",
      text: "先检查调用链",
    });
    expect(s.items[0]).toMatchObject({ thinkingText: "先检查调用链" });
  });

  it("settles and folds thinking as soon as a tool starts", () => {
    let s = apply(emptyTranscript(), {
      type: "thinking_delta",
      sessionId: "s",
      text: "需要先读文件",
    });
    s = apply(s, {
      type: "tool_start",
      sessionId: "s",
      tool: {
        id: "read-1",
        name: "Read",
        summary: "a.ts",
        status: "running",
      },
    });
    expect(s.items[0]).toMatchObject({
      role: "assistant",
      thinkingText: "需要先读文件",
      streaming: false,
    });
    expect(s.items[0]).not.toHaveProperty("thinking", true);
  });

  it("streams text_delta then settles on text_done", () => {
    let s = apply(emptyTranscript(), {
      type: "text_delta",
      sessionId: "s",
      text: "Hel",
    });
    s = apply(s, { type: "text_delta", sessionId: "s", text: "lo" });
    expect(s.items[0]).toMatchObject({
      role: "assistant",
      text: "Hello",
      streaming: true,
    });
    s = apply(s, { type: "text_done", sessionId: "s", text: "Hello" });
    expect(s.items[0]).toMatchObject({ text: "Hello", streaming: false });
  });

  it("result settles a streaming assistant left behind after tools", () => {
    let s = apply(emptyTranscript(), {
      type: "text_delta",
      sessionId: "s",
      text: "**hello**",
    });
    s = apply(s, {
      type: "tool_start",
      sessionId: "s",
      tool: {
        id: "t1",
        name: "Read",
        summary: "a.ts",
        status: "running",
      },
    });
    expect(s.items[0]).toMatchObject({ streaming: true, text: "**hello**" });
    s = apply(s, { type: "result", sessionId: "s", ok: true });
    expect(s.items[0]).toMatchObject({ streaming: false, text: "**hello**" });
    expect(s.items[0]).not.toHaveProperty("thinking", true);
  });

  it("tool start drops an empty thinking placeholder", () => {
    let s = apply(emptyTranscript(), {
      type: "thinking_delta",
      sessionId: "s",
      text: "",
    });
    s = apply(s, {
      type: "tool_start",
      sessionId: "s",
      tool: {
        id: "t1",
        name: "Bash",
        summary: "ls",
        status: "running",
      },
    });
    expect(s.items.some((i) => i.kind === "text" && i.role === "assistant")).toBe(
      false,
    );
    s = apply(s, { type: "result", sessionId: "s", ok: true });
    expect(s.items.some((i) => i.kind === "text" && i.role === "assistant")).toBe(
      false,
    );
  });

  it("text_done prefers the longer streamed text", () => {
    let s = apply(emptyTranscript(), {
      type: "text_delta",
      sessionId: "s",
      text: "Hello world",
    });
    s = apply(s, { type: "text_done", sessionId: "s", text: "Hello" });
    expect(s.items[0]).toMatchObject({ text: "Hello world", streaming: false });
  });

  it("merges tool_end onto tool_start and keeps todos", () => {
    const tool: ToolCardState = {
      id: "t1",
      name: "TodoWrite",
      summary: "plan",
      status: "running",
      todos: [{ content: "a", status: "pending" }],
      isSubagent: true,
    };
    let s = apply(emptyTranscript(), { type: "tool_start", sessionId: "s", tool });
    s = apply(s, {
      type: "tool_end",
      sessionId: "s",
      tool: {
        id: "t1",
        name: "tool",
        summary: "",
        status: "done",
      },
    });
    const item = s.items[0];
    expect(item.kind).toBe("tool");
    if (item.kind === "tool") {
      expect(item.tool.name).toBe("TodoWrite");
      expect(item.tool.summary).toBe("plan");
      expect(item.tool.status).toBe("done");
      expect(item.tool.todos).toEqual([{ content: "a", status: "pending" }]);
      expect(item.tool.isSubagent).toBe(true);
    }
  });

  it("updates tool_progress elapsedSeconds", () => {
    let s = apply(emptyTranscript(), {
      type: "tool_start",
      sessionId: "s",
      tool: { id: "t1", name: "Bash", summary: "ls", status: "running" },
    });
    s = apply(s, {
      type: "tool_progress",
      sessionId: "s",
      toolUseId: "t1",
      toolName: "Bash",
      elapsedSeconds: 4,
    });
    const item = s.items[0];
    expect(item.kind).toBe("tool");
    if (item.kind === "tool") expect(item.tool.elapsedSeconds).toBe(4);
  });

  it("result settles stream, appends error and usage", () => {
    let s = apply(emptyTranscript(), {
      type: "text_delta",
      sessionId: "s",
      text: "x",
    });
    s = apply(s, {
      type: "result",
      sessionId: "s",
      ok: false,
      error: "boom",
      usage: { outputTokens: 3 },
    });
    expect(s.items[0]).toMatchObject({ streaming: false, text: "x" });
    expect(s.items[1]).toMatchObject({ role: "system", text: "boom" });
    expect(s.items[2]).toMatchObject({ kind: "usage", usage: { outputTokens: 3 } });
  });

  it("items_replaced swaps the table", () => {
    const replacement: ChatItem[] = [
      { kind: "text", id: "sum", role: "system", text: "summary" },
    ];
    const next = apply(
      { items: [{ kind: "text", id: "old", role: "user", text: "x" }], optimisticUserTexts: [] },
      { type: "items_replaced", sessionId: "s", items: replacement },
    );
    expect(next.items).toEqual(replacement);
  });

  it("appends one persisted per-turn file changes item", () => {
    const item: ChatItem = {
      kind: "changes",
      id: "changes-1",
      files: [
        { path: "src/a.ts", additions: 3, deletions: 1, line: 12 },
      ],
    };
    if (item.kind !== "changes") throw new Error("invalid fixture");
    const event = { type: "turn_changes" as const, sessionId: "s", item };
    const once = apply(emptyTranscript(), event);
    const twice = apply(once, event);
    expect(once.items).toEqual([item]);
    expect(twice.items).toEqual([item]);
  });

  it("user_msg_ids does not change items", () => {
    const start = emptyTranscript();
    const next = apply(start, { type: "user_msg_ids", sessionId: "s", uuids: ["u"] });
    expect(next.items).toEqual([]);
  });
});

describe("progress-bearing transcript tools", () => {
  const tool: ToolCardState = {
    id: "agent-call", name: "Agent", summary: "检查", status: "running",
    parentToolUseId: "parent",
    agent: { id: "agent-call", toolUseId: "agent-call", parentToolUseId: "parent", title: "检查", status: "running", background: true },
  };

  it("merges task input fields with a sparse creation result", () => {
    let state = apply(emptyTranscript(), { type: "tool_start", sessionId: "s", tool: {
      id: "create", name: "TaskCreate", summary: "测试", status: "running", parentToolUseId: "parent",
      task: { operation: "create", patch: { title: "测试", status: "pending", description: "详情" } },
    } });
    state = apply(state, { type: "tool_end", sessionId: "s", tool: {
      id: "create", name: "tool", summary: "", status: "done", parentToolUseId: undefined,
      task: { operation: "create", taskId: "7", success: true },
    } });
    expect(state.items[0]).toMatchObject({ tool: {
      parentToolUseId: "parent",
      task: { operation: "create", taskId: "7", success: true, patch: { title: "测试", status: "pending", description: "详情" } },
    } });
  });

  it("writes canonical agent ID and terminal state into its original tool", () => {
    const start = apply(emptyTranscript(), { type: "tool_start", sessionId: "s", tool });
    const event: SdkNormalizedEvent = { type: "agent_progress", sessionId: "s", agent: { id: "agent-real", toolUseId: "agent-call", status: "completed", summary: "完成报告", elapsedSeconds: 12 } };
    const next = apply(start, event);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ id: "agent-call", tool: { status: "done", parentToolUseId: "parent", agent: {
      id: "agent-real", toolUseId: "agent-call", title: "检查", status: "completed", summary: "完成报告", elapsedSeconds: 12, background: true,
    } } });
    expect(shouldPersistTranscript(event)).toBe(true);
    expect(start.items[0]).toMatchObject({ tool: { agent: { status: "running" } } });
  });

  it("retains terminal lifecycle data across late heartbeats and repeated tool starts", () => {
    let state = apply(emptyTranscript(), { type: "tool_start", sessionId: "s", tool });
    state = apply(state, { type: "agent_progress", sessionId: "s", agent: { id: "agent-real", toolUseId: "agent-call", status: "failed", summary: "失败原因" } });
    const late = apply(state, { type: "tool_progress", sessionId: "s", toolUseId: "agent-call", toolName: "Agent", elapsedSeconds: 4 });
    expect(late).toBe(state);
    const repeated = apply(late, { type: "tool_start", sessionId: "s", tool });
    expect(repeated.items[0]).toMatchObject({ tool: { status: "error", agent: { id: "agent-real", status: "failed", summary: "失败原因" } } });
  });

  it("does not revive completed ordinary tools on late tool_progress", () => {
    const state = apply(emptyTranscript(), { type: "tool_end", sessionId: "s", tool: { id: "read", name: "Read", summary: "file", status: "done" } });
    expect(apply(state, { type: "tool_progress", sessionId: "s", toolUseId: "read", toolName: "Read", elapsedSeconds: 2 })).toBe(state);
  });

  it("keeps lifecycle events replayable when a tool_start was not retained", () => {
    const next = apply(emptyTranscript(), { type: "agent_progress", sessionId: "s", agent: { id: "known-agent", toolUseId: "missing-call", title: "后台检查", status: "running" } });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ kind: "tool", tool: { id: "missing-call", name: "Agent", agent: { id: "known-agent", status: "running", title: "后台检查" } } });
  });

  it("does not clear optional input fields when a result patch contains undefined", () => {
    let state = apply(emptyTranscript(), { type: "tool_start", sessionId: "s", tool: {
      id: "create", name: "TaskCreate", summary: "测试", status: "running",
      task: { operation: "create", patch: { title: "测试", description: "详情", status: "pending" } },
    } });
    state = apply(state, { type: "tool_end", sessionId: "s", tool: {
      id: "create", name: "TaskCreate", summary: "", status: "done",
      task: { operation: "create", taskId: "7", success: true, patch: { description: undefined } },
    } });
    expect(state.items[0]).toMatchObject({ tool: { task: { patch: { description: "详情" } } } });
  });

  it("preserves the terminal report when a background launch reply arrives late", () => {
    let state = apply(emptyTranscript(), { type: "tool_start", sessionId: "s", tool });
    state = apply(state, { type: "agent_progress", sessionId: "s", agent: { id: "agent-real", toolUseId: "agent-call", status: "completed", summary: "最终报告" } });
    state = apply(state, { type: "tool_end", sessionId: "s", tool: { ...tool, status: "done", resultPreview: "launched" } });
    expect(state.items[0]).toMatchObject({ tool: { status: "done", resultPreview: "最终报告", agent: { status: "completed", summary: "最终报告" } } });
  });

  it("consolidates an ID-only lifecycle placeholder into the real invocation on linkage", () => {
    let state = apply(emptyTranscript(), { type: "tool_start", sessionId: "s", tool });
    state = apply(state, { type: "text_done", sessionId: "s", text: "继续主聊天" });
    state = apply(state, { type: "agent_progress", sessionId: "s", agent: { id: "agent-real", title: "检查", status: "completed", summary: "最终报告" } });
    expect(state.items.filter((item) => item.kind === "tool")).toHaveLength(2);
    state = apply(state, { type: "tool_end", sessionId: "s", tool: { ...tool, status: "done", resultPreview: "launched", agent: { ...tool.agent!, id: "agent-real" } } });
    expect(state.items.map((item) => item.id)).toEqual(["agent-call", "asst-fixed-1"]);
    expect(state.items[0]).toMatchObject({ tool: { status: "done", resultPreview: "最终报告", agent: { id: "agent-real", toolUseId: "agent-call", status: "completed", summary: "最终报告" } } });
    expect(rebuildSessionProgress(state.items)?.agents).toHaveLength(1);
  });

  it("updates all linked historical invocations on completion", () => {
    const first = { ...tool, id: "call-1", agent: { ...tool.agent!, id: "agent-real", toolUseId: "call-1" } };
    const second = { ...tool, id: "call-2", agent: { ...tool.agent!, id: "agent-real", toolUseId: "call-2" } };
    const state: TranscriptState = { optimisticUserTexts: [], items: [
      { kind: "tool", id: first.id, tool: first },
      { kind: "tool", id: second.id, tool: second },
    ] };
    const next = apply(state, { type: "agent_progress", sessionId: "s", agent: { id: "agent-real", status: "completed", summary: "完成" } });
    expect(next.items.map((item) => item.id)).toEqual(["call-1", "call-2"]);
    for (const item of next.items) expect(item).toMatchObject({ tool: { status: "done", agent: { id: "agent-real", status: "completed", summary: "完成" } } });
  });
});

describe("task application order", () => {
  const created: ToolCardState = {
    id: "create", name: "TaskCreate", summary: "任务", status: "done",
    task: { operation: "create", taskId: "7", patch: { title: "任务", status: "pending" }, success: true },
  };
  const slow: ToolCardState = {
    id: "slow", name: "TaskUpdate", summary: "更新", status: "running",
    task: { operation: "update", taskId: "7", patch: { status: "in_progress" } },
  };
  const fast: ToolCardState = {
    id: "fast", name: "TaskUpdate", summary: "更新", status: "running",
    task: { operation: "update", taskId: "7", patch: { status: "completed" } },
  };
  const end = (tool: ToolCardState): SdkNormalizedEvent => ({
    type: "tool_end", sessionId: "s", tool: { ...tool, status: "done", task: { ...tool.task!, success: true } },
  });
  function outOfOrder(): TranscriptState {
    let state = apply(emptyTranscript(), end(created));
    state = apply(state, { type: "tool_start", sessionId: "s", tool: slow });
    state = apply(state, { type: "text_done", sessionId: "s", text: "并行更新" });
    state = apply(state, { type: "tool_start", sessionId: "s", tool: fast });
    state = apply(state, end(fast));
    return apply(state, end(slow));
  }

  it("records completion order while preserving tool and text positions", () => {
    const state = outOfOrder();
    expect(state.items.map((item) => item.id)).toEqual(["create", "slow", "asst-fixed-1", "fast"]);
    const tools = state.items.filter((item) => item.kind === "tool");
    expect(tools.map((item) => item.tool.task?.appliedOrder)).toEqual([1, 3, 2]);
    expect(rebuildSessionProgress(JSON.parse(JSON.stringify(state.items)))?.tasks[0].status).toBe("in_progress");
  });

  it("does not assign a newer application order to an identical repeated tool_end", () => {
    const state = outOfOrder();
    const duplicate = apply(state, JSON.parse(JSON.stringify(end(fast))));
    const item = duplicate.items.find((entry) => entry.kind === "tool" && entry.tool.id === "fast");
    expect(item).toMatchObject({ tool: { task: { appliedOrder: 2 } } });
    expect(rebuildSessionProgress(duplicate.items)?.tasks[0].status).toBe("in_progress");
    expect(duplicate.items.map((entry) => entry.id)).toEqual(state.items.map((entry) => entry.id));
  });

  it("allocates after retained orders when the reducer resumes a serialized transcript", () => {
    const state = outOfOrder();
    const resumed: TranscriptState = { items: JSON.parse(JSON.stringify(state.items)), optimisticUserTexts: [] };
    const next = apply(resumed, end({ ...fast, id: "later" }));
    expect(next.items.at(-1)).toMatchObject({ tool: { task: { appliedOrder: 4 } } });
    expect(rebuildSessionProgress(next.items)?.tasks[0].status).toBe("completed");
  });
});

describe("bindSdkUserMsgIds", () => {
  it("aligns uuids from the end so a tail window binds latest turns", () => {
    const items: ChatItem[] = [
      { kind: "text", id: "u-new", role: "user", text: "b" },
    ];
    const bound = bindSdkUserMsgIds(items, ["old", "new"]);
    expect(bound[0]).toMatchObject({ sdkMsgId: "new" });
  });
});

describe("createIdFactory", () => {
  it("uses prefix-timestamp-counter", () => {
    const nextId = createIdFactory(() => 1700000000000);
    expect(nextId("user")).toBe("user-1700000000000-1");
    expect(nextId("asst")).toBe("asst-1700000000000-2");
  });
});
