import type { ChatItem } from "./models";

export const TRANSCRIPT_TURNS_PER_PAGE = 12;
export const TRANSCRIPT_TURN_WINDOW = 2 * TRANSCRIPT_TURNS_PER_PAGE;

export type TranscriptPageOptions = {
  limit?: number;
  turnLimit?: number;
};

/** A legacy transcript without its initial user row still has one partial turn. */
export function transcriptTurnStarts(items: ChatItem[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (i === 0 || (item.kind === "text" && item.role === "user")) starts.push(i);
  }
  return starts;
}

/** Retain complete turns at one end, including all their replies and tool records. */
export function transcriptTurnRange(items: ChatItem[], limit: number, edge: "older" | "newer") {
  const starts = transcriptTurnStarts(items);
  if (starts.length <= limit) return { start: 0, end: items.length };
  return edge === "older"
    ? { start: 0, end: starts[limit]! }
    : { start: starts[starts.length - limit]!, end: items.length };
}
