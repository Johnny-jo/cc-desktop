import { describe, expect, it } from "vitest";
import { userMessageDate, userMessageText } from "./user-message";

describe("user message display", () => {
  const item = { kind: "text" as const, id: "user-1794446700000-1", role: "user" as const, text: "Original" };

  it("retains the recorded time when a persisted message is read again", () => {
    expect(userMessageDate({ ...item, at: 1794446701234 })?.getTime()).toBe(1794446701234);
  });

  it("recovers the original time of legacy user IDs", () => {
    expect(userMessageDate(item)?.getTime()).toBe(1794446700000);
  });

  it("does not invent a timestamp for older messages without a known time", () => {
    expect(userMessageDate({ ...item, id: "imported-message" })).toBeNull();
    expect(userMessageDate({ ...item, at: Number.NaN })).toBeNull();
  });

  it("keeps attachment-like text when no rich attachments are present", () => {
    const text = "Example\n\n[Attached: notes.md]";
    expect(userMessageText({ ...item, text })).toBe(text);
  });

  it("removes the actual attachment suffix even when a filename contains brackets", () => {
    const attachment = { name: "notes [v2].md", path: "D:/p/notes [v2].md", size: 12, mimeType: "text/markdown", kind: "text" as const };
    expect(userMessageText({ ...item, text: "Original\n\n[Attached: notes [v2].md]", attachments: [attachment] })).toBe("Original");
  });
});
