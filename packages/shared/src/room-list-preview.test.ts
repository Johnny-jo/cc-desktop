import { describe, expect, it } from "vitest";
import * as shared from "./index";
import type { RoomSnapshot, RoomTimelineItem } from "./room-protocol";
import type { RoomAttachmentRef } from "./room-attachments";

const members: RoomSnapshot["members"] = [
  { userId: "alice", name: "Alice account", role: "host" },
  { userId: "bob", name: "Bob", role: "member" },
];
const seats: RoomSnapshot["seats"] = [
  { id: "human", kind: "human", name: "Alice", occupantUserId: "alice", takenOverBy: null, sessionId: null, running: false, agentName: null },
  { id: "agent", kind: "agent", name: "开发", occupantUserId: "bob", takenOverBy: null, sessionId: null, running: false, agentName: "Persona" },
];
const message = (patch: Partial<RoomTimelineItem> = {}): RoomTimelineItem => ({
  id: "chat", at: 100, seatId: "human", authorUserId: "alice", authorLabel: "Alice",
  kind: "user", text: "hello", ...patch,
});
const attachment = (kind: RoomAttachmentRef["kind"]): RoomAttachmentRef => ({
  id: "attachment", name: "private-name", size: 12, mimeType: "application/octet-stream",
  kind, sha256: "a".repeat(64),
});

function preview(items: RoomTimelineItem[], overrides: Partial<RoomSnapshot> = {}) {
  // Assert the public API before calling it, so the first red run is an assertion
  // about the missing feature, not an unresolved-module error.
  expect(shared).toHaveProperty("roomListPreview", expect.any(Function));
  const snapshot = { items, members, seats, ...overrides };
  return shared.roomListPreview(snapshot);
}

describe("room list preview", () => {
  it("uses the last real message in timeline order, ignoring later activity and live thinking", () => {
    expect(preview([
      message({ at: 900 }),
      message({ id: "reply", at: 200, kind: "assistant", seatId: "agent", authorUserId: null, authorLabel: "old agent name", text: "答复" }),
      message({ kind: "tool", at: 300, text: "tool output" }),
      message({ kind: "system", at: 400, text: "log" }),
      message({ source: "kernel", at: 500, text: "kernel railway" }),
    ], { liveExec: [{ turnId: "turn", seatId: "agent", text: "progress", thinking: "secret reasoning", at: 1000 }] }))
      .toEqual({ authorLabel: "开发", text: "答复", at: 200 });
  });

  it.each([{ items: [] }, { items: [message({ kind: "tool" })] }, { items: [message({ kind: "system" })] }])(
    "has no preview or invented timestamp without a real message (%#)", ({ items }) => {
      expect(preview(items)).toBeUndefined();
    },
  );

  it("keeps the actual human author when a legacy user message targets an Agent seat", () => {
    expect(preview([message({ seatId: "agent", authorLabel: "开发", text: "给开发的要求" })]))
      .toEqual({ authorLabel: "Alice", text: "给开发的要求", at: 100 });
  });

  it("resolves a missing human label by authorUserId without borrowing the target's occupant", () => {
    expect(preview([message({ seatId: "agent", authorLabel: "" })])?.authorLabel).toBe("Alice");
    expect(preview([message({ seatId: "agent", authorUserId: "departed", authorLabel: "" })])?.authorLabel).toBe("成员");
  });

  it("retains a departed author's recorded name and a removed Agent's recorded name", () => {
    expect(preview([message({ authorUserId: "departed", authorLabel: "旧成员" })])?.authorLabel).toBe("旧成员");
    expect(preview([message({ kind: "assistant", seatId: "removed", authorUserId: null, authorLabel: "旧 Agent" })])?.authorLabel).toBe("旧 Agent");
  });

  it("matches Timeline's Agent seat for assistant items even with a legacy user field", () => {
    expect(preview([message({ kind: "assistant", seatId: "agent" })])?.authorLabel).toBe("开发");
  });

  it("uses the human author's seat for a game even when its legacy target is an Agent", () => {
    expect(preview([message({ kind: "game", seatId: "agent", authorLabel: "old name", text: "掷出 ⚄", game: { type: "dice", value: "⚄" } })]))
      .toEqual({ authorLabel: "Alice", text: "掷出 ⚄", at: 100 });
  });

  it("falls back to authorLabel when the author's human seat is absent", () => {
    expect(preview([message({ seatId: "agent", authorLabel: "recorded Alice" })], { seats: [seats[1]] })?.authorLabel)
      .toBe("recorded Alice");
  });

  it.each(["image", "text", "binary"] as const)("labels a %s attachment without exposing its name", kind => {
    expect(preview([message({ text: "", attachments: [attachment(kind)] })]))
      .toEqual({ authorLabel: "Alice", text: kind === "image" ? "[图片]" : "[文件]", at: 100 });
  });

  it("includes attachment labels alongside the message body", () => {
    expect(preview([message({ text: "看这里", attachments: [attachment("image"), attachment("binary")] })])?.text)
      .toBe("看这里 [图片] [文件]");
  });

  it("shows recall at the original message time without leaking body, attachment, or quote", () => {
    const recalled = message({
      recalled: true, text: "private body", attachments: [attachment("image")],
      quote: { id: "quote", authorLabel: "private author", text: "private quote" },
    });
    expect(preview([message({ at: 50 }), recalled]))
      .toEqual({ authorLabel: "Alice", text: "已撤回", at: 100 });
  });

  it("skips empty assistant output and reasoning-only text", () => {
    expect(preview([
      message(),
      message({ kind: "assistant", authorUserId: null, text: " \n\t " }),
      message({ kind: "assistant", authorUserId: null, text: "<think>private reasoning</think>" }),
    ])).toEqual({ authorLabel: "Alice", text: "hello", at: 100 });
  });

  it("returns one line of plain text without markup, link destinations, or reasoning", () => {
    expect(preview([message({ text: "<think>secret</think>\n## **进展**\n[说明](https://example.test/private) 与 `代码` <b>完成</b>\t\u0000" })])?.text)
      .toBe("进展 说明 与 代码 完成");
  });

  it("bounds author and body without splitting a surrogate pair or mutating the input", () => {
    const item = message({ authorUserId: "departed", authorLabel: "名".repeat(150), text: "😀".repeat(500) });
    const before = structuredClone(item);
    const result = preview([item])!;
    expect(result).toBeDefined();
    expect(result.authorLabel.length).toBeLessThanOrEqual(80);
    expect(result.text.length).toBeLessThanOrEqual(160);
    expect(result.text).toMatch(/…$/);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(item).toEqual(before);
  });
});
