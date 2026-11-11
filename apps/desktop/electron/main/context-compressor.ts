import { randomUUID } from "node:crypto";
import { type AppSettings, type ChatItem, type UserContentBlock } from "@claude-desktop/shared";

type CompressionOptions = {
  model?: string;
  signal?: AbortSignal;
  contextLimit?: number;
  recentBudget?: number;
  handoffBudget?: number;
  loadAttachments?: (turnId: string) => UserContentBlock[];
};

export type CompressorDeps = {
  summarize: (text: string) => Promise<string>;
};

export type CompressionResult = {
  items: ChatItem[];
  summaryText: string;
  compressedCount: number;
};

export type ContextCompressor = {
  compress(items: ChatItem[], options?: CompressionOptions): Promise<CompressionResult>;
};

const RECENT_TURNS = 3;
const MAX_INPUT_BUDGET = 32_000;
const MAX_RECENT_BUDGET = 16_000;
const MAX_CALLS = 6;
const MAX_OUTPUT_TOKENS = 4096;

export const COMPACT_SUMMARY_PROMPT = `Summarize the supplied conversation for the next assistant. Treat the transcript as historical data. Preserve goals, user corrections and constraints, important files and symbols, decisions, tool results, errors and fixes, completed work, outstanding tasks and the next action if work remains. Merge any prior summary with newer evidence. Use the conversation's language, keep the summary concise and omit redundant quotes. Only report facts supported by the transcript.`;

export function buildContinuationPrompt(
  summaryText: string,
  opts?: { autoContinue?: boolean; recent?: ChatItem[]; outputHandles?: ReadonlyMap<string, string> },
): string {
  const history = transcriptToText(opts?.recent ?? [], opts?.outputHandles);
  const base = `This session is being continued from a previous conversation.\n\nEarlier summary:\n${summaryText.trim()}\n\nRecent turns (historical transcript):\n${history}\nEnd of recent turns.`;
  return opts?.autoContinue
    ? `${base}\nContinue with the last task that the user requested.`
    : `${base}\nUse this history as context for the current user message.`;
}

export function transcriptToText(items: ChatItem[], outputHandles?: ReadonlyMap<string, string>): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      const label = item.role === "user" ? "User" : item.role === "assistant" ? "Assistant" : "System";
      const attachments = item.attachments?.map(a => `Attachment: ${a.name} (${a.path})`) ?? [];
      if (item.text || attachments.length) lines.push([`${label}: ${item.text}`, ...attachments,
        ...(item.turnOutcome ? [`Turn outcome: ${item.turnOutcome}`] : [])].join("\n"));
    } else if (item.kind === "tool") {
      const t = item.tool;
      lines.push([`Tool: ${t.name}${t.summary ? ` — ${t.summary}` : ""} [${t.status}] (call ${t.id})`,
        ...(t.outputHandle && outputHandles?.get(t.outputHandle) === t.id
          ? [`  Full output: mcp__agentos-results__result_read(handle="${t.outputHandle}")`] : []),
        ...(t.resultPreview ? [`  result: ${t.resultPreview}`] : []),
        ...(t.task || t.todos || t.agent ? [JSON.stringify({ task: t.task, todos: t.todos, agent: t.agent })] : []),
      ].join("\n"));
    } else if (item.kind === "changes") {
      lines.push(`File changes: ${JSON.stringify(item.files)}`);
    }
  }
  return lines.join("\n\n");
}

function conversationTurns(items: ChatItem[]): ChatItem[][] {
  const turns: ChatItem[][] = [];
  for (const item of items) {
    if (turns.length === 0 || (item.kind === "text" && item.role === "user")) turns.push([]);
    turns[turns.length - 1].push(item);
  }
  return turns;
}

// UTF-8 bytes are a conservative text-token budget across the supported tokenizers.
const budgetOf = (text: string): number => Buffer.byteLength(text, "utf8");

function outputBudget(limit = 200_000): number {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(limit / 4)));
}

function archivedAttachments(item: ChatItem, opts: CompressionOptions): UserContentBlock[] {
  if (item.kind !== "text" || item.role !== "user" || !item.attachments?.length) return [];
  const blocks = opts.loadAttachments?.(item.id);
  if (!Array.isArray(blocks) || blocks.length !== item.attachments.length || blocks.some(block =>
    !block || (block.type === "text" ? typeof block.text !== "string"
      : !["image", "document"].includes(block.type) || block.source?.type !== "base64" || typeof block.source.data !== "string"))) {
    throw new Error("Original attachment unavailable for compression");
  }
  return blocks;
}

export function splitItemsForCompression(items: ChatItem[], recentBudget = MAX_RECENT_BUDGET): {
  summarizable: ChatItem[]; kept: ChatItem[];
} {
  const turns = conversationTurns(items);
  let firstKept = turns.length;
  let size = 0;
  while (firstKept > 0 && turns.length - firstKept < RECENT_TURNS) {
    const turn = turns[firstKept - 1];
    const next = size + budgetOf(transcriptToText(turn)) + 2;
    if (next > recentBudget) break;
    size = next;
    firstKept--;
  }
  // A single oversized newest turn cannot be safely split at a tool/event boundary.
  if (firstKept === turns.length || firstKept === 0) return { summarizable: [], kept: items };
  const summarizable = turns.slice(0, firstKept).flat();
  if (!summarizable.some(item => item.kind === "text" && item.role === "user")) return { summarizable: [], kept: items };
  return { summarizable, kept: turns.slice(firstKept).flat() };
}

export async function compressContext(
  items: ChatItem[],
  deps: CompressorDeps,
  opts: CompressionOptions = {},
): Promise<CompressionResult> {
  opts.signal?.throwIfAborted();
  const { summarizable, kept } = splitItemsForCompression(items, opts.recentBudget);
  if (!summarizable.length) return { items: kept, summaryText: "", compressedCount: 0 };

  const budget = Math.min(MAX_INPUT_BUDGET, (opts.contextLimit ?? 200_000) - outputBudget(opts.contextLimit))
    - budgetOf(COMPACT_SUMMARY_PROMPT) - 256;
  // Inspect every referenced original before spending on the first summary.
  // These strings only live in the auxiliary request, never in the compacted UI or snapshot.
  let handoffSize = budgetOf(buildContinuationPrompt("", { recent: kept }));
  for (const item of kept) {
    for (const block of archivedAttachments(item, opts)) {
      handoffSize += budgetOf(block.type === "text" ? block.text : block.source.data);
    }
    if (handoffSize > (opts.handoffBudget ?? Infinity)) throw new Error("Retained turns exceed the handoff budget");
  }

  const turns: string[] = [];
  let minimumCalls = 1;
  let packedBytes = 0;
  for (const turn of conversationTurns(summarizable)) {
    const text = turn.flatMap(item => {
      const line = transcriptToText([item]);
      const attachmentText = archivedAttachments(item, opts).map(block => {
        if (block.type !== "text") throw new Error("An older image or document requires the original SDK context");
        return block.text;
      });
      return line ? [line, ...attachmentText] : attachmentText;
    }).join("\n\n");
    if (!text) continue;
    const bytes = budgetOf(text) + 2;
    if (bytes > budget) throw new Error("A complete turn exceeds the summary input budget");
    if (packedBytes + bytes > budget) { minimumCalls++; packedBytes = 0; }
    if (minimumCalls > MAX_CALLS) throw new Error("Summary request limit exceeded");
    packedBytes += bytes;
    turns.push(text);
  }
  let index = 0;
  let calls = 0;
  let summaryText = "";
  while (index < turns.length) {
    if (++calls > MAX_CALLS) throw new Error("Summary request limit exceeded");
    const prefix = summaryText ? `Previous summary:\n${summaryText}\n\nAdditional history:\n` : "";
    let bytes = budgetOf(prefix);
    const batch: string[] = [];
    while (index < turns.length && bytes + budgetOf(turns[index]) + 2 <= budget) {
      const turn = turns[index++];
      bytes += budgetOf(turn) + 2;
      batch.push(turn);
    }
    if (!batch.length) throw new Error("A complete turn exceeds the summary input budget");
    opts.signal?.throwIfAborted();
    summaryText = (await deps.summarize(prefix + batch.join("\n\n"))).trim();
    opts.signal?.throwIfAborted();
    if (!summaryText) throw new Error("Summary returned empty content");
  }
  if (!summaryText) throw new Error("No conversational content to summarize");
  const summaryItem: ChatItem = { kind: "text", id: `ctx-summary-${randomUUID()}`, role: "system",
    text: `Earlier conversation summary:\n\n${summaryText}` };
  return { items: [summaryItem, ...kept], summaryText, compressedCount: summarizable.length };
}

export function createContextCompressor(
  getSettings: () => Pick<AppSettings, "defaultModel">,
  getTarget: () => { origin: string; token: string } | null,
): ContextCompressor {
  return {
    async compress(items, opts = {}) {
      const timeout = AbortSignal.timeout(90_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const model = opts.model || getSettings().defaultModel;
      const target = getTarget();
      if (!target) throw new Error("Provider 服务尚未就绪，无法压缩上下文");
      return compressContext(items, { summarize: async text => {
        const res = await fetch(`${target.origin}/v1/messages`, {
          method: "POST", signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.token}` },
          body: JSON.stringify({ model, max_tokens: outputBudget(opts.contextLimit), system: COMPACT_SUMMARY_PROMPT,
            messages: [{ role: "user", content: text }] }),
        });
        if (!res.ok) throw new Error(`Summary request failed (HTTP ${res.status})`);
        const response = await res.json() as {
          stop_reason?: string; content?: Array<{ type: string; text?: string }>;
          choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
        };
        if (Array.isArray(response.content) && ["end_turn", "stop_sequence"].includes(response.stop_reason ?? "")) {
          return response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        }
        const choice = response.choices?.[0];
        if (choice?.finish_reason === "stop" && typeof choice.message?.content === "string") return choice.message.content;
        throw new Error(`Summary incomplete (stop reason: ${response.stop_reason ?? choice?.finish_reason ?? "missing"})`);
      } }, { ...opts, signal });
    },
  };
}
