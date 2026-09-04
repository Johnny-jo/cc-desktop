import type { ChatItem } from "@claude-desktop/shared";

export type ConversationAnchor = {
  id: string;
  /** Final assistant conclusion for this user task; empty while still running. */
  preview: string;
};

const PREVIEW_LIMIT = 120;

function compactPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= PREVIEW_LIMIT) return compact;
  return `${compact.slice(0, PREVIEW_LIMIT - 1).trimEnd()}…`;
}

/** One stable jump target per user task, previewing its final AI conclusion. */
export function buildConversationAnchors(
  items: ChatItem[],
): ConversationAnchor[] {
  const anchors: ConversationAnchor[] = [];
  let current: ConversationAnchor | null = null;

  for (const item of items) {
    if (item.kind !== "text") continue;

    if (item.role === "user") {
      current = { id: item.id, preview: "" };
      anchors.push(current);
      continue;
    }

    if (item.role === "assistant" && current) {
      const conclusion = compactPreview(item.text);
      if (conclusion) current.preview = conclusion;
    }
  }

  return anchors;
}
