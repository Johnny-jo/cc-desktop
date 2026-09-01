import type { ChatItem } from "@claude-desktop/shared";

export type ConversationAnchor = {
  id: string;
  role: "user" | "assistant";
  preview: string;
};

const PREVIEW_LIMIT = 120;

function compactPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= PREVIEW_LIMIT) return compact;
  return `${compact.slice(0, PREVIEW_LIMIT - 1).trimEnd()}…`;
}

/** User/assistant message ids that can act as stable transcript jump targets. */
export function buildConversationAnchors(
  items: ChatItem[],
): ConversationAnchor[] {
  const anchors: ConversationAnchor[] = [];
  for (const item of items) {
    if (
      item.kind !== "text" ||
      (item.role !== "user" && item.role !== "assistant")
    ) {
      continue;
    }
    const preview = compactPreview(item.text);
    if (!preview) continue;
    anchors.push({ id: item.id, role: item.role, preview });
  }
  return anchors;
}

