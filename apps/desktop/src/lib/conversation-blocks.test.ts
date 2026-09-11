import { describe, expect, it } from "vitest";
import type { ChatItem, ToolCardState } from "@claude-desktop/shared";
import { buildConversationBlocks } from "./conversation-blocks";

type AgentStatus = NonNullable<ToolCardState["agent"]>["status"];

function toolItem(
  id: string,
  status: ToolCardState["status"],
  agentStatus?: AgentStatus,
): Extract<ChatItem, { kind: "tool" }> {
  return {
    kind: "tool",
    id,
    tool: {
      id,
      name: agentStatus ? "Agent" : "Read",
      summary: id,
      status,
      ...(agentStatus ? {
        agent: { id: `agent-${id}`, title: id, status: agentStatus, background: true },
      } : {}),
    },
  };
}

const user: ChatItem = { kind: "text", id: "u1", role: "user", text: "Work" };
const answer: ChatItem = { kind: "text", id: "a1", role: "assistant", text: "Answer", streaming: true };

describe("buildConversationBlocks", () => {
  it.each(["completed", "interrupted", "cancelled", "failed"] as const)("settles stale foreground activity after %s", outcome => {
    const pending = toolItem("pending", "running");
    const blocks = buildConversationBlocks([
      { ...user, turnOutcome: outcome }, pending,
      { kind: "text", id: "thinking", role: "assistant", text: "", thinking: true, thinkingText: "Working", streaming: true },
    ]);
    expect(blocks.some(block => block.kind === "live-activity")).toBe(false);
    const archive = blocks.find(block => block.kind === "activity");
    expect(archive).toMatchObject({ entries: [
      { displayStatus: outcome === "interrupted" || outcome === "cancelled" ? "stopped" : "unknown" },
      { active: false },
    ] });
    expect(pending.tool.status).toBe("running");
  });

  it("settles legacy idle calls but preserves independently running background agents", () => {
    const blocks = buildConversationBlocks([user, toolItem("pending", "running"), toolItem("background", "done", "running")], false);
    expect(blocks.find(block => block.kind === "activity")).toMatchObject({ entries: [{ id: "pending", displayStatus: "unknown" }] });
    expect(blocks.find(block => block.kind === "live-activity")).toMatchObject({ entries: [{ id: "background" }] });
  });

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

    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.kind).toBe("item");
    const activity = blocks[1];
    expect(activity?.kind).toBe("activity");
    if (activity?.kind === "activity") {
      expect(activity.entries.map((entry) => entry.kind)).toEqual([
        "tool",
        "compaction",
      ]);
    }
    expect(blocks[2]).toMatchObject({
      kind: "live-activity",
      entries: [{ kind: "thinking", id: "think1", active: true }],
    });
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
    expect(activities[1]).toMatchObject({ id: "activity-t2", entries: [] });
    expect(blocks.at(-1)).toMatchObject({
      kind: "live-activity",
      entries: [{ id: "t2" }],
    });
  });

  it("keeps a stable empty archive anchor when a turn starts with only live work", () => {
    const blocks = buildConversationBlocks([user, toolItem("t1", "running")]);

    expect(blocks).toEqual([
      { kind: "item", item: user },
      { kind: "activity", id: "activity-t1", entries: [] },
      {
        kind: "live-activity",
        id: "live-activity-t1",
        entries: [{ kind: "tool", id: "t1", tool: toolItem("t1", "running").tool }],
      },
    ]);
  });

  it.each([
    ["done", false],
    ["running", false],
    ["done", true],
    ["running", true],
  ] as const)("places the archive before introductory prose (tool %s, footer %s)", (status, withFooter) => {
    const intro: ChatItem = { kind: "text", id: "intro", role: "assistant", text: "I will inspect the project." };
    const first = toolItem("first", status);
    const usage: ChatItem = { kind: "usage", id: "usage1", usage: { durationMs: 1500 } };
    const blocks = buildConversationBlocks([user, intro, first, answer, ...(withFooter ? [usage] : [])]);

    expect(blocks.map(block => block.kind === "item" ? block.item.id : block.id)).toEqual([
      "u1", "activity-first", "intro", "a1",
      ...(status === "running" ? ["live-activity-first"] : []),
      ...(withFooter ? ["turn-footer-usage1"] : []),
    ]);
    expect(blocks[1]).toMatchObject({
      kind: "activity", id: "activity-first",
      entries: status === "running" ? [] : [first],
    });
    if (withFooter) {
      expect(blocks.at(-1)).toMatchObject({
        kind: "turn-footer", text: "I will inspect the project.\n\nAnswer",
      });
    }
  });

  it("places all parallel running tools after this turn's prose, once each", () => {
    const blocks = buildConversationBlocks([
      user,
      toolItem("first", "running"),
      toolItem("finished", "done"),
      toolItem("parallel", "running"),
      answer,
    ]);

    expect(blocks.map(block => block.kind)).toEqual(["item", "activity", "item", "live-activity"]);
    expect(blocks[1]).toMatchObject({ id: "activity-first", entries: [{ id: "finished" }] });
    expect(blocks[3]).toMatchObject({
      id: "live-activity-first",
      entries: [{ id: "first" }, { id: "parallel" }],
    });
    const ids = blocks.flatMap(block => "entries" in block ? block.entries.map(entry => entry.id) : []);
    expect(ids.sort()).toEqual(["finished", "first", "parallel"]);
  });

  it("keeps the first activity ID through out-of-order completion and subsequent work", () => {
    const intro: ChatItem = { kind: "text", id: "intro", role: "assistant", text: "Starting parallel work." };
    const snapshots = [
      [toolItem("first", "running"), toolItem("second", "running")],
      [toolItem("first", "running"), toolItem("second", "done")],
      [toolItem("first", "done"), toolItem("second", "done")],
      [toolItem("first", "done"), toolItem("second", "done"), toolItem("third", "running")],
    ];
    const before = structuredClone(snapshots);
    const blocks = snapshots.map(items => buildConversationBlocks([user, intro, ...items, answer]));

    expect(blocks.map(turn => turn.find(block => block.kind === "activity")?.id)).toEqual([
      "activity-first", "activity-first", "activity-first", "activity-first",
    ]);
    expect(blocks.map(turn => turn[1]?.kind)).toEqual(["activity", "activity", "activity", "activity"]);
    expect(blocks[1]?.find(block => block.kind === "activity")?.entries.map(entry => entry.id)).toEqual(["second"]);
    expect(blocks[2]?.find(block => block.kind === "activity")?.entries.map(entry => entry.id)).toEqual(["first", "second"]);
    expect(blocks[2]?.some(block => block.kind === "live-activity")).toBe(false);
    expect(blocks[3]?.at(-1)).toMatchObject({ id: "live-activity-first", entries: [{ id: "third" }] });
    expect(snapshots).toEqual(before);
  });

  it.each([false, true])("archives thinking when prose begins (thinking flag %s)", thinking => {
    const thought: ChatItem = {
      kind: "text", id: "thought", role: "assistant", text: "",
      thinking: true, thinkingText: "Reasoning", streaming: true,
    };
    const started = buildConversationBlocks([user, thought]);
    const responding = buildConversationBlocks([user, { ...thought, text: "Answer", thinking }]);

    expect(started[1]).toMatchObject({ id: "activity-thought", entries: [] });
    expect(started[2]).toMatchObject({ kind: "live-activity", entries: [{ id: "thought", active: true }] });
    expect(responding.map(block => block.kind)).toEqual(["item", "activity", "item"]);
    expect(responding[1]).toMatchObject({ id: "activity-thought", entries: [{ id: "thought", active: false }] });
    expect(responding[2]).toEqual({
      kind: "item", item: { kind: "text", id: "thought", role: "assistant", text: "Answer", streaming: true },
    });
  });

  it("keeps live agents inside the turn that owns them, before the next user's turn", () => {
    const blocks = buildConversationBlocks([
      user, toolItem("first", "done", "running"), answer,
      { ...user, id: "u2" }, toolItem("second", "running"), { ...answer, id: "a2" },
    ]);

    expect(blocks.map(block => block.kind)).toEqual([
      "item", "activity", "item", "live-activity", "item", "activity", "item", "live-activity",
    ]);
    expect(blocks[3]).toMatchObject({ id: "live-activity-first", entries: [{ id: "first" }] });
    expect(blocks[7]).toMatchObject({ id: "live-activity-second", entries: [{ id: "second" }] });
  });

  it("keeps a background agent live after the tool return and before the response footer", () => {
    const blocks = buildConversationBlocks([
      user, toolItem("background", "done", "running"), answer,
      { kind: "usage", id: "usage1", usage: { durationMs: 1500 } },
    ]);

    expect(blocks.map(block => block.kind)).toEqual(["item", "activity", "item", "live-activity", "turn-footer"]);
    expect(blocks[1]).toMatchObject({ id: "activity-background", entries: [], usage: { durationMs: 1500 } });
    expect(blocks[3]).toMatchObject({ entries: [{ id: "background" }] });
  });

  it.each(["completed", "failed", "unknown", "paused", "stopped"] as const)(
    "archives structured Agent status %s even when its tool status still says running", agentStatus => {
      const blocks = buildConversationBlocks([user, toolItem("agent", "running", agentStatus)]);

      expect(blocks.map(block => block.kind)).toEqual(["item", "activity"]);
      expect(blocks[1]).toMatchObject({ entries: [{ id: "agent", tool: { agent: { status: agentStatus } } }] });
    },
  );

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
