import { describe, expect, it } from "vitest";
import type { ChatItem } from "@claude-desktop/shared";
import { buildConversationBlocks } from "./conversation-blocks";

describe("buildConversationBlocks", () => {
  it("groups thinking and tools inside one user turn", () => {
    const items: ChatItem[] = [
      { kind: "text", id: "u1", role: "user", text: "Fix it" },
      {
        kind: "text",
        id: "think1",
        role: "assistant",
        text: "",
        thinkingText: "Inspecting the project",
      },
      {
        kind: "tool",
        id: "tool1",
        tool: { id: "tool1", name: "Read", summary: "App.tsx", status: "done" },
      },
      {
        kind: "text",
        id: "answer1",
        role: "assistant",
        text: "Done",
      },
      { kind: "usage", id: "usage1", usage: { durationMs: 4200 } },
    ];

    const blocks = buildConversationBlocks(items);

    expect(blocks.map((block) => block.kind)).toEqual([
      "item",
      "activity",
      "item",
      "turn-footer",
    ]);
    const activity = blocks[1];
    expect(activity?.kind).toBe("activity");
    if (activity?.kind === "activity") {
      expect(activity.entries.map((entry) => entry.kind)).toEqual([
        "thinking",
        "tool",
      ]);
      expect(activity.usage?.durationMs).toBe(4200);
    }
    const footer = blocks[3];
    expect(footer?.kind).toBe("turn-footer");
    if (footer?.kind === "turn-footer") {
      expect(footer.text).toBe("Done");
      expect(footer.usage.durationMs).toBe(4200);
    }
  });

  it("builds one completed-turn footer from assistant prose only", () => {
    const blocks = buildConversationBlocks([
      { kind: "text", id: "u1", role: "user", text: "Update it" },
      {
        kind: "text",
        id: "a1",
        role: "assistant",
        text: "I updated the data model.",
      },
      {
        kind: "tool",
        id: "tool1",
        tool: {
          id: "tool1",
          name: "Edit",
          summary: "src/model.ts",
          status: "done",
          resultPreview: "internal tool output",
        },
      },
      {
        kind: "text",
        id: "a2",
        role: "assistant",
        text: "The UI now uses the new field.",
      },
      {
        kind: "usage",
        id: "usage1",
        usage: { inputTokens: 120, outputTokens: 45, durationMs: 3000 },
      },
    ]);

    const footer = blocks.find((block) => block.kind === "turn-footer");
    expect(footer).toMatchObject({
      kind: "turn-footer",
      text: "I updated the data model.\n\nThe UI now uses the new field.",
      usage: { inputTokens: 120, outputTokens: 45, durationMs: 3000 },
    });
    expect(
      footer?.kind === "turn-footer" ? footer.text : "",
    ).not.toContain("internal tool output");
  });

  it("keeps tool-first and thinking-first events in transcript order", () => {
    const blocks = buildConversationBlocks([
      { kind: "text", id: "u1", role: "user", text: "Continue" },
      {
        kind: "tool",
        id: "tool1",
        tool: { id: "tool1", name: "Read", summary: "App.tsx", status: "done" },
      },
      {
        kind: "text",
        id: "think1",
        role: "assistant",
        text: "",
        thinkingText: "Choosing the next edit",
      },
      {
        kind: "tool",
        id: "tool2",
        tool: { id: "tool2", name: "Edit", summary: "App.tsx", status: "done" },
      },
    ]);

    const activity = blocks[1];
    expect(activity?.kind).toBe("activity");
    if (activity?.kind === "activity") {
      expect(activity.entries.map((entry) => entry.id)).toEqual([
        "tool1",
        "think1",
        "tool2",
      ]);
    }
  });

  it("shows auto-compaction as a timeline event and hides its internal summary", () => {
    const blocks = buildConversationBlocks([
      {
        kind: "text",
        id: "ctx-summary-1",
        role: "system",
        text: "Internal summary that should not be rendered",
      },
      { kind: "text", id: "u1", role: "user", text: "Keep working" },
      {
        kind: "tool",
        id: "tool1",
        tool: { id: "tool1", name: "Bash", summary: "test", status: "done" },
      },
      {
        kind: "text",
        id: "ctx-continue-1",
        role: "system",
        text: "Context compacted — continuing previous task…",
      },
      {
        kind: "text",
        id: "think1",
        role: "assistant",
        text: "",
        thinkingText: "Continuing after compaction",
        streaming: true,
        thinking: true,
      },
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.kind).toBe("item");
    const activity = blocks[1];
    expect(activity?.kind).toBe("activity");
    if (activity?.kind === "activity") {
      expect(activity.entries.map((entry) => entry.kind)).toEqual([
        "tool",
        "compaction",
        "thinking",
      ]);
    }
  });

  it("keeps answer text while moving its thinking into the activity", () => {
    const blocks = buildConversationBlocks([
      { kind: "text", id: "u1", role: "user", text: "Question" },
      {
        kind: "text",
        id: "a1",
        role: "assistant",
        text: "Answer",
        thinkingText: "Reasoning",
        streaming: true,
      },
    ]);

    expect(blocks).toHaveLength(3);
    expect(blocks[1]?.kind).toBe("activity");
    const answer = blocks[2];
    expect(answer?.kind).toBe("item");
    if (answer?.kind === "item" && answer.item.kind === "text") {
      expect(answer.item.text).toBe("Answer");
      expect(answer.item.thinkingText).toBeUndefined();
      expect(answer.item.streaming).toBe(true);
    }
  });

  it("does not merge process entries across user turns", () => {
    const blocks = buildConversationBlocks([
      { kind: "text", id: "u1", role: "user", text: "One" },
      {
        kind: "tool",
        id: "t1",
        tool: { id: "t1", name: "Read", summary: "a", status: "done" },
      },
      { kind: "text", id: "a1", role: "assistant", text: "First" },
      { kind: "text", id: "u2", role: "user", text: "Two" },
      {
        kind: "tool",
        id: "t2",
        tool: { id: "t2", name: "Edit", summary: "b", status: "running" },
      },
    ]);

    const activities = blocks.filter((block) => block.kind === "activity");
    expect(activities).toHaveLength(2);
    expect(activities[0]?.entries[0]?.id).toBe("t1");
    expect(activities[1]?.entries[0]?.id).toBe("t2");
  });

  it("leaves ordinary conversations unchanged", () => {
    const items: ChatItem[] = [
      { kind: "text", id: "u1", role: "user", text: "Hello" },
      { kind: "text", id: "a1", role: "assistant", text: "Hi" },
    ];

    expect(buildConversationBlocks(items)).toEqual(
      items.map((item) => ({ kind: "item", item })),
    );
  });
});
