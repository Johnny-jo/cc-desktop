import { describe, expect, it, vi } from "vitest";
import {
  buildContinuationPrompt,
  compressContext,
  createContextCompressor,
  splitItemsForCompression,
  transcriptToText,
} from "./context-compressor";
import type { ChatItem } from "@claude-desktop/shared";

function textItems(count: number): ChatItem[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "text",
    id: `item-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    text: `Message ${i}`,
  }));
}

it("summarizes through the app-owned Provider runtime instead of a configured external port", async () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "native summary" }] }));
  vi.stubGlobal("fetch", upstream);
  try {
    const compressor = createContextCompressor(() => ({ defaultModel: "openai-1/gpt-test" }), () => ({ origin: "http://127.0.0.1:41234", token: "ephemeral-local-token" }));
    expect((await compressor.compress(textItems(8))).summaryText).toBe("native summary");
    expect(upstream).toHaveBeenCalledWith("http://127.0.0.1:41234/v1/messages", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ephemeral-local-token" }) }));
  } finally { vi.unstubAllGlobals(); }
});

describe("transcriptToText", () => {
  it("renders user and assistant messages", () => {
    const items: ChatItem[] = [
      { kind: "text", id: "1", role: "user", text: "Hello" },
      { kind: "text", id: "2", role: "assistant", text: "Hi there" },
      {
        kind: "tool",
        id: "3",
        tool: {
          id: "t1",
          name: "Read",
          summary: "a.txt",
          status: "done",
          resultPreview: "file body",
        },
      },
    ];
    const text = transcriptToText(items);
    expect(text).toContain("User: Hello");
    expect(text).toContain("Assistant: Hi there");
    expect(text).toContain("Tool: Read — a.txt [done]");
    expect(text).toContain("result: file body");
  });
});

describe("splitItemsForCompression", () => {
  it("keeps all items when below threshold", () => {
    const items = textItems(6);
    const { summarizable, kept } = splitItemsForCompression(items);
    expect(summarizable.length).toBe(0);
    expect(kept).toEqual(items);
  });

  it("summarizes older items and keeps recent ones", () => {
    const items = textItems(9);
    const { summarizable, kept } = splitItemsForCompression(items);
    expect(summarizable.length).toBe(4);
    expect(kept[0]).toMatchObject({ id: "item-4", role: "user" });
  });
});

describe("compressContext", () => {
  it("gives each summary batch its own deadline and reports batch progress", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const onProgress = vi.fn();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "Summary" }] })));
    try {
      const compressor = createContextCompressor(() => ({ defaultModel: "model" }), () => ({ origin: "http://localhost", token: "fixture" }));
      await compressor.compress([{ kind: "text", id: "u", role: "user", text: "界".repeat(25_000) }], { onProgress });
      expect(timeout.mock.calls.filter(([ms]) => ms === 600_000)).toHaveLength(1);
      expect(timeout.mock.calls.filter(([ms]) => ms === 180_000).length).toBeGreaterThan(1);
      expect(onProgress.mock.calls.map(([progress]) => progress.batch)).toEqual([1, 2, 3]);
    } finally { timeout.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("summarizes an oversized single turn in UTF-8-safe batches without splitting the published turn", async () => {
    const items: ChatItem[] = [
      { kind: "text", id: "u", role: "user", text: "ORIGINAL_GOAL" },
      { kind: "tool", id: "t", tool: { id: "call", name: "Read", summary: "Read source", status: "done", resultPreview: "界".repeat(25_000) } },
      { kind: "text", id: "a", role: "assistant", text: "FINAL_STEP" },
    ];
    const original = JSON.stringify(items);
    const calls: string[] = [];
    const result = await compressContext(items, { summarize: async text => { calls.push(text); return "SUMMARY"; } });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.join("")).toContain("ORIGINAL_GOAL");
    expect(calls.join("")).toContain("FINAL_STEP");
    expect(calls.join("").match(/界/g)).toHaveLength(25_000);
    expect(calls.join("")).not.toContain("�");
    expect(result.compressedCount).toBe(items.length);
    expect(JSON.stringify(items)).toBe(original);
  });

  it("can compact a short visible history when measured SDK occupancy requires it", async () => {
    const summarize = vi.fn(async () => "High-occupancy summary");
    const result = await compressContext(textItems(2), { summarize }, { force: true });
    expect(summarize).toHaveBeenCalledOnce();
    expect(result.compressedCount).toBe(2);
  });

  it("sends original older images to the summary model and keeps recent images without counting base64 as text", async () => {
    const items = textItems(10);
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: Buffer.alloc(220_000, 1).toString("base64") } };
    for (const index of [0, 8]) {
      const item = items[index];
      if (item.kind === "text") item.attachments = [{ name: `image-${index}.png`, path: `D:/image-${index}.png`, kind: "image", size: 220_000, mimeType: "image/png" }];
    }
    const bodies: Array<{ messages: Array<{ content: unknown }> }> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_, init) => {
      bodies.push(JSON.parse(String(init!.body)));
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "Visual details retained" }] });
    }));
    try {
      const compressor = createContextCompressor(() => ({ defaultModel: "vision" }), () => ({ origin: "http://localhost", token: "fixture" }));
      const result = await compressor.compress(items, { handoffBudget: 150_000, loadAttachments: () => [image] });
      expect(result.compressedCount).toBe(4);
      expect(bodies.flatMap(body => body.messages[0].content)).toContainEqual(image);
      expect(result.items).toContain(items[8]);
      expect(JSON.stringify(result.items)).not.toContain(image.source.data);
    } finally { vi.unstubAllGlobals(); }
  });

  it("moves a whole retained attachment turn into the summary when it cannot fit the handoff", async () => {
    const items = textItems(10);
    if (items[8].kind === "text") items[8].attachments = [{ name: "picture.png", path: "D:/picture.png", kind: "image", size: 1, mimeType: "image/png" }];
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "YQ==" } };
    const summarize = vi.fn(async (_text: string, _media?: unknown[]) => "Summary");
    const result = await compressContext(items, { summarize }, { handoffBudget: 4000, loadAttachments: () => [image] });
    expect(result.compressedCount).toBe(items.length);
    expect(summarize.mock.calls.flatMap(call => call[1] ?? [])).toContainEqual(image);
  });

  it("rejects an unsupported summary budget before spending or changing history", async () => {
    const items = textItems(10);
    if (items[0].kind === "text") items[0].attachments = [{ name: "picture.png", path: "D:/picture.png", kind: "image", size: 1, mimeType: "image/png" }];
    const summarize = vi.fn();
    await expect(compressContext(items, { summarize }, { contextLimit: 2000, loadAttachments: () => [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } },
    ] })).rejects.toThrow(/context window.*attachment/i);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("keeps the question owning a long first turn beside its remaining replies", async () => {
    const items: ChatItem[] = [{ kind: "text", id: "first", role: "user", text: "Original request" },
      ...Array.from({ length: 12 }, (_, i): ChatItem => ({ kind: "text", id: String(i), role: "assistant", text: String(i) }))];
    const result = await compressContext(items, { summarize: async () => "Summary" });
    expect(result.items.filter(row => row.id === "first")).toHaveLength(1);
    expect(result.compressedCount).toBe(0);
    expect(result.items).toEqual(items);
  });
  it("returns kept items and summary when there are older items", async () => {
    const items = textItems(8);
    const summarize = vi.fn().mockResolvedValue("Summary of older messages.");
    const result = await compressContext(items, { summarize });
    expect(result.compressedCount).toBe(2);
    expect(result.items.length).toBe(7);
    expect(result.items[0]?.kind).toBe("text");
    if (result.items[0]?.kind === "text") {
      expect(result.items[0].role).toBe("system");
      expect(result.items[0].text).toContain("Summary of older messages.");
    }
  });

  it("does nothing when no items are old enough", async () => {
    const items = textItems(5);
    const summarize = vi.fn();
    const result = await compressContext(items, { summarize });
    expect(summarize).not.toHaveBeenCalled();
    expect(result.compressedCount).toBe(0);
    expect(result.items).toEqual(items);
  });
});

it("rejects a truncated auxiliary response and uses the requested model", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({
    content: [{ type: "text", text: "unfinished" }], stop_reason: "max_tokens",
  }));
  vi.stubGlobal("fetch", fetcher);
  try {
    const compressor = createContextCompressor(() => ({ defaultModel: "desktop" }), () => ({ origin: "http://localhost", token: "token" }));
    await expect(compressor.compress(textItems(10), { model: "seat" })).rejects.toThrow(/truncat|incomplete/i);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).model).toBe("seat");
  } finally { vi.unstubAllGlobals(); }
});

it("preserves the provider's concrete failure reason for the conversation notice", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ error: { message: "This model does not support images" } }, { status: 400 })));
  try {
    const compressor = createContextCompressor(() => ({ defaultModel: "text-only" }), () => ({ origin: "http://localhost", token: "fixture" }));
    await expect(compressor.compress(textItems(10))).rejects.toThrow("HTTP 400): This model does not support images");
  } finally { vi.unstubAllGlobals(); }
});

it("merges whole-turn batches within a small context budget and propagates a later failure", async () => {
  const history: ChatItem[] = Array.from({ length: 9 }, (_, i) => ({
    id: "u" + i, kind: "text", role: "user", text: `turn-${i}:${"界".repeat(260)}:end-${i}`,
  }));
  const calls: string[] = [];
  const summarize = async (text: string) => {
    calls.push(text);
    if (calls.length === 3) throw new Error("temporary provider failure");
    return "prior summary " + calls.length;
  };
  await expect(compressContext(history, { summarize }, { contextLimit: 3200 })).rejects.toThrow("temporary provider failure");
  expect(calls[1]).toContain("prior summary 1");
  expect(calls.join("")).not.toContain("turn-8");
  for (const text of calls) {
    expect(Buffer.byteLength(text)).toBeLessThan(2400);
    for (const [, id] of text.matchAll(/turn-(\d+):/g)) expect(text).toContain(":end-" + id);
  }
});

it("stops a pending auxiliary request when the session cancels", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>((_, init) => new Promise((_, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetcher);
  try {
    const compressor = createContextCompressor(() => ({ defaultModel: "desktop" }), () => ({ origin: "http://localhost", token: "token" }));
    const compressing = compressor.compress(textItems(10), { signal: controller.signal });
    controller.abort();
    await expect(compressing).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

describe("buildContinuationPrompt", () => {
  it("includes auto-continue instruction when requested", () => {
    const text = buildContinuationPrompt("goals and files…", {
      autoContinue: true,
    });
    expect(text).toContain("This session is being continued");
    expect(text).toContain("goals and files…");
    expect(text).toContain("Continue with the last task");
  });

  it("omits auto-continue for manual compact handoff", () => {
    const text = buildContinuationPrompt("goals and files…", {
      autoContinue: false,
    });
    expect(text).toContain("This session is being continued");
    expect(text).not.toContain("Continue with the last task");
  });
});
