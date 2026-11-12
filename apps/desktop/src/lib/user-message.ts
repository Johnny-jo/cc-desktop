import type { ChatItem } from "@claude-desktop/shared";

type TextMessage = Extract<ChatItem, { kind: "text" }>;

/** The attachment list is rendered separately from the user's actual text. */
export function userMessageText(item: TextMessage): string {
  if (!item.attachments?.length) return item.text;
  const suffix = `\n\n[Attached: ${item.attachments.map(attachment => attachment.name).join(", ")}]`;
  const text = item.text.trimEnd();
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : item.text;
}

export function userMessageDate(item: TextMessage): Date | null {
  // Older persisted user IDs contain their original submission timestamp.
  const legacyTime = /^user-(\d{13})-\d+$/.exec(item.id)?.[1];
  const timestamp = item.at ?? (legacyTime ? Number(legacyTime) : undefined);
  if (timestamp === undefined || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
}
