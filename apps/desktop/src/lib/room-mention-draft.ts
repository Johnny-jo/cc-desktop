import type { RoomMention } from "@claude-desktop/shared";

export type RoomMentionDraft = { text: string; mentions: RoomMention[] };
export type RoomDraftEdit = { start: number; end: number; inputType: string };

/** Use the actual replacement interval, including equal-text paste/IME edits. */
export function editRoomMentionDraft(
  draft: RoomMentionDraft, start: number, end: number, inserted: string,
): RoomMentionDraft {
  start = Math.max(0, Math.min(start, draft.text.length));
  end = Math.max(start, Math.min(end, draft.text.length));
  const delta = inserted.length - (end - start);
  const mentions = draft.mentions.flatMap(m => {
    // The trailing ASCII space belongs to the protected edit interval.
    const overlaps = start === end
      ? start > m.start && start <= m.end
      : start < m.end + 1 && end > m.start;
    if (overlaps) return [];
    return [end <= m.start ? { ...m, start: m.start + delta, end: m.end + delta } : m];
  });
  return { text: draft.text.slice(0, start) + inserted + draft.text.slice(end), mentions };
}

export function insertRoomMention(
  draft: RoomMentionDraft, start: number, end: number, seat: { id: string; name: string },
): RoomMentionDraft {
  start = Math.max(0, Math.min(start, draft.text.length));
  end = Math.max(start, Math.min(end, draft.text.length));
  const lead = start > 0 && !/\s/.test(draft.text[start - 1]) ? " " : "";
  const next = editRoomMentionDraft(draft, start, end, `${lead}@${seat.name} `);
  const mentionStart = start + lead.length;
  next.mentions.push({ seatId: seat.id, start: mentionStart, end: mentionStart + seat.name.length + 1 });
  next.mentions.sort((a, b) => a.start - b.start);
  return next;
}

/** Reconcile native input with beforeinput's selection; diff is a fallback only. */
export function reconcileRoomMentionDraft(
  draft: RoomMentionDraft, text: string, edit?: RoomDraftEdit | null,
): RoomMentionDraft {
  if (edit) {
    let { start, end } = edit;
    const removed = draft.text.length - text.length;
    if (start === end && removed > 0) {
      if (edit.inputType.endsWith("Backward")) start = Math.max(0, start - removed);
      else if (edit.inputType.endsWith("Forward")) end += removed;
    }
    const insertedLength = text.length - draft.text.length + end - start;
    if (insertedLength >= 0 && text.slice(0, start) === draft.text.slice(0, start)
      && text.slice(start + insertedLength) === draft.text.slice(end)) {
      return editRoomMentionDraft(draft, start, end, text.slice(start, start + insertedLength));
    }
  }
  let start = 0;
  while (start < draft.text.length && start < text.length && draft.text[start] === text[start]) start++;
  let end = draft.text.length;
  let nextEnd = text.length;
  while (end > start && nextEnd > start && draft.text[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
  return editRoomMentionDraft(draft, start, end, text.slice(start, nextEnd));
}
