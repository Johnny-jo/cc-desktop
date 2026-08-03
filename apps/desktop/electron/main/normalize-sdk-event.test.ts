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
      { type: "result", sessionId, ok: true, costUsd: 0.012 },
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
});
