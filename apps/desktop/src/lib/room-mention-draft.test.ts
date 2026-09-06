import { describe, expect, it } from "vitest";
import { validateRoomMentions } from "@claude-desktop/shared";
import { editRoomMentionDraft, insertRoomMention, reconcileRoomMentionDraft } from "./room-mention-draft";

const seat = { id: "agent", name: "开发" };
const empty = { text: "", mentions: [] };
const marked = { text: "@开发 正文", mentions: [{ seatId: seat.id, start: 0, end: 3 }] };

describe("deliberate room mention drafts", () => {
  it("creates metadata only on selection and always adds an ASCII space", () => {
    expect(editRoomMentionDraft(empty, 0, 0, "@开发 ").mentions).toEqual([]);
    const draft = insertRoomMention({ text: "开头\n结尾", mentions: [] }, 2, 2, seat);
    expect(draft.text).toBe("开头 @开发 \n结尾");
    expect(draft.mentions).toEqual([{ seatId: "agent", start: 3, end: 6 }]);
    expect(validateRoomMentions(draft.text, draft.mentions, [seat])).toEqual(draft.mentions);
  });
  it("shifts existing marks when body text is inserted or removed before them", () => {
    const shifted = editRoomMentionDraft(marked, 0, 0, "前文😀 ");
    expect(shifted.mentions).toEqual([{ seatId: "agent", start: 5, end: 8 }]);
    expect(editRoomMentionDraft(shifted, 0, 5, "")).toEqual(marked);
    expect(editRoomMentionDraft(marked, 4, 6, "新正文").mentions).toEqual(marked.mentions);
  });
  it.each([[1, 2, "测"], [3, 4, ""], [3, 4, " "], [3, 3, " "], [0, 3, "@开发"]])(
    "invalidates touched name or delimiter (%s..%s), including identical paste", (start, end, text) => {
      expect(editRoomMentionDraft(marked, start, end, text).mentions).toEqual([]);
    },
  );
  it("does not resurrect marks after editing and retyping the original name", () => {
    const changed = editRoomMentionDraft(marked, 1, 3, "测试");
    expect(editRoomMentionDraft(changed, 1, 3, "开发").mentions).toEqual([]);
  });
  it("replaces the candidate at the caret while preserving following text and marks", () => {
    const draft = insertRoomMention({ text: "@开 然后 @开发 ", mentions: [{ seatId: "agent", start: 6, end: 9 }] }, 0, 2, seat);
    expect(draft.text).toBe("@开发  然后 @开发 ");
    expect(draft.mentions).toEqual([{ seatId: "agent", start: 0, end: 3 }, { seatId: "agent", start: 8, end: 11 }]);
  });
  it("uses the actual edit range even when replacing identical content", () => {
    expect(reconcileRoomMentionDraft(marked, marked.text, { start: 0, end: 3, inputType: "insertFromPaste" }).mentions).toEqual([]);
  });
  it("reconciles caret insertion, backspace and selection replacement", () => {
    expect(reconcileRoomMentionDraft(marked, "前" + marked.text, { start: 0, end: 0, inputType: "insertText" }).mentions[0].start).toBe(1);
    expect(reconcileRoomMentionDraft(marked, "@开发正文", { start: 4, end: 4, inputType: "deleteContentBackward" }).mentions).toEqual([]);
    expect(reconcileRoomMentionDraft(marked, "@开发 更新", { start: 4, end: 6, inputType: "insertText" }).mentions).toEqual(marked.mentions);
  });
});
