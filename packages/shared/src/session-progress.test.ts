import { describe, expect, it } from "vitest";
import * as shared from "./index";
import type {
  ChatItem,
  ProgressAgent,
  ProgressTask,
  SdkNormalizedEvent,
  SessionProgress,
  ToolCardState,
  ToolTaskUpdate,
} from "./models";

function update(
  previous: SessionProgress | undefined,
  event: SdkNormalizedEvent,
  toolBeforeEvent?: ToolCardState,
) {
  expect(shared.updateSessionProgress).toBeTypeOf("function");
  return shared.updateSessionProgress(previous, event, toolBeforeEvent);
}

function taskEvent(task: ToolTaskUpdate, overrides: Partial<ToolCardState> = {}): SdkNormalizedEvent {
  return {
    type: "tool_end", sessionId: "s",
    tool: { id: "call-1", name: "TaskUpdate", summary: "", status: "done", task, ...overrides },
  };
}

const pending: ProgressTask = { id: "7", title: "测试", status: "pending" };
const running: ProgressAgent = { id: "agent-a", toolUseId: "call-a", title: "检查", status: "running", background: true };

describe("updateSessionProgress tasks", () => {
  it("uses the created task ID rather than the tool call ID", () => {
    const created = taskEvent({ operation: "create", taskId: "7", patch: pending, success: true });
    expect(update(undefined, created)?.tasks).toEqual([pending]);
  });

  it("waits for a successful tool result before creating tasks", () => {
    const tool: ToolCardState = {
      id: "create", name: "TaskCreate", summary: "测试", status: "running",
      task: { operation: "create", patch: { title: "测试", status: "pending" } },
    };
    expect(update(undefined, { type: "tool_start", sessionId: "s", tool })).toBeUndefined();
    expect(update(undefined, taskEvent({ operation: "create", patch: pending, success: false }))).toBeUndefined();
    expect(update(undefined, taskEvent({ operation: "create", patch: { title: "测试" }, success: true }))).toBeUndefined();
  });

  it("combines a successful unnamed result with the earlier input patch", () => {
    const before: ToolCardState = {
      id: "create", name: "TaskCreate", summary: "测试", status: "running",
      task: { operation: "create", patch: { title: "测试", status: "pending", description: "说明" } },
    };
    const next = update(undefined, taskEvent({ operation: "create", taskId: "7", success: true }, { id: "create", name: "tool" }), before);
    expect(next?.tasks).toEqual([{ ...pending, description: "说明" }]);
  });

  it("patches successful updates without mutating the previous snapshot", () => {
    const previous: SessionProgress = { tasks: [pending], agents: [] };
    const next = update(previous, taskEvent({ operation: "update", taskId: "7", patch: { status: "in_progress", owner: "worker", activeForm: "测试中" }, success: true }));
    expect(next?.tasks).toEqual([{ ...pending, status: "in_progress", owner: "worker", activeForm: "测试中" }]);
    expect(previous.tasks).toEqual([pending]);
    expect(next?.agents).toBe(previous.agents);
  });

  it.each([false, true])("ignores failed updates (tool error %s)", (isError) => {
    const previous: SessionProgress = { tasks: [pending], agents: [] };
    const event = taskEvent({ operation: "update", taskId: "7", patch: { status: "completed" }, success: !isError ? false : true }, { status: isError ? "error" : "done" });
    expect(update(previous, event)).toBe(previous);
  });

  it("deletes only the identified task after success", () => {
    const other = { ...pending, id: "8" };
    const previous: SessionProgress = { tasks: [pending, other], agents: [] };
    const next = update(previous, taskEvent({ operation: "update", taskId: "7", patch: { deleted: true }, success: true }));
    expect(next?.tasks).toEqual([other]);
    expect(next?.tasks[0]).toBe(other);
  });

  it("keeps the same ID in separate parent scopes", () => {
    const scoped = { ...pending, scope: "parent" };
    const previous: SessionProgress = { tasks: [pending, scoped], agents: [] };
    const next = update(previous, taskEvent({ operation: "update", taskId: "7", patch: { status: "completed" }, success: true }, { parentToolUseId: "parent" }));
    expect(next?.tasks).toEqual([pending, { ...scoped, status: "completed" }]);
  });

  it("replaces only the listed scope, including an empty list", () => {
    const scoped = { ...pending, scope: "parent" };
    const previous: SessionProgress = { tasks: [pending, scoped], agents: [] };
    const listed = update(previous, taskEvent({ operation: "list", tasks: [{ id: "9", title: "清理", status: "completed" }], success: true }));
    expect(listed?.tasks).toEqual(expect.arrayContaining([scoped, { id: "9", title: "清理", status: "completed" }]));
    expect(listed?.tasks).toHaveLength(2);
    const cleared = update(listed, taskEvent({ operation: "list", tasks: [], success: true }, { parentToolUseId: "parent" }));
    expect(cleared?.tasks).toEqual([{ id: "9", title: "清理", status: "completed" }]);
  });

  it("treats TodoWrite as a replacement without erasing tracked TaskCreate tasks", () => {
    const todo = { id: "todo-1", title: "计划", status: "pending" as const, scope: "todos" };
    const previous: SessionProgress = { tasks: [pending], agents: [] };
    const first = update(previous, taskEvent({ operation: "replace", tasks: [todo], patch: { scope: "todos" }, success: true }, { name: "TodoWrite" }));
    expect(first?.tasks).toEqual([pending, todo]);
    const second = update(first, taskEvent({ operation: "replace", tasks: [], patch: { scope: "todos" }, success: true }, { name: "TodoWrite" }));
    expect(second?.tasks).toEqual([pending]);
  });

  it("preserves references for duplicate updates and unknown task IDs", () => {
    const previous: SessionProgress = { tasks: [pending], agents: [] };
    expect(update(previous, taskEvent({ operation: "update", taskId: "7", patch: { status: "pending" }, success: true }))).toBe(previous);
    expect(update(previous, taskEvent({ operation: "update", taskId: "missing", patch: { status: "completed" }, success: true }))).toBe(previous);
    expect(update(previous, taskEvent({ operation: "list", tasks: [pending], success: true }))).toBe(previous);
  });

  it("does not inspect task or agent arrays for unrelated events", () => {
    const previous = Object.defineProperties({}, {
      tasks: { get() { throw new Error("unrelated event read tasks"); } },
      agents: { get() { throw new Error("unrelated event read agents"); } },
    }) as SessionProgress;
    const events: SdkNormalizedEvent[] = [
      { type: "text_delta", sessionId: "s", text: "x" },
      { type: "thinking_delta", sessionId: "s", text: "x" },
      { type: "result", sessionId: "s", ok: true },
      { type: "raw", sessionId: "s", payload: {} },
      { type: "tool_end", sessionId: "s", tool: { id: "read", name: "Read", summary: "", status: "done" } },
    ];
    for (const event of events) expect(update(previous, event)).toBe(previous);
  });

  it("does not reorder unaffected scopes when the same list is repeated", () => {
    const previous: SessionProgress = { tasks: [pending, { ...pending, scope: "parent" }], agents: [] };
    expect(update(previous, taskEvent({ operation: "list", tasks: [pending], success: true }))).toBe(previous);
  });

  it("does not reapply an identical old tool_end over a later task update", () => {
    const before: ToolCardState = {
      id: "fast", name: "TaskUpdate", summary: "更新", status: "done",
      task: { operation: "update", taskId: "7", patch: { status: "completed" }, success: true, appliedOrder: 2 },
    };
    const previous: SessionProgress = { tasks: [{ ...pending, status: "in_progress" }], agents: [] };
    const duplicate = taskEvent({ operation: "update", taskId: "7", patch: { status: "completed" }, success: true }, { id: "fast" });
    expect(update(previous, duplicate, before)).toBe(previous);
  });

  it("uses explicit list row scopes without clearing the main scope", () => {
    const previous: SessionProgress = { tasks: [pending, { ...pending, scope: "parent" }], agents: [] };
    const scoped = { ...pending, scope: "parent", status: "completed" as const };
    expect(update(previous, taskEvent({ operation: "list", tasks: [scoped], success: true }))?.tasks).toEqual([pending, scoped]);
  });
});

describe("updateSessionProgress agents", () => {
  it("tracks parallel agents separately and keeps tasks by reference", () => {
    const previous: SessionProgress = { tasks: [pending], agents: [running] };
    const next = update(previous, { type: "agent_progress", sessionId: "s", agent: { id: "agent-b", toolUseId: "call-b", title: "实现", status: "running" } });
    expect(next?.agents).toHaveLength(2);
    expect(next?.agents[0]).toBe(running);
    expect(next?.tasks).toBe(previous.tasks);
  });

  it("keeps an async launch running after its tool returns", () => {
    const previous: SessionProgress = { tasks: [], agents: [running] };
    const next = update(previous, { type: "tool_end", sessionId: "s", tool: { id: "call-a", name: "Agent", summary: "检查", status: "done", agent: running } });
    expect(next?.agents[0]?.status).toBe("running");
    expect(next).toBe(previous);
  });

  it("retains known background state on an unnamed tool end", () => {
    const before: ToolCardState = { id: "call-a", name: "Agent", summary: "检查", status: "running", agent: running };
    const previous: SessionProgress = { tasks: [], agents: [running] };
    const next = update(previous, { type: "tool_end", sessionId: "s", tool: { id: "call-a", name: "tool", summary: "", status: "done" } }, before);
    expect(next?.agents[0]?.status).toBe("running");
  });

  it("replaces a provisional tool-call ID with the SDK agent ID", () => {
    const previous: SessionProgress = { tasks: [], agents: [{ ...running, id: "call-a" }] };
    const next = update(previous, { type: "agent_progress", sessionId: "s", agent: { id: "agent-a", toolUseId: "call-a", status: "running" } });
    expect(next?.agents).toEqual([running]);
    expect(update(next, { type: "tool_start", sessionId: "s", tool: { id: "call-a", name: "Agent", summary: "检查", status: "running", agent: { ...running, id: "call-a" } } })?.agents).toEqual([running]);
  });

  it.each(["completed", "failed", "stopped"] as const)("does not revive a %s agent on a late heartbeat", (status) => {
    const previous: SessionProgress = { tasks: [], agents: [{ ...running, status, summary: "最终结果", elapsedSeconds: 10 }] };
    expect(update(previous, { type: "agent_progress", sessionId: "s", agent: { id: "agent-a", status: "running", summary: "旧心跳", elapsedSeconds: 9 } })).toBe(previous);
    expect(update(previous, { type: "tool_progress", sessionId: "s", toolUseId: "call-a", toolName: "Agent", elapsedSeconds: 11 })).toBe(previous);
  });

  it("updates a known agent heartbeat without inspecting tasks", () => {
    const previous = { agents: [running], get tasks(): ProgressTask[] { throw new Error("heartbeat read tasks"); } };
    // An unchanged heartbeat is a true no-op, including the tasks array.
    expect(update(previous, { type: "agent_progress", sessionId: "s", agent: running })).toBe(previous);
  });

  it("allows paused agents to resume", () => {
    const previous: SessionProgress = { tasks: [], agents: [{ ...running, status: "paused" }] };
    expect(update(previous, { type: "agent_progress", sessionId: "s", agent: { id: "agent-a", status: "running" } })?.agents[0].status).toBe("running");
  });

  it("accepts late canonical ID linkage without reviving a completed provisional agent", () => {
    const previous: SessionProgress = { tasks: [], agents: [{ ...running, id: "call-a", status: "completed", summary: "最终报告" }] };
    const next = update(previous, { type: "agent_progress", sessionId: "s", agent: { id: "agent-a", toolUseId: "call-a", status: "running", summary: "旧心跳" } });
    expect(next?.agents).toEqual([{ ...running, status: "completed", summary: "最终报告" }]);
  });

  it.each([false, true])("reconciles every linked agent record, including a terminal canonical record (reverse=%s)", (reverse) => {
    const provisional: ProgressAgent = { ...running, id: "call-a" };
    const canonical: ProgressAgent = { id: "agent-a", title: "检查", status: "completed", summary: "最终报告", elapsedSeconds: 9 };
    const unrelated: ProgressAgent = { id: "other", title: "独立任务", status: "running" };
    const records = reverse ? [canonical, unrelated, provisional] : [provisional, unrelated, canonical];
    const previous: SessionProgress = { tasks: [pending], agents: records };
    const linked = update(previous, { type: "agent_progress", sessionId: "s", agent: { id: "agent-a", toolUseId: "call-a", status: "running", summary: "launched", background: true } });
    expect(linked?.agents).toHaveLength(2);
    expect(linked?.agents.find((agent) => agent.id === "agent-a")).toMatchObject({
      toolUseId: "call-a", status: "completed", summary: "最终报告", elapsedSeconds: 9,
    });
    expect(linked?.agents.find((agent) => agent.id === "other")).toBe(unrelated);
    expect(linked?.tasks).toBe(previous.tasks);
  });

  it("uses existing linkage to reconcile duplicates on an ID-only completion", () => {
    const previous: SessionProgress = { tasks: [], agents: [
      { ...running, id: "call-a" },
      { ...running, id: "agent-a" },
    ] };
    expect(update(previous, { type: "agent_progress", sessionId: "s", agent: { id: "agent-a", status: "completed", summary: "最终报告" } })?.agents).toEqual([
      { ...running, status: "completed", summary: "最终报告" },
    ]);
  });
});

describe("progress restore and transcript replay", () => {
  it("replays retained changes over a compression baseline without mutating it", () => {
    const baseline: SessionProgress = { tasks: [pending], agents: [{ ...running, status: "completed" }] };
    const finish = taskEvent({ operation: "update", taskId: "7", patch: { status: "completed" }, success: true });
    if (finish.type !== "tool_end") throw new Error("invalid fixture");
    const items: ChatItem[] = [{ kind: "tool", id: finish.tool.id, tool: finish.tool }];
    expect(shared.rebuildSessionProgress(items, baseline)).toEqual({
      tasks: [{ ...pending, status: "completed" }], agents: baseline.agents,
    });
    expect(shared.rebuildSessionProgress([], baseline)).toBe(baseline);
    expect(baseline.tasks).toEqual([pending]);
  });

  it("replays retained task operations and the agent lifecycle written into tools", () => {
    expect(shared.rebuildSessionProgress).toBeTypeOf("function");
    const create = taskEvent({ operation: "create", taskId: "7", patch: pending, success: true });
    const finish = taskEvent({ operation: "update", taskId: "7", patch: { status: "completed" }, success: true }, { id: "call-2" });
    const items: ChatItem[] = [create, finish].map((event) => {
      if (event.type !== "tool_end") throw new Error("invalid fixture");
      return { kind: "tool", id: event.tool.id, tool: event.tool };
    });
    items.push({ kind: "text", id: "tail", role: "assistant", text: "Finished" });
    items.push({ kind: "tool", id: "call-a", tool: { id: "call-a", name: "Agent", summary: "检查", status: "done", agent: { ...running, status: "completed", summary: "报告" } } });
    expect(shared.rebuildSessionProgress(items)).toEqual({ tasks: [{ ...pending, status: "completed" }], agents: [{ ...running, status: "completed", summary: "报告" }] });
  });

  it("replays legacy completed TodoWrite cards but ignores failed cards", () => {
    expect(shared.rebuildSessionProgress).toBeTypeOf("function");
    const items: ChatItem[] = [
      { kind: "tool", id: "todo", tool: { id: "todo", name: "TodoWrite", summary: "", status: "done", todos: [{ content: "计划", status: "pending" }] } },
      { kind: "tool", id: "failed", tool: { id: "failed", name: "TodoWrite", summary: "", status: "error", todos: [] } },
    ];
    expect(shared.rebuildSessionProgress(items)?.tasks).toEqual([{ id: "todo-1", title: "计划", status: "pending", scope: "todos" }]);
    expect(shared.rebuildSessionProgress([])).toBeUndefined();
  });

  it("validates persisted values and marks live agents unknown without mutating input", () => {
    expect(shared.restoreSessionProgress).toBeTypeOf("function");
    const value = {
      tasks: [pending, { ...pending, id: "8", status: "invented" }, null, { id: 4, title: "bad", status: "pending" }],
      agents: [running, { ...running, id: "paused", toolUseId: "paused", status: "paused" }, { ...running, id: "done", toolUseId: "done", status: "completed", elapsedSeconds: -1 }, { id: "bad", title: "bad", status: "invented" }],
    };
    const restored = shared.restoreSessionProgress(value);
    expect(restored?.tasks).toEqual([pending]);
    expect(restored?.agents.map((agent) => agent.status)).toEqual(["unknown", "unknown", "completed"]);
    expect(restored?.agents[2]).not.toHaveProperty("elapsedSeconds");
    expect(value.agents[0].status).toBe("running");
  });

  it("rejects invalid snapshot roots and keeps valid empty snapshots", () => {
    expect(shared.restoreSessionProgress).toBeTypeOf("function");
    for (const value of [null, undefined, [], "text", {}, { tasks: "bad", agents: [] }]) {
      expect(shared.restoreSessionProgress(value)).toBeUndefined();
    }
    expect(shared.restoreSessionProgress({ tasks: [], agents: [] })).toEqual({ tasks: [], agents: [] });
  });

  it.each([false, true])("restores one terminal agent from canonical/provisional duplicates (reverse=%s)", (reverse) => {
    const provisional: ProgressAgent = { ...running, id: "call-a" };
    const canonical: ProgressAgent = { ...running, status: "completed", summary: "最终报告", elapsedSeconds: 9 };
    const value = { tasks: [], agents: reverse ? [canonical, provisional] : [provisional, canonical] };
    expect(shared.restoreSessionProgress(value)?.agents).toEqual([canonical]);
    expect(value.agents).toHaveLength(2);
  });
});
