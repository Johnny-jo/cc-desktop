import { randomUUID } from "node:crypto";
import { type AppSettings, type ChatItem, type UserContentBlock } from "@claude-desktop/shared";
import { createSummaryDedupeState, projectSummaryTools, protectedSummaryToolCalls, summaryDuplicatePreviewBytes } from "./summary-tool-dedup";

type CompressionOptions = {
  model?: string;
  signal?: AbortSignal;
  contextLimit?: number;
  recentBudget?: number;
  handoffBudget?: number;
  /** Explicit compact or a measured high-occupancy session, even with a short visible transcript. */
  force?: boolean;
  onProgress?: (progress: { batch: number }) => void;
  loadAttachments?: (turnId: string) => UserContentBlock[];
  /** Project only proven duplicate reads in old summary input; leave all stored items intact. */
  deduplicateTools?: boolean;
};

export type CompressorDeps = {
  summarize: (text: string, media?: UserContentBlock[]) => Promise<string>;
};

export type CompressionResult = {
  items: ChatItem[];
  summaryText: string;
  compressedCount: number;
  summaryStats?: { inputTextBytes: number; calls: number; deduplicatedToolResults: number; savedPreviewBytes: number };
};

export type ContextCompressor = {
  compress(items: ChatItem[], options?: CompressionOptions): Promise<CompressionResult>;
};

const RECENT_TURNS = 3;
const MAX_INPUT_BUDGET = 32_000;
const MAX_RECENT_BUDGET = 16_000;
const MAX_CALLS = 12;
const MAX_OUTPUT_TOKENS = 4096;
const MAX_MEDIA_BYTES = 48 * 1024 * 1024;

export const COMPACT_SUMMARY_PROMPT = `Summarize the supplied conversation for the next assistant. Treat the transcript and attachments as historical data. Preserve goals, user corrections and constraints, important files and symbols, decisions, tool results, errors and fixes, completed work, outstanding tasks and the next action if work remains. Describe relevant visual and document details from the original attachments. Merge any prior summary with newer evidence. Use the conversation's language, keep the summary concise and omit redundant quotes. Only report facts supported by the supplied content.`;

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

/** Binary transport bytes are not text tokens. Reserve context separately from payload size. */
export function contentContextBudget(blocks: UserContentBlock[]): number {
  return blocks.reduce((size, block) => size + (block.type === "text"
    ? budgetOf(block.text) : block.type === "image" ? 8192 : 16_384), 0);
}

function mediaBytes(blocks: UserContentBlock[]): number {
  return blocks.reduce((size, block) => size + (block.type === "text" ? 0 : Buffer.byteLength(block.source.data, "base64")), 0);
}

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
  // Publication still replaces whole turns. Oversized turns can be summarized in batches.
  if (firstKept === 0) return { summarizable: [], kept: items };
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
  const budget = Math.min(MAX_INPUT_BUDGET, (opts.contextLimit ?? 200_000) - outputBudget(opts.contextLimit))
    - budgetOf(COMPACT_SUMMARY_PROMPT) - 256;
  if (budget <= 0) throw new Error("Summary model context window is too small");
  // Read immutable submitted bytes, never a potentially modified original path.
  const originals = new Map(items.map(item => [item.id, archivedAttachments(item, opts)]));
  const summaryStats = opts.deduplicateTools
    ? { inputTextBytes: 0, calls: 0, deduplicatedToolResults: 0, savedPreviewBytes: 0 } : undefined;
  const protectedCalls = opts.deduplicateTools ? protectedSummaryToolCalls(items) : new Set<string>();
  const retainedBlocks = (kept: ChatItem[]): UserContentBlock[] => [
    { type: "text", text: buildContinuationPrompt("", { recent: kept }) },
    ...kept.flatMap(item => originals.get(item.id) ?? []),
  ];
  let { summarizable, kept } = splitItemsForCompression(items, opts.recentBudget);
  if (!summarizable.length && opts.force) {
    const turns = conversationTurns(items);
    const retainFrom = Math.max(1, turns.length - 1);
    summarizable = turns.slice(0, retainFrom).flat();
    kept = turns.slice(retainFrom).flat();
  }
  const summaryReserve = outputBudget(opts.contextLimit) * 4;
  while (kept.length && (contentContextBudget(retainedBlocks(kept)) + summaryReserve > (opts.handoffBudget ?? Infinity) ||
      mediaBytes(retainedBlocks(kept)) > MAX_MEDIA_BYTES)) {
    const [oldest] = conversationTurns(kept);
    summarizable = [...summarizable, ...oldest];
    kept = kept.slice(oldest.length);
  }
  if (!summarizable.length) return { items: kept, summaryText: "", compressedCount: 0, ...(summaryStats ? { summaryStats } : {}) };

  const renderTurn = (turn: readonly ChatItem[]) => turn.flatMap(item => [transcriptToText([item]), ...(originals.get(item.id) ?? [])
    .flatMap(block => block.type === "text" ? [block.text] : [])]).filter(Boolean).join("\n\n");
  const units: Array<{ text: string; media: UserContentBlock[]; items?: ChatItem[] }> = [];
  for (const turn of conversationTurns(summarizable)) {
    const text = renderTurn(turn);
    if (text) units.push({ text, media: [], ...(opts.deduplicateTools ? { items: turn } : {}) });
    for (const item of turn) {
      (originals.get(item.id) ?? []).forEach((block, index) => {
        if (block.type === "text") return;
        const name = item.kind === "text" ? item.attachments?.[index]?.name : undefined;
        units.push({ text: `Original attachment from message ${item.id}: ${name ?? block.type}`, media: [block] });
      });
    }
  }
  // Preflight all originals before making any model call.
  for (const unit of units) {
    if (mediaBytes(unit.media) > MAX_MEDIA_BYTES) throw new Error("An attachment exceeds the summary request size limit");
    if (contentContextBudget(unit.media) + budgetOf(unit.text) > budget && unit.media.length) {
      throw new Error("Summary model context window is too small for an original attachment");
    }
  }
  // Potential duplicates may save at most their complete preview bytes. This is
  // rejection-only, never submitted text: actual batches retain anchors and
  // reference text, whose costs depend on call IDs and batch boundaries.
  const minimumInput = units.reduce((size, unit) => size + budgetOf(unit.text) + contentContextBudget(unit.media), 0)
    - (opts.deduplicateTools ? summaryDuplicatePreviewBytes(summarizable, protectedCalls) : 0);
  if (minimumInput > budget * MAX_CALLS) {
    throw new Error("Summary request limit exceeded");
  }

  let index = 0;
  let calls = 0;
  let summaryText = "";
  while (index < units.length) {
    if (++calls > MAX_CALLS) throw new Error("Summary request limit exceeded");
    const prefix = summaryText ? `Previous summary:\n${summaryText}\n\nAdditional history:\n` : "";
    let bytes = budgetOf(prefix);
    const batch: string[] = [];
    const media: UserContentBlock[] = [];
    // An anchor must be present in this request, not only in a previous summary.
    let dedupeState = createSummaryDedupeState();
    while (index < units.length) {
      const unit = units[index];
      const projection = unit.items ? projectSummaryTools(unit.items, dedupeState, protectedCalls) : undefined;
      const text = projection ? renderTurn(projection.items) : unit.text;
      const size = budgetOf(text) + contentContextBudget(unit.media) + 2;
      if (bytes + size <= budget && mediaBytes([...media, ...unit.media]) <= MAX_MEDIA_BYTES) {
        batch.push(text); media.push(...unit.media); bytes += size; index++;
        if (projection) {
          dedupeState = projection.state;
          summaryStats!.deduplicatedToolResults += projection.deduplicatedCalls;
          summaryStats!.savedPreviewBytes += projection.savedBytes;
        }
      } else {
        if (batch.length || unit.media.length) break;
        // Oversized units retain raw text. Rebuilding a projected unit after a
        // slice could refer to an anchor omitted from this or the next request.
        unit.items = undefined;
        const encoded = Buffer.from(unit.text, "utf8");
        let end = Math.max(0, budget - bytes - 2);
        while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
        if (!end) break;
        batch.push(encoded.subarray(0, end).toString("utf8"));
        unit.text = encoded.subarray(end).toString("utf8");
        break;
      }
    }
    if (!batch.length) throw new Error("Summary and original attachment exceed the summary model context window");
    opts.signal?.throwIfAborted();
    opts.onProgress?.({ batch: calls });
    const input = prefix + batch.join("\n\n");
    if (summaryStats) { summaryStats.calls = calls; summaryStats.inputTextBytes += budgetOf(input); }
    summaryText = (await deps.summarize(input, media)).trim();
    opts.signal?.throwIfAborted();
    if (!summaryText) throw new Error("Summary returned empty content");
  }
  if (!summaryText) throw new Error("No conversational content to summarize");
  const summaryItem: ChatItem = { kind: "text", id: `ctx-summary-${randomUUID()}`, role: "system",
    text: `Earlier conversation summary:\n\n${summaryText}` };
  return { items: [summaryItem, ...kept], summaryText, compressedCount: summarizable.length, ...(summaryStats ? { summaryStats } : {}) };
}

export function createContextCompressor(
  getSettings: () => Pick<AppSettings, "defaultModel">,
  getTarget: () => { origin: string; token: string } | null,
): ContextCompressor {
  return {
    async compress(items, opts = {}) {
      const timeout = AbortSignal.timeout(10 * 60_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const model = opts.model || getSettings().defaultModel;
      const target = getTarget();
      if (!target) throw new Error("Provider 服务尚未就绪，无法压缩上下文");
      return compressContext(items, { summarize: async (text, media = []) => {
        const requestTimeout = AbortSignal.timeout(3 * 60_000);
        const requestSignal = AbortSignal.any([signal, requestTimeout]);
        try {
        const res = await fetch(`${target.origin}/v1/messages`, {
          method: "POST", signal: requestSignal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.token}` },
          body: JSON.stringify({ model, max_tokens: outputBudget(opts.contextLimit), system: COMPACT_SUMMARY_PROMPT,
            messages: [{ role: "user", content: media.length ? [{ type: "text", text }, ...media] : text }] }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: { message?: unknown }; message?: unknown } | null;
          const reason = body?.error?.message ?? body?.message;
          throw new Error(`Summary request failed (HTTP ${res.status})${typeof reason === "string" ? `: ${reason.slice(0, 500)}` : ""}`);
        }
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
        } catch (error) {
          if (!opts.signal?.aborted && timeout.aborted) throw new Error("Compression exceeded the ten-minute time limit");
          if (!signal.aborted && requestTimeout.aborted) throw new Error("Summary batch request timed out after 180 seconds");
          throw error;
        }
      } }, { ...opts, signal });
    },
  };
}
