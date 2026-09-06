import type { RoomListMessagePreview, RoomSnapshot } from "./room-protocol";

function plainText(text: string): string {
  return text
    .replace(/<(think|thinking|analysis)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*```[^\n]*$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+\.\s+)/gm, "")
    .replace(/(\*\*|__|~~|`+)([\s\S]*?)\1/g, "$2")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=$|\s|[.,!?，。！？])/g, "$1$2")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bounded(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

/** A bounded projection of the already available timeline; never loads history. */
export function roomListPreview(
  room: Pick<RoomSnapshot, "items" | "seats">,
): RoomListMessagePreview | undefined {
  for (let i = room.items.length - 1; i >= 0; i--) {
    const item = room.items[i];
    if ((item.kind !== "user" && item.kind !== "assistant" && item.kind !== "game") || item.source === "kernel") continue;

    const text = item.recalled
      ? "已撤回"
      : [plainText(item.text), ...(item.attachments ?? []).map(a => a.kind === "image" ? "[图片]" : "[文件]")]
          .filter(Boolean).join(" ");
    if (!text) continue;

    const isAgent = item.kind === "assistant";
    // Legacy human messages may target an Agent seat. Its name and occupant
    // describe the recipient. Match Timeline's human seat by authorUserId.
    const name = isAgent
      ? room.seats.find(s => s.id === item.seatId && s.kind === "agent")?.name
      : item.authorUserId
        ? room.seats.find(s => s.kind === "human" && s.occupantUserId === item.authorUserId)?.name
        : undefined;
    const authorLabel = plainText(name ?? "") || plainText(item.authorLabel) || (isAgent ? "Agent" : "成员");
    return { authorLabel: bounded(authorLabel, 80), text: bounded(text, 160), at: item.at };
  }
  return undefined;
}
