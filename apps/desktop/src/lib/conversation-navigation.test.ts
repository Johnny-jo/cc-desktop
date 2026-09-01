import { describe, expect, it } from "vitest";
import type { ChatItem } from "@claude-desktop/shared";
import { buildConversationAnchors } from "./conversation-navigation";

describe("buildConversationAnchors", () => {
  it("keeps stable user/assistant ids and skips non-conversation rows", () => {
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
      { id: "u-1", role: "user", preview: "First question" },
      { id: "a-1", role: "assistant", preview: "Answer here" },
    ]);
  });

  it("truncates long previews without changing the target id", () => {
    const anchors = buildConversationAnchors([
      { kind: "text", id: "long-id", role: "assistant", text: "x".repeat(180) },
    ]);

    expect(anchors[0]?.id).toBe("long-id");
    expect(anchors[0]?.preview.endsWith("…")).toBe(true);
    expect(anchors[0]?.preview.length).toBe(120);
  });
});

