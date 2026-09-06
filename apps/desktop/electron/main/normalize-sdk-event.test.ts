import { describe, expect, it } from "vitest";
import { normalizeSdkEvent } from "./normalize-sdk-event";
import { applySdkEvent, emptyTranscript, rebuildSessionProgress, restoreSessionProgress, updateSessionProgress } from "@claude-desktop/shared";
import type { SessionProgress, ToolCardState } from "@claude-desktop/shared";

describe("normalizeSdkEvent", () => {
  const sessionId = "sess-1";

  it("maps stream_event text_delta to text_delta", () => {
    const msg = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hi" },
      },
    };
    expect(normalizeSdkEvent(msg, sessionId)).toEqual([
      { type: "text_delta", text: "Hi", sessionId },
    ]);
  });

  it("maps thinking block start and thinking_delta so UI can show first-byte activity", () => {
    expect(
      normalizeSdkEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "thinking" },
          },
        },
        sessionId,
      ),
    ).toEqual([{ type: "thinking_delta", sessionId, text: "" }]);
    expect(
      normalizeSdkEvent(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "plan" },
          },
        },
        sessionId,
      ),
    ).toEqual([{ type: "thinking_delta", sessionId, text: "plan" }]);
  });

  it("keeps completed assistant thinking when a provider omits stream deltas", () => {
    const events = normalizeSdkEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "先检查调用链" },
            { type: "text", text: "结论" },
          ],
        },
      },
      sessionId,
    );

    expect(events).toEqual([
      { type: "thinking_delta", sessionId, text: "先检查调用链" },
      { type: "text_done", sessionId, text: "结论" },
    ]);
  });

  it("maps tool_progress to tool_progress event", () => {
    const msg = {
      type: "tool_progress",
      tool_use_id: "tu-1",
      tool_name: "Bash",
      elapsed_time_seconds: 3.2,
    };
    expect(normalizeSdkEvent(msg, sessionId)).toEqual([
      {
        type: "tool_progress",
        sessionId,
        toolUseId: "tu-1",
        toolName: "Bash",
        elapsedSeconds: 3.2,
      },
    ]);
  });

  it("extracts OpenAI-style prompt/completion tokens as input/output", () => {
    const msg = {
      type: "result",
      subtype: "success",
      usage: {
        prompt_tokens: 5600,
        completion_tokens: 230,
      },
    };
    const events = normalizeSdkEvent(msg, "s2");
    expect(events[0]).toMatchObject({
      type: "result",
      ok: true,
      usage: {
        inputTokens: 5600,
        outputTokens: 230,
      },
    });
  });

  it("extracts tokens and duration from result messages", () => {
    const msg = {
      type: "result",
      subtype: "success",
      duration_ms: 4200,
      duration_api_ms: 3100,
      total_cost_usd: 0.0123,
      num_turns: 2,
      usage: {
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      },
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "result",
      ok: true,
      costUsd: 0.0123,
      usage: {
        durationMs: 4200,
        durationApiMs: 3100,
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 100,
        cacheCreationTokens: 50,
        costUsd: 0.0123,
        numTurns: 2,
      },
    });
  });

  it("folds long skill dump assistant text into collapsible Skill tool cards", () => {
    const skillBody = [
      "Base directory for this skill: C:\\Users\\x\\.claude\\skills\\using-superpowers",
      "",
      "<SUBAGENT-STOP>",
      "If you are a subagent, stop.",
      "</SUBAGENT-STOP>",
      "",
      "<EXTREMELY-IMPORTANT>",
      "You must use this skill.",
      "</EXTREMELY-IMPORTANT>",
      "## Rules",
      "More content here to exceed length threshold. ".repeat(10),
    ].join("\n");
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: skillBody }],
      },
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events.some((e) => e.type === "text_done")).toBe(false);
    expect(events.some((e) => e.type === "tool_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_end")).toBe(true);
    const start = events.find((e) => e.type === "tool_start");
    expect(start).toMatchObject({
      type: "tool_start",
      tool: { name: "Skill", status: "done" },
    });
  });


  it("maps assistant tool_use content to tool_start", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "1", name: "Read", input: { file_path: "a" } },
        ],
      },
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_start",
      sessionId,
      tool: {
        id: "1",
        name: "Read",
        status: "running",
        summary: "a",
      },
    });
  });

  it("maps assistant text content to text_done", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello world" }],
      },
    };
    expect(normalizeSdkEvent(msg, sessionId)).toEqual([
      { type: "text_done", sessionId, text: "Hello world" },
    ]);
  });

  it("maps user text content to user_message", () => {
    const msg = {
      type: "user",
      message: {
        content: [{ type: "text", text: "do stuff" }],
      },
    };
    expect(normalizeSdkEvent(msg, sessionId)).toEqual([
      { type: "user_message", sessionId, text: "do stuff" },
    ]);
  });

  it("maps user tool_result to tool_end", () => {
    const msg = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "1",
            content: "file contents here",
            is_error: false,
          },
        ],
      },
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_end",
      sessionId,
      tool: {
        id: "1",
        status: "done",
      },
    });
  });

  it("maps result success", () => {
    const msg = {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.012,
      session_id: "sdk-xyz",
      result: "done",
    };
    expect(normalizeSdkEvent(msg, sessionId)).toEqual([
      {
        type: "result",
        sessionId,
        ok: true,
        costUsd: 0.012,
        usage: { costUsd: 0.012 },
      },
    ]);
  });

  it("maps result error", () => {
    const msg = {
      type: "result",
      subtype: "error",
      is_error: true,
      total_cost_usd: 0,
      errors: ["boom"],
      session_id: "sdk-xyz",
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "result",
      sessionId,
      ok: false,
    });
    expect((events[0] as { error?: string }).error).toBeTruthy();
  });

  it("returns empty array for unknown messages", () => {
    expect(normalizeSdkEvent({ type: "system", subtype: "init" }, sessionId)).toEqual(
      [],
    );
  });

  it("emits multiple events for mixed assistant content", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll read it" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.ts" } },
        ],
      },
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events.map((e) => e.type)).toEqual(["text_done", "tool_start"]);
  });

  it("extracts todos and progress summary from TodoWrite", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tw1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Explore code", status: "completed", activeForm: "Exploring" },
                { content: "Implement feature", status: "in_progress" },
                { content: "Run tests", status: "pending" },
              ],
            },
          },
        ],
      },
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_start",
      tool: {
        name: "TodoWrite",
        summary: "1/3 completed",
        todos: [
          { content: "Explore code", status: "completed", activeForm: "Exploring" },
          { content: "Implement feature", status: "in_progress" },
          { content: "Run tests", status: "pending" },
        ],
      },
    });
  });

  it("uses task description as Task summary and widens result preview", () => {
    const startMsg = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Task",
            input: { description: "Find flaky tests", subagent_type: "Explore" },
          },
        ],
      },
    };
    const start = normalizeSdkEvent(startMsg, sessionId);
    expect(start[0]).toMatchObject({
      type: "tool_start",
      tool: { name: "Task", summary: "Find flaky tests" },
    });

    const longReport = "subagent report line\n".repeat(200); // > 200 chars
    const endMsg = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", name: "Task", content: longReport },
        ],
      },
    };
    const end = normalizeSdkEvent(endMsg, sessionId);
    const preview = (end[0] as { tool?: { resultPreview?: string } }).tool
      ?.resultPreview;
    expect(preview && preview.length > 200).toBe(true);
    expect(preview && preview.length <= 2000).toBe(true);
  });

  it("marks tools with parent_tool_use_id as subagent", () => {
    const msg = {
      type: "assistant",
      parent_tool_use_id: "parent-task-1",
      message: {
        content: [
          { type: "tool_use", id: "st1", name: "Read", input: { file_path: "a" } },
        ],
      },
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events[0]).toMatchObject({
      type: "tool_start",
      tool: { id: "st1", isSubagent: true },
    });
  });

  it("maps TaskCreate to a single pending todo with subject summary", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tc1",
            name: "TaskCreate",
            input: { subject: "Design schema", description: "...", activeForm: "Designing" },
          },
        ],
      },
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events[0]).toMatchObject({
      type: "tool_start",
      tool: {
        name: "TaskCreate",
        summary: "Design schema",
        todos: [{ content: "Design schema", status: "pending", activeForm: "Designing" }],
      },
    });
  });

  it("extracts todos from TaskList tool_result JSON", () => {
    const payload = JSON.stringify({
      tasks: [
        { id: "1", subject: "Design schema", status: "completed", blockedBy: [] },
        { id: "2", subject: "Run tests", status: "in_progress", blockedBy: ["1"] },
      ],
    });
    const msg = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tl1", name: "TaskList", content: payload },
        ],
      },
    };
    const events = normalizeSdkEvent(msg, sessionId);
    expect(events[0]).toMatchObject({
      type: "tool_end",
      tool: {
        name: "TaskList",
        todos: [
          { content: "Design schema", status: "completed" },
          { content: "Run tests", status: "in_progress" },
        ],
      },
    });
  });
});

describe("structured task normalization", () => {
  const sessionId = "s";

  function start(name: string, input: unknown, parent?: string): ToolCardState {
    const event = normalizeSdkEvent({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id: "call", name, input }] } }, sessionId)[0];
    if (event.type !== "tool_start") throw new Error("expected tool start");
    return event.tool;
  }

  function end(before: ToolCardState, content: unknown, result?: unknown, isError = false) {
    return normalizeSdkEvent({
      type: "user", tool_use_result: result,
      message: { content: [{ type: "tool_result", tool_use_id: before.id, content, is_error: isError }] },
    }, sessionId, (id) => id === before.id ? before : undefined);
  }

  it("captures creation input and the SDK-assigned ID from an unnamed result", () => {
    const before = start("TaskCreate", { subject: "测试", description: "完整描述", activeForm: "测试中" }, "parent");
    expect(before).toMatchObject({ parentToolUseId: "parent", task: { operation: "create", patch: { title: "测试", description: "完整描述", status: "pending", activeForm: "测试中", scope: "parent" } } });
    expect(end(before, "Task #7 created successfully: 测试", { task: { id: "7", subject: "测试" } })[0]).toMatchObject({
      type: "tool_end", tool: { name: "TaskCreate", summary: "测试", parentToolUseId: "parent", task: { operation: "create", taskId: "7", success: true, patch: { title: "测试", description: "完整描述", scope: "parent" } } },
    });
  });

  it("supports the exact SDK TaskCreate text result when structured output is absent", () => {
    expect(end(start("TaskCreate", { subject: "测试" }), "Task #7 created successfully: 测试")[0]).toMatchObject({ tool: { task: { taskId: "7", success: true } } });
  });

  it("does not invent a task ID from the invocation or arbitrary output text", () => {
    const events = end(start("TaskCreate", { subject: "测试" }), "created something, ID unavailable");
    expect(events[0]).toMatchObject({ tool: { task: { operation: "create", success: false } } });
    expect(updateSessionProgress(undefined, events[0])).toBeUndefined();
  });

  it("keeps failed structured updates unsuccessful even when is_error is false", () => {
    const before = start("TaskUpdate", { taskId: "7", status: "completed", owner: "worker" });
    expect(before).toMatchObject({ task: { operation: "update", taskId: "7", patch: { status: "completed", owner: "worker" } } });
    expect(end(before, "Task not found", { success: false, taskId: "7", error: "not found" })[0]).toMatchObject({ tool: { task: { success: false } } });
  });

  it("retains input patch fields on a successful structured update", () => {
    const before = start("TaskUpdate", { taskId: "7", subject: "新标题", status: "in_progress", description: "详情", activeForm: "处理中" });
    expect(end(before, "updated", { success: true, taskId: "7", updatedFields: ["status", "subject"] })[0]).toMatchObject({ tool: { task: { operation: "update", taskId: "7", success: true, patch: { title: "新标题", status: "in_progress", description: "详情", activeForm: "处理中" } } } });
  });

  it.each(["Task not found", "Task #7 not found", "updated", "Updated task #8 status", "Updated task #7 status\nTask not found"])("requires positive proof before applying TaskUpdate result %s", (content) => {
    const before = start("TaskUpdate", { taskId: "7", status: "completed" });
    const event = end(before, content)[0];
    const previous: SessionProgress = { tasks: [{ id: "7", title: "测试", status: "pending" }], agents: [] };
    expect(event).toMatchObject({ tool: { task: { success: false } } });
    expect(updateSessionProgress(previous, event, before)).toBe(previous);
  });

  it("accepts the exact SDK update success marker for the requested task", () => {
    const before = start("TaskUpdate", { taskId: "7", status: "completed" });
    const event = end(before, "Updated task #7 status")[0];
    const previous: SessionProgress = { tasks: [{ id: "7", title: "测试", status: "pending" }], agents: [] };
    expect(event).toMatchObject({ tool: { task: { success: true } } });
    expect(updateSessionProgress(previous, event, before)?.tasks[0].status).toBe("completed");
  });

  it("maps deletion to a patch rather than an unsupported task status", () => {
    const before = start("TaskUpdate", { taskId: "7", status: "deleted" });
    expect(end(before, "deleted", { success: true, taskId: "7" })[0]).toMatchObject({ tool: { task: { patch: { deleted: true }, success: true } } });
    expect(before.task?.patch).not.toHaveProperty("status");
  });

  it("parses a complete TaskList JSON result before the display preview is truncated", () => {
    const tasks = Array.from({ length: 30 }, (_, index) => ({ id: String(index + 1), subject: "任务" + index, status: "pending" }));
    const events = end(start("TaskList", {}, "parent"), [{ type: "text", text: JSON.stringify({ tasks }) }]);
    expect(events[0]).toMatchObject({ tool: { name: "TaskList", task: { operation: "list", success: true, patch: { scope: "parent" }, tasks: expect.any(Array) } } });
    if (events[0].type !== "tool_end") throw new Error("invalid fixture");
    expect(events[0].tool.task?.tasks).toHaveLength(30);
    expect(events[0].tool.task?.tasks?.[29]).toMatchObject({ id: "30", title: "任务29", scope: "parent" });
    expect(events[0].tool.resultPreview?.length).toBeLessThanOrEqual(200);
  });

  it("distinguishes an empty task list from an unparseable result", () => {
    const before = start("TaskList", {});
    expect(end(before, "No tasks", { tasks: [] })[0]).toMatchObject({ tool: { task: { operation: "list", tasks: [], success: true } } });
    expect(end(before, "unstructured result")[0]).toMatchObject({ tool: { task: { operation: "list", success: false } } });
  });

  it("keeps TodoWrite replacements in their own parent-aware scope", () => {
    const before = start("TodoWrite", { todos: [{ content: "计划", status: "in_progress", activeForm: "规划中" }] }, "parent");
    expect(end(before, "Todos have been modified successfully")[0]).toMatchObject({ tool: { task: { operation: "replace", success: true, patch: { scope: "todos:parent" }, tasks: [{ id: "todo-1", title: "计划", status: "in_progress", activeForm: "规划中", scope: "todos:parent" }] } } });
    expect(end(before, "denied", undefined, true)[0]).toMatchObject({ tool: { task: { success: false } } });
  });

  it("does not assign one frame's structured output to multiple tool results", () => {
    const before = start("TaskCreate", { subject: "测试" });
    const events = normalizeSdkEvent({ type: "user", tool_use_result: { task: { id: "7", subject: "测试" } }, message: { content: [
      { type: "tool_result", tool_use_id: "call", content: "unknown" },
      { type: "tool_result", tool_use_id: "other", content: "unknown" },
    ] } }, sessionId, (id) => ({ ...before, id }));
    for (const event of events) expect(event).toMatchObject({ tool: { task: { success: false } } });
  });

  it("uses the SDK's accepted newTodos instead of the requested list", () => {
    const before = start("TodoWrite", { todos: [{ content: "原计划", status: "pending" }] });
    const event = end(before, "accepted", { newTodos: [{ content: "实际计划", status: "completed", activeForm: "完成规划" }] })[0];
    expect(event).toMatchObject({ tool: { todos: [{ content: "实际计划", status: "completed" }], task: { tasks: [{ id: "todo-1", title: "实际计划", status: "completed", scope: "todos" }] } } });
  });

  it("does not convert malformed TodoWrite rows into fabricated pending progress", () => {
    const before = start("TodoWrite", { todos: [{ content: "无效状态", status: "invented" }] });
    expect(end(before, "accepted")[0]).toMatchObject({ tool: { task: { success: false } } });
  });
});

describe("SDK agent lifecycle normalization", () => {
  const sessionId = "s";
  const before: ToolCardState = { id: "call-a", name: "Agent", summary: "检查", status: "running", agent: { id: "call-a", toolUseId: "call-a", title: "检查", status: "running", background: true } };
  const resolve = (id: string) => id === before.id || id === "agent-a" ? before : undefined;

  it("adds a provisional agent and parent linkage to Task/Agent calls", () => {
    const events = normalizeSdkEvent({ type: "assistant", parent_tool_use_id: "parent", message: { content: [{ type: "tool_use", id: "call-a", name: "Task", input: { description: "检查", run_in_background: true } }] } }, sessionId);
    expect(events[0]).toMatchObject({ tool: { parentToolUseId: "parent", agent: { id: "call-a", toolUseId: "call-a", parentToolUseId: "parent", title: "检查", status: "running", background: true } } });
  });

  it.each(["async_launched", "remote_launched"])("keeps %s results running", (status) => {
    const events = normalizeSdkEvent({ type: "user", tool_use_result: { status, agentId: "agent-a", taskId: "agent-a", description: "检查" }, message: { content: [{ type: "tool_result", tool_use_id: "call-a", content: "launched" }] } }, sessionId, resolve);
    expect(events[0]).toMatchObject({ type: "tool_end", tool: { name: "Agent", status: "done", agent: { id: "agent-a", toolUseId: "call-a", status: "running", background: true } } });
  });

  it("uses completed structured output for the final report and elapsed duration", () => {
    const report = "完成报告".repeat(800);
    const events = normalizeSdkEvent({ type: "user", tool_use_result: { status: "completed", agentId: "agent-a", content: [{ type: "text", text: report }], totalDurationMs: 12000 }, message: { content: [{ type: "tool_result", tool_use_id: "call-a", content: "model-directed trailer" }] } }, sessionId, resolve);
    expect(events[0]).toMatchObject({ tool: { resultPreview: report.slice(0, 2000), agent: { id: "agent-a", status: "completed", elapsedSeconds: 12, summary: report.slice(0, 2000) } } });
  });

  it("does not infer completion from an unstructured background launch reply", () => {
    const events = normalizeSdkEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-a", content: "launched" }] } }, sessionId, resolve);
    expect(events[0]).toMatchObject({ tool: { agent: { status: "running", background: true } } });
  });

  it("resolves a generic tool placeholder before parsing the agent result", () => {
    const events = normalizeSdkEvent({ type: "user", tool_use_result: { status: "completed", agentId: "agent-a", content: [{ type: "text", text: "完成" }] }, message: { content: [{ type: "tool_result", name: "tool", tool_use_id: "call-a", content: "trailer" }] } }, sessionId, resolve);
    expect(events[0]).toMatchObject({ tool: { name: "Agent", agent: { id: "agent-a", status: "completed" } } });
  });

  it("reports errors as agent failure even for background calls", () => {
    const events = normalizeSdkEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-a", content: "denied", is_error: true }] } }, sessionId, resolve);
    expect(events[0]).toMatchObject({ tool: { agent: { status: "failed", summary: "denied" } } });
  });

  it("accepts explicitly typed agent starts without a retained invocation", () => {
    expect(normalizeSdkEvent({ type: "system", subtype: "task_started", task_id: "agent-a", task_type: "local_agent", tool_use_id: "call-a", description: "检查" }, sessionId)).toEqual([
      { type: "agent_progress", sessionId, agent: { id: "agent-a", toolUseId: "call-a", title: "检查", status: "running" } },
    ]);
  });

  it("accepts progress with explicit subagent type and converts milliseconds", () => {
    expect(normalizeSdkEvent({ type: "system", subtype: "task_progress", task_id: "agent-a", subagent_type: "Explore", description: "检查", usage: { duration_ms: 3400 }, summary: "已检查两处" }, sessionId)).toEqual([
      { type: "agent_progress", sessionId, agent: { id: "agent-a", title: "检查", status: "running", elapsedSeconds: 3.4, summary: "已检查两处" } },
    ]);
  });

  it.each(["completed", "failed", "stopped"])("links %s notifications to a known agent call", (status) => {
    expect(normalizeSdkEvent({ type: "system", subtype: "task_notification", task_id: "agent-a", tool_use_id: "call-a", status, summary: "结束", usage: { duration_ms: 5000 } }, sessionId, resolve)[0]).toMatchObject({ type: "agent_progress", agent: { id: "agent-a", toolUseId: "call-a", title: "检查", status, summary: "结束", elapsedSeconds: 5 } });
  });

  it("can resolve notifications by agent ID when tool_use_id is omitted", () => {
    expect(normalizeSdkEvent({ type: "system", subtype: "task_notification", task_id: "agent-a", status: "completed", summary: "结束" }, sessionId, resolve)[0]).toMatchObject({ type: "agent_progress", agent: { id: "agent-a", toolUseId: "call-a", status: "completed" } });
  });

  it.each(["paused", "running", "killed"])("normalizes associated task_updated status %s", (status) => {
    expect(normalizeSdkEvent({ type: "system", subtype: "task_updated", task_id: "agent-a", patch: { status, is_backgrounded: true } }, sessionId, resolve)[0]).toMatchObject({ type: "agent_progress", agent: { id: "agent-a", status: status === "killed" ? "stopped" : status, background: true } });
  });

  it("filters Bash, workflow, and unassociated task notifications", () => {
    const bash: ToolCardState = { id: "bash", name: "Bash", summary: "tests", status: "running" };
    const messages = [
      { subtype: "task_started", task_id: "b", tool_use_id: "bash", task_type: "local_bash", description: "tests" },
      { subtype: "task_started", task_id: "w", task_type: "local_workflow", description: "workflow" },
      { subtype: "task_notification", task_id: "b", tool_use_id: "bash", status: "completed", summary: "done" },
      { subtype: "task_progress", task_id: "b", description: "tests" },
      { subtype: "task_notification", task_id: "unknown", status: "completed", summary: "done" },
    ];
    for (const message of messages) expect(normalizeSdkEvent({ type: "system", ...message }, sessionId, (id) => id === "bash" ? bash : undefined)).toEqual([]);
  });

  it("preserves parallel background lifecycles through reduction and replay", () => {
    let transcript = emptyTranscript();
    let progress: SessionProgress | undefined;
    const lookup = (id: string) => transcript.items.find((item) => item.kind === "tool" && (item.tool.id === id || item.tool.agent?.id === id));
    const messages = [
      { type: "assistant", message: { content: [
        { type: "tool_use", id: "a", name: "Agent", input: { description: "检查A", run_in_background: true } },
        { type: "tool_use", id: "b", name: "Agent", input: { description: "检查B", run_in_background: true } },
      ] } },
      { type: "user", tool_use_result: { status: "async_launched", agentId: "agent-a" }, message: { content: [{ type: "tool_result", tool_use_id: "a", content: "launched" }] } },
      { type: "system", subtype: "task_started", task_id: "agent-b", tool_use_id: "b", task_type: "local_agent", description: "检查B" },
      { type: "system", subtype: "task_notification", task_id: "agent-a", status: "completed", summary: "A完成" },
      { type: "tool_progress", tool_use_id: "a", tool_name: "Agent", elapsed_time_seconds: 2 },
      { type: "result", subtype: "success" },
    ];
    for (const message of messages) {
      const events = normalizeSdkEvent(message, sessionId, (id) => { const item = lookup(id); return item?.kind === "tool" ? item.tool : undefined; });
      for (const event of events) {
        const item = event.type === "tool_start" || event.type === "tool_end" ? lookup(event.tool.id) : undefined;
        progress = updateSessionProgress(progress, event, item?.kind === "tool" ? item.tool : undefined);
        transcript = applySdkEvent(transcript, event, { nextId: (prefix) => prefix + "-test" });
      }
    }
    expect(progress?.agents.map((agent) => [agent.id, agent.status])).toEqual([["agent-a", "completed"], ["agent-b", "running"]]);
    expect(rebuildSessionProgress(transcript.items)).toEqual(progress);
  });

  it.each([false, true])("reconciles an unlinked typed lifecycle when async launch supplies its invocation ID (completedFirst=%s)", (completedFirst) => {
    let transcript = emptyTranscript();
    let progress: SessionProgress | undefined;
    const lookup = (id: string) => transcript.items.find((item) => item.kind === "tool" && (item.tool.id === id || item.tool.agent?.id === id));
    const start = { type: "assistant", message: { content: [{ type: "tool_use", id: "call-a", name: "Agent", input: { description: "检查", run_in_background: true } }] } };
    const heartbeat = { type: "system", subtype: "task_progress", task_id: "agent-a", subagent_type: "Explore", description: "检查", summary: "检查中", usage: { duration_ms: 2000 } };
    const launch = { type: "user", tool_use_result: { status: "async_launched", agentId: "agent-a" }, message: { content: [{ type: "tool_result", tool_use_id: "call-a", content: "launched" }] } };
    const complete = { type: "system", subtype: "task_notification", task_id: "agent-a", status: "completed", summary: "最终报告" };
    const messages = completedFirst ? [start, heartbeat, complete, launch] : [start, heartbeat, launch, complete];
    for (const message of messages) {
      const events = normalizeSdkEvent(message, sessionId, (id) => { const item = lookup(id); return item?.kind === "tool" ? item.tool : undefined; });
      for (const event of events) {
        const before = event.type === "tool_start" || event.type === "tool_end" ? lookup(event.tool.id) : undefined;
        progress = updateSessionProgress(progress, event, before?.kind === "tool" ? before.tool : undefined);
        transcript = applySdkEvent(transcript, event, { nextId: (prefix) => prefix + "-test" });
      }
    }
    expect(progress?.agents).toHaveLength(1);
    expect(progress?.agents[0]).toMatchObject({ id: "agent-a", toolUseId: "call-a", status: "completed", summary: "最终报告" });
    expect(transcript.items.filter((item) => item.kind === "tool")).toHaveLength(1);
    expect(restoreSessionProgress(rebuildSessionProgress(JSON.parse(JSON.stringify(transcript.items))))).toEqual(progress);
  });
});
