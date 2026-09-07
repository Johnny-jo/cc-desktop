import type { ChatItem, ToolCardState, TurnUsage, TurnOutcome } from "@claude-desktop/shared";

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
      outcome?: TurnOutcome;
    }
  | {
      kind: "live-activity";
      id: string;
      entries: ActivityEntry[];
    }
  | {
      kind: "turn-footer";
      id: string;
      text: string;
      usage: TurnUsage;
    };

/** Agent execution can outlive the tool call that launched it. */
export function getToolActivityStatus(
  tool: ToolCardState,
): ToolCardState["status"] | "unknown" | "stopped" | "paused" {
  const agentStatus = tool.agent?.status;
  if (agentStatus == null) return tool.status;
  switch (agentStatus) {
    case "running":
    case "unknown":
    case "stopped":
    case "paused":
      return agentStatus;
    case "completed":
      return "done";
    case "failed":
      return "error";
    default:
      return "unknown";
  }
}

export function isLiveActivityEntry(entry: ActivityEntry): boolean {
  if (entry.kind === "thinking") return entry.active;
  return entry.kind === "tool" && getToolActivityStatus(entry.tool) === "running";
}

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

function buildTurnBlocks(items: ChatItem[], outcome?: TurnOutcome): ConversationBlock[] {
  const entries: ActivityEntry[] = [];

  items.forEach((item) => {
    if (isAutoCompactionItem(item)) {
      entries.push({ kind: "compaction", id: item.id });
      return;
    }
    if (item.kind === "tool") {
      entries.push({ kind: "tool", id: item.id, tool: item.tool });
      return;
    }
    if (isThinkingItem(item)) {
      entries.push({
        kind: "thinking",
        id: item.id,
        text: item.thinkingText ?? "",
        active: Boolean(item.thinking && item.streaming && !item.text.trim()),
      });
    }
  });

  const archived = entries.filter(entry => !isLiveActivityEntry(entry));
  const live = entries.filter(isLiveActivityEntry);
  // The anchor belongs to the turn's first activity, including when it is live.
  // Keep the empty archive block so its React key survives parallel completions.
  const firstActivityId = entries[0]?.id;

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
  // History leads the turn, even when prose preceded its first activity.
  if (entries.length > 0) {
    blocks.push({
      kind: "activity",
      id: `activity-${firstActivityId}`,
      entries: archived,
      ...(outcome ? { outcome } : {}),
      ...(usageItem ? { usage: usageItem.usage } : {}),
    });
  }
  let footerInserted = false;

  items.forEach((item) => {
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

  if (live.length > 0) {
    const footerIndex = blocks.findIndex(block => block.kind === "turn-footer");
    blocks.splice(footerIndex < 0 ? blocks.length : footerIndex, 0, {
      kind: "live-activity",
      id: `live-activity-${firstActivityId}`,
      entries: live,
    });
  }

  return blocks;
}

/**
 * Build display-only blocks without changing the persisted flat transcript.
 * Process entries are grouped inside the user turn that owns them.
 */
export function buildConversationBlocks(items: ChatItem[]): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let turn: ChatItem[] = [];
  let outcome: TurnOutcome | undefined;

  const flushTurn = () => {
    if (turn.length === 0) return;
    blocks.push(...buildTurnBlocks(turn, outcome));
    turn = [];
  };

  for (const item of items) {
    // The generated summary remains in the persisted context but is an
    // implementation detail; the user-facing timeline gets one compact event.
    if (isContextSummaryItem(item)) continue;
    if (item.kind === "text" && item.role === "user") {
      flushTurn();
      outcome = item.turnOutcome;
      blocks.push({ kind: "item", item });
      continue;
    }
    turn.push(item);
  }
  flushTurn();

  return blocks;
}

/** Prepending part of a turn must not remount its already expanded activity. */
export function preserveActivityBlockIds(blocks: ConversationBlock[], previous: ConversationBlock[]): ConversationBlock[] {
  const byEntry = new Map<string, string>();
  for (const block of previous) {
    if (block.kind !== "activity" && block.kind !== "live-activity") continue;
    for (const entry of block.entries) byEntry.set(`${block.kind}:${entry.id}`, block.id);
  }
  const used = new Set<string>();
  return blocks.map(block => {
    if (block.kind !== "activity" && block.kind !== "live-activity") return block;
    const oldId = block.entries.map(entry => byEntry.get(`${block.kind}:${entry.id}`)).find(id => id && !used.has(id));
    const id = oldId ?? block.id;
    used.add(id);
    return id === block.id ? block : { ...block, id };
  });
}
