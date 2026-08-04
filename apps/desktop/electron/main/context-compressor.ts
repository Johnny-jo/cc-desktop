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
export const KEEP_RECENT_ITEMS = 4;

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
      lines.push(`${label}: ${item.text.trim()}`);
    }
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
    text: `Context compressed. Earlier conversation summary:\n${summaryText}`,
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
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content:
              `Summarize the following conversation in 2-3 sentences, preserving key decisions, facts, and action items. Keep it concise.\n\n${text}`,
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
