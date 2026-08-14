import { describe, expect, it } from "vitest";
import type { ChatItem, SdkNormalizedEvent, ToolCardState } from "./models";
import {
  applySdkEvent,
  bindSdkUserMsgIds,
  createIdFactory,
  emptyTranscript,
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

  it("user_msg_ids does not change items", () => {
    const start = emptyTranscript();
    const next = apply(start, { type: "user_msg_ids", sessionId: "s", uuids: ["u"] });
    expect(next.items).toEqual([]);
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
