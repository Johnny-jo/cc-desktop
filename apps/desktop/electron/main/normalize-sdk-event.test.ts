import { describe, expect, it } from "vitest";
import { normalizeSdkEvent } from "./normalize-sdk-event";

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
