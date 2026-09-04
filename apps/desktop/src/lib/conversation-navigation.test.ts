import { describe, expect, it } from "vitest";
import type { ChatItem } from "@claude-desktop/shared";
import { buildConversationAnchors } from "./conversation-navigation";

describe("buildConversationAnchors", () => {
  it("creates one anchor per user task and uses the final AI conclusion", () => {
    const items: ChatItem[] = [
      { kind: "text", id: "u-1", role: "user", text: "  First\n question " },
      {
        kind: "tool",
        id: "tool-1",
        tool: { id: "t", name: "Read", summary: "x", status: "done" },
      },
      { kind: "usage", id: "usage-1", usage: { inputTokens: 4 } },
      { kind: "text", id: "sys-1", role: "system", text: "system" },
      { kind: "text", id: "a-1", role: "assistant", text: "Answer here" },
      { kind: "text", id: "a-empty", role: "assistant", text: "   " },
    ];

    expect(buildConversationAnchors(items)).toEqual([
      { id: "u-1", preview: "Answer here" },
    ]);
  });

  it("truncates long conclusions without exposing the assistant id", () => {
    const anchors = buildConversationAnchors([
      { kind: "text", id: "user-id", role: "user", text: "Question" },
      { kind: "text", id: "long-id", role: "assistant", text: "x".repeat(180) },
    ]);

    expect(anchors[0]?.id).toBe("user-id");
    expect(anchors[0]?.preview.endsWith("…")).toBe(true);
    expect(anchors[0]?.preview.length).toBe(120);
  });

  it("uses only the last assistant message before the next task", () => {
    const anchors = buildConversationAnchors([
      { kind: "text", id: "u-1", role: "user", text: "First" },
      { kind: "text", id: "a-1", role: "assistant", text: "Working" },
      { kind: "text", id: "a-2", role: "assistant", text: "Final one" },
      { kind: "text", id: "u-2", role: "user", text: "Second" },
      { kind: "text", id: "a-3", role: "assistant", text: "Final two" },
    ]);

    expect(anchors).toEqual([
      { id: "u-1", preview: "Final one" },
      { id: "u-2", preview: "Final two" },
    ]);
  });

  it("keeps an empty conclusion while a task has not answered yet", () => {
    expect(
      buildConversationAnchors([
        { kind: "text", id: "u-1", role: "user", text: "Still running" },
        {
          kind: "tool",
          id: "tool-1",
          tool: { id: "tool-1", name: "Bash", summary: "test", status: "running" },
        },
      ]),
    ).toEqual([{ id: "u-1", preview: "" }]);
  });
});
