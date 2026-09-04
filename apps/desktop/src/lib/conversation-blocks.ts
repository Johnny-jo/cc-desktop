import type { ChatItem, ToolCardState, TurnUsage } from "@claude-desktop/shared";

type TextChatItem = Extract<ChatItem, { kind: "text" }>;

export type ActivityEntry =
  | {
      kind: "thinking";
      id: string;
      text: string;
      active: boolean;
    }
  | {
      kind: "compaction";
      id: string;
    }
  | {
      kind: "tool";
      id: string;
      tool: ToolCardState;
    };

export type ConversationBlock =
  | { kind: "item"; item: ChatItem }
  | {
      kind: "activity";
      id: string;
      entries: ActivityEntry[];
      usage?: TurnUsage;
    }
  | {
      kind: "turn-footer";
      id: string;
      text: string;
      usage: TurnUsage;
    };

function isThinkingItem(
  item: ChatItem,
): item is TextChatItem & { role: "assistant" } {
  return (
    item.kind === "text" &&
    item.role === "assistant" &&
    Boolean(item.thinking || item.thinkingText)
  );
}

function isContextSummaryItem(item: ChatItem): boolean {
  return (
    item.kind === "text" &&
    item.role === "system" &&
    item.id.startsWith("ctx-summary-")
  );
}

function isAutoCompactionItem(item: ChatItem): boolean {
  return (
    item.kind === "text" &&
    item.role === "system" &&
    item.id.startsWith("ctx-continue-")
  );
}

function withoutThinking(item: TextChatItem): TextChatItem {
  const { thinking: _thinking, thinkingText: _thinkingText, ...answer } = item;
  return answer;
}

function buildTurnBlocks(items: ChatItem[]): ConversationBlock[] {
  const entries: ActivityEntry[] = [];
  let firstActivityIndex = -1;

  items.forEach((item, index) => {
    if (isAutoCompactionItem(item)) {
      if (firstActivityIndex < 0) firstActivityIndex = index;
      entries.push({ kind: "compaction", id: item.id });
      return;
    }
    if (item.kind === "tool") {
      if (firstActivityIndex < 0) firstActivityIndex = index;
      entries.push({ kind: "tool", id: item.id, tool: item.tool });
      return;
    }
    if (isThinkingItem(item)) {
      if (firstActivityIndex < 0) firstActivityIndex = index;
      entries.push({
        kind: "thinking",
        id: item.id,
        text: item.thinkingText ?? "",
        active: Boolean(item.thinking && item.streaming),
      });
    }
  });

  const usageItem = items.find(
    (item): item is Extract<ChatItem, { kind: "usage" }> =>
      item.kind === "usage",
  );
  const responseText = items
    .filter(
      (item): item is TextChatItem & { role: "assistant" } =>
        item.kind === "text" &&
        item.role === "assistant" &&
        Boolean(item.text.trim()),
    )
    .map((item) => item.text.trim())
    .join("\n\n");
  const blocks: ConversationBlock[] = [];
  let activityInserted = firstActivityIndex < 0 || entries.length === 0;
  let footerInserted = false;

  items.forEach((item, index) => {
    if (!activityInserted && index >= firstActivityIndex) {
      blocks.push({
        kind: "activity",
        id: `activity-${entries[0]!.id}`,
        entries,
        ...(usageItem ? { usage: usageItem.usage } : {}),
      });
      activityInserted = true;
    }

    if (item.kind === "usage") {
      if (!footerInserted && usageItem) {
        blocks.push({
          kind: "turn-footer",
          id: `turn-footer-${usageItem.id}`,
          text: responseText,
          usage: usageItem.usage,
        });
        footerInserted = true;
      }
      return;
    }
    if (item.kind === "tool" || isAutoCompactionItem(item)) return;
    if (isThinkingItem(item)) {
      if (!item.text.trim()) return;
      blocks.push({ kind: "item", item: withoutThinking(item) });
      return;
    }
    blocks.push({ kind: "item", item });
  });

  return blocks;
}

/**
 * Build display-only blocks without changing the persisted flat transcript.
 * Process entries are grouped inside the user turn that owns them.
 */
export function buildConversationBlocks(items: ChatItem[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let turn: ChatItem[] = [];

  const flushTurn = () => {
    if (turn.length === 0) return;
    blocks.push(...buildTurnBlocks(turn));
    turn = [];
  };

  for (const item of items) {
    // The generated summary remains in the persisted context but is an
    // implementation detail; the user-facing timeline gets one compact event.
    if (isContextSummaryItem(item)) continue;
    if (item.kind === "text" && item.role === "user") {
      flushTurn();
      blocks.push({ kind: "item", item });
      continue;
    }
    turn.push(item);
  }
  flushTurn();

  return blocks;
}
