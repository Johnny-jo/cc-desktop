/** A deliberate selection; end excludes the mandatory trailing ASCII space. */
export type RoomMention = { seatId: string; start: number; end: number };

export function validateRoomMentions(
  text: string,
  records: unknown,
  seats: readonly { id: string; name: string }[],
): RoomMention[] {
  if (!Array.isArray(records) || records.length > 64) return [];
  const out: RoomMention[] = [];
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const { seatId, start, end } = raw as RoomMention;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end >= text.length) continue;
    const seat = seats.find(s => s.id === seatId);
    if (!seat || text.slice(start, end) !== `@${seat.name}` || text[end] !== " ") continue;
    if (out.some(m => start < m.end + 1 && end + 1 > m.start)) continue;
    out.push({ seatId, start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Legacy text matching for non-command consumers; never authorizes a task. */
export function findRoomMentionedSeats<T extends { id: string; name: string }>(
  text: string,
  seats: readonly T[],
): T[] {
  const names = [...seats].filter(s => s.name).sort((a, b) => b.name.length - a.name.length);
  const found: T[] = [];
  const seen = new Set<string>();
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at > 0 && !/[\s([{（【「『“"'，,。！!？?；;：:、]/u.test(text[at - 1])) continue;
    const seat = names.find(s => {
      if (!text.startsWith(s.name, at + 1)) return false;
      const next = text.slice(at + 1 + s.name.length);
      return !next || !/^[\p{L}\p{N}_-]/u.test(next);
    });
    if (!seat) continue;
    if (!seen.has(seat.id)) {
      seen.add(seat.id);
      found.push(seat);
    }
    at += seat.name.length;
  }
  return found;
}
