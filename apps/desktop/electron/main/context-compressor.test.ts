import { describe, expect, it, vi } from "vitest";
import {
  compressContext,
  KEEP_RECENT_ITEMS,
  splitItemsForCompression,
  transcriptToText,
} from "./context-compressor";
import type { ChatItem } from "@claude-desktop/shared";

function textItems(count: number): ChatItem[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "text",
    id: `item-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `Message ${i}`,
  }));
}

describe("transcriptToText", () => {
  it("renders user and assistant messages", () => {
    const items: ChatItem[] = [
      { kind: "text", id: "1", role: "user", text: "Hello" },
      { kind: "text", id: "2", role: "assistant", text: "Hi there" },
      { kind: "tool", id: "3", tool: { id: "t1", name: "Read", summary: "a.txt", status: "done" } },
    ];
    expect(transcriptToText(items)).toBe("User: Hello\n\nAssistant: Hi there");
  });
});

describe("splitItemsForCompression", () => {
  it("keeps all items when below threshold", () => {
    const items = textItems(KEEP_RECENT_ITEMS);
    const { summarizable, kept } = splitItemsForCompression(items);
    expect(summarizable.length).toBe(0);
    expect(kept.length).toBe(KEEP_RECENT_ITEMS);
  });

  it("summarizes older items and keeps recent ones", () => {
    const items = textItems(KEEP_RECENT_ITEMS + 3);
    const { summarizable, kept } = splitItemsForCompression(items);
    expect(summarizable.length).toBe(3);
    expect(kept.length).toBe(KEEP_RECENT_ITEMS);
    expect(kept[0]?.id).toBe(`item-${items.length - KEEP_RECENT_ITEMS}`);
  });
});

describe("compressContext", () => {
  it("returns kept items and summary when there are older items", async () => {
    const items = textItems(KEEP_RECENT_ITEMS + 2);
    const summarize = vi.fn().mockResolvedValue("Summary of older messages.");
    const result = await compressContext(items, { summarize });
    expect(result.compressedCount).toBe(2);
    expect(result.items.length).toBe(KEEP_RECENT_ITEMS + 1);
    expect(result.items[0]?.kind).toBe("text");
    if (result.items[0]?.kind === "text") {
      expect(result.items[0].role).toBe("system");
      expect(result.items[0].text).toContain("Summary of older messages.");
    }
  });

  it("does nothing when no items are old enough", async () => {
    const items = textItems(KEEP_RECENT_ITEMS - 1);
    const summarize = vi.fn();
    const result = await compressContext(items, { summarize });
    expect(summarize).not.toHaveBeenCalled();
    expect(result.compressedCount).toBe(0);
    expect(result.items.length).toBe(KEEP_RECENT_ITEMS - 1);
  });
});
