import type { AppSettings, ChatItem } from "@claude-desktop/shared";

export type CompressorDeps = {
  /** Calls a lightweight model to summarize the provided transcript text. */
  summarize: (text: string) => Promise<string>;
};

export type CompressionResult = {
  items: ChatItem[];
  summaryText: string;
  compressedCount: number;
};

export type ContextCompressor = {
  compress(items: ChatItem[]): Promise<CompressionResult>;
};

/** Number of recent items to keep verbatim after compression. */
export const KEEP_RECENT_ITEMS = 6;

/**
 * Structured compact prompt inspired by Claude Code's auto-compact template.
 * Forces the model to preserve goals, files, errors, pending work, and next step
 * so the agent can resume without re-deriving context.
 */
export const COMPACT_SUMMARY_PROMPT = `Your team's answer should report a detailed but concise summary of the conversation so far. This summary will replace earlier turns in the context window, so it must retain every detail needed to continue work without the original messages.

Before summarizing, do a brief mental checklist:
- What did the user explicitly ask for (all requests, not just the latest)?
- Which files/paths were read or changed, and why?
- What errors happened and how were they fixed?
- What is still unfinished right now?

Pay special attention to the most recent messages and any user corrections ("don't do X", "use Y instead").

Your summary MUST include these sections (use the same numbering/headings):

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List important technologies, APIs, constraints, and decisions.
3. Files and Code Sections: Enumerate files examined, modified, or created. For each, note why it mattered and include short critical snippets only when necessary.
4. Errors and Fixes: List errors encountered and how they were fixed, plus any user feedback about wrong approaches.
5. Problem Solving: Document solved problems and any ongoing troubleshooting.
6. All User Messages: List ALL non-tool user messages (critical for intent and feedback).
7. Pending Tasks: Outline unfinished work the user still expects.
8. Current Work: Precisely what was being worked on immediately before this summary (files, steps, partial progress).
9. Optional Next Step: The single next action that continues the most recent task. Quote the latest relevant user/assistant lines so the task does not drift. If the last task was fully concluded, say so and do not invent new work.

Write the summary in the same language as the conversation. Prefer concrete paths, symbols, and decisions over vague restatements. Do not wrap the whole answer in XML tags.`;

/** Build the user/system message that restarts the agent after compaction. */
export function buildContinuationPrompt(
  summaryText: string,
  opts?: { autoContinue?: boolean },
): string {
  const base =
    `This session is being continued from a previous conversation that ran out of context. ` +
    `The conversation is summarized below:\n\n${summaryText.trim()}`;
  if (opts?.autoContinue) {
    return (
      `${base}\n\n` +
      `Please continue the conversation from where we left it off without asking the user any further questions. ` +
      `Continue with the last task that you were asked to work on. If the summary says the last task was already concluded, briefly confirm status and wait for the next user instruction.`
    );
  }
  return (
    `${base}\n\n` +
    `Use this summary as prior context for the user's next message. Do not re-ask for information already captured above.`
  );
}

/** Build a plain-text transcript from chat items suitable for summarization. */
export function transcriptToText(items: ChatItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      const label =
        item.role === "user"
          ? "User"
          : item.role === "assistant"
            ? "Assistant"
            : "System";
      const text = item.text.trim();
      if (!text) continue;
      lines.push(`${label}: ${text}`);
    } else if (item.kind === "tool") {
      const t = item.tool;
      const status = t.status ?? "unknown";
      const summary = (t.summary || "").trim();
      const preview = (t.resultPreview || "").trim();
      let line = `Tool: ${t.name}${summary ? ` — ${summary}` : ""} [${status}]`;
      if (preview) {
        // Cap tool output so summarizer stays focused.
        const clipped =
          preview.length > 400 ? `${preview.slice(0, 400)}…` : preview;
        line += `\n  result: ${clipped}`;
      }
      lines.push(line);
    }
    // usage footers are noise for summarization
  }
  return lines.join("\n\n");
}

/** Decide which items to summarize and which to keep. */
export function splitItemsForCompression(items: ChatItem[]): {
  summarizable: ChatItem[];
  kept: ChatItem[];
} {
  if (items.length <= KEEP_RECENT_ITEMS) {
    return { summarizable: [], kept: [...items] };
  }
  const kept = items.slice(-KEEP_RECENT_ITEMS);
  const summarizable = items.slice(0, items.length - KEEP_RECENT_ITEMS);
  return { summarizable, kept };
}

/** Summarize older items and prepend a system summary item. */
export async function compressContext(
  items: ChatItem[],
  deps: CompressorDeps,
): Promise<CompressionResult> {
  const { summarizable, kept } = splitItemsForCompression(items);
  if (summarizable.length === 0) {
    return { items: kept, summaryText: "", compressedCount: 0 };
  }

  const text = transcriptToText(summarizable);
  const summaryText = await deps.summarize(text);
  const summaryItem: ChatItem = {
    kind: "text",
    id: `ctx-summary-${Date.now()}`,
    role: "system",
    text: `Context compressed (${summarizable.length} items summarized). Earlier conversation summary:\n\n${summaryText}`,
  };
  return {
    items: [summaryItem, ...kept],
    summaryText,
    compressedCount: summarizable.length,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function createCpaSummarizer(
  getSettings: () => AppSettings,
  getToken: () => string | null,
): (text: string) => Promise<string> {
  return async (text: string) => {
    const settings = getSettings();
    const token = getToken();
    if (!token) throw new Error("CPA token not set for summarization");
    const url = `http://127.0.0.1:${settings.cpaPort}/v1/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: settings.defaultModel,
        // Structured compact needs room for files/errors/pending work.
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: `${COMPACT_SUMMARY_PROMPT}\n\nConversation to summarize:\n\n${text}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Summarize failed: ${res.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
      );
    }
    const json = (await res.json()) as Record<string, unknown>;
    const content = json.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
      }
    }
    const choices = json.choices;
    if (Array.isArray(choices) && isRecord(choices[0])) {
      const message = choices[0].message;
      if (isRecord(message) && typeof message.content === "string") {
        return message.content;
      }
    }
    throw new Error("Summarize returned empty content");
  };
}

export function createContextCompressor(
  getSettings: () => AppSettings,
  getToken: () => string | null,
): ContextCompressor {
  return {
    compress: (items: ChatItem[]) =>
      compressContext(items, { summarize: createCpaSummarizer(getSettings, getToken) }),
  };
}
