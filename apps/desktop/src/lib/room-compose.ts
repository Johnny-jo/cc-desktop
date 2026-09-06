import { validateRoomMentions, type RoomMention, type RoomSeat } from "@claude-desktop/shared";

export function resolveRoomComposeTargets(
  text: string,
  seats: readonly Pick<RoomSeat, "id" | "name" | "kind" | "occupantUserId">[],
  localUserId: string | undefined,
  selectedSeatId: string | null,
  records: readonly RoomMention[] = [],
): { sendSeatId: string | undefined; stopSeatIds: string[] } {
  const mentions = validateRoomMentions(text, records, seats);
  const agents = [...new Set(mentions.filter(m => seats.some(s => s.id === m.seatId && s.kind === "agent")).map(m => m.seatId))];
  const own = localUserId ? seats.find(s => s.kind === "human" && s.occupantUserId === localUserId) : undefined;
  const selected = seats.find(s => s.id === selectedSeatId);
  return {
    sendSeatId: own?.id,
    stopSeatIds: agents.length
      ? agents
      : selected?.kind === "agent" ? [selected.id] : [],
  };
}
