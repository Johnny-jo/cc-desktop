import { describe, expect, it, vi } from "vitest";
import { observeProviderResponse } from "./provider-usage-reader";

const encoder = new TextEncoder();
const sse = (value: unknown) => `event: ${(value as { type: string }).type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const start = (usage?: unknown) => ({ type: "message_start", message: { type: "message", role: "assistant", content: [], ...(usage === undefined ? {} : { usage }) } });
const delta = (usage: unknown) => ({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage });
const stop = { type: "message_stop" };
const message = (usage?: unknown) => ({ type: "message", role: "assistant", content: [{ type: "text", text: "你好" }], stop_reason: "end_turn", ...(usage === undefined ? {} : { usage }) });
const result = (values: Record<string, unknown> = {}) => ({ outcome: "success", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usageReported: false, ...values });
const streamingResponse = (stream: ReadableStream<Uint8Array> | string) => new Response(stream, { headers: { "content-type": "text/event-stream", "request-id": "request-1" } });

describe("provider response usage observation", () => {
  it("passes through bytes and headers while merging cumulative usage by field", async () => {
    const raw = sse(start({ input_tokens: 8, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }))
      + sse(delta({ output_tokens: 4 })) + sse(delta({ input_tokens: 8, output_tokens: 6 })) + sse(stop);
    const complete = vi.fn();
    const response = observeProviderResponse(streamingResponse(raw), { onComplete: complete });
    expect(response.headers.get("request-id")).toBe("request-1");
    expect(await response.text()).toBe(raw);
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ inputTokens: 8, outputTokens: 6, cacheReadTokens: 3, cacheCreationTokens: 2, usageReported: true }));
  });

  it("incrementally decodes CRLF events split across every UTF-8 byte", async () => {
    const raw = ": keepalive\r\n\r\n" + sse(start({ input_tokens: 0 })) + sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好🌏" } }) + sse(delta({ output_tokens: 0 })) + sse(stop);
    const bytes = encoder.encode(raw); let index = 0;
    const upstream = new ReadableStream<Uint8Array>({ pull(controller) { if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index)); else controller.close(); } }, { highWaterMark: 0 });
    const complete = vi.fn();
    expect(await observeProviderResponse(streamingResponse(upstream), { onComplete: complete }).text()).toBe(raw);
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ usageReported: true }));
  });

  it("does not pull upstream before downstream reads, or read ahead of a slow consumer", async () => {
    let pulls = 0;
    const chunks = [sse(start({ input_tokens: 7 })), sse(delta({ output_tokens: 2 })), sse(stop)];
    const upstream = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; if (chunks.length) controller.enqueue(encoder.encode(chunks.shift()!)); else controller.close(); } }, { highWaterMark: 0 });
    const complete = vi.fn();
    const observed = observeProviderResponse(streamingResponse(upstream), { onComplete: complete });
    await Promise.resolve();
    expect(pulls).toBe(0);
    const reader = observed.body!.getReader();
    await reader.read(); await Promise.resolve();
    expect(pulls).toBe(1); expect(complete).not.toHaveBeenCalled();
    await reader.read(); await reader.read();
    expect(complete).not.toHaveBeenCalled();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ inputTokens: 7, outputTokens: 2, usageReported: true }));
  });

  it.each([
    ["empty body", ""],
    ["ping only", sse({ type: "ping" })],
    ["truncated message", sse(start({ input_tokens: 3 }))],
    ["stop without a message", sse(stop)],
    ["malformed data", "data: broken\n\n"],
    ["duplicate messages", sse(start()) + sse(stop) + sse(start()) + sse(stop)],
  ])("does not count %s as successful SSE", async (_label, body) => {
    const complete = vi.fn();
    expect(await observeProviderResponse(streamingResponse(body), { onComplete: complete }).text()).toBe(body);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].outcome).toBe("failure");
  });

  it("retains usage reported before a terminal SSE error", async () => {
    const raw = sse(start({ input_tokens: 9 })) + sse(delta({ output_tokens: 3 })) + sse({ type: "error", error: { type: "api_error", message: "failed" } });
    const complete = vi.fn();
    await observeProviderResponse(streamingResponse(raw), { onComplete: complete }).text();
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ outcome: "failure", inputTokens: 9, outputTokens: 3, usageReported: true }));
  });

  it("retains reported usage when the underlying reader fails, without hiding the failure", async () => {
    const failure = new Error("connection reset"); let reads = 0;
    const upstream = new ReadableStream<Uint8Array>({ pull(controller) { if (++reads === 1) controller.enqueue(encoder.encode(sse(start({ input_tokens: 9 })))); else controller.error(failure); } }, { highWaterMark: 0 });
    const complete = vi.fn();
    await expect(observeProviderResponse(streamingResponse(upstream), { onComplete: complete }).text()).rejects.toBe(failure);
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ outcome: "failure", inputTokens: 9, usageReported: true }));
  });

  it("forwards cancellation and keeps partial usage even after message_stop but before EOF", async () => {
    const cancelled = vi.fn(); let reads = 0;
    const upstream = new ReadableStream<Uint8Array>({ pull(controller) { if (++reads === 1) controller.enqueue(encoder.encode(sse(start({ input_tokens: 5 })) + sse(stop))); }, cancel: cancelled }, { highWaterMark: 0 });
    const complete = vi.fn();
    const reader = observeProviderResponse(streamingResponse(upstream), { onComplete: complete }).body!.getReader();
    await reader.read(); await reader.cancel("user stopped");
    expect(cancelled).toHaveBeenCalledExactlyOnceWith("user stopped");
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ outcome: "cancelled", inputTokens: 5, usageReported: true }));
  });

  it("aborts a stalled read and records cancellation exactly once", async () => {
    const cancelled = vi.fn();
    const upstream = new ReadableStream<Uint8Array>({ cancel: cancelled }, { highWaterMark: 0 });
    const controller = new AbortController(); const complete = vi.fn();
    const reader = observeProviderResponse(streamingResponse(upstream), { signal: controller.signal, onComplete: complete }).body!.getReader();
    const pending = reader.read(); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ outcome: "cancelled" }));
    controller.abort();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("handles a signal already aborted before the response is observed", async () => {
    const controller = new AbortController(); controller.abort(); const complete = vi.fn(); const cancelled = vi.fn();
    const response = observeProviderResponse(streamingResponse(new ReadableStream({ cancel: cancelled })), { signal: controller.signal, onComplete: complete });
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ outcome: "cancelled" }));
  });

  it("distinguishes real zero usage from missing and invalid usage fields", async () => {
    for (const [usage, reported] of [[undefined, false], [{}, false], [{ input_tokens: -1, output_tokens: "3", cache_read_input_tokens: 1.5 }, false], [{ input_tokens: 0, output_tokens: 0 }, true]] as const) {
      const complete = vi.fn();
      await observeProviderResponse(streamingResponse(sse(start(usage)) + sse(stop)), { onComplete: complete }).text();
      expect(complete).toHaveBeenCalledExactlyOnceWith(result({ usageReported: reported }));
    }
  });

  it("limits malformed SSE event buffering while leaving the wire bytes intact", async () => {
    const raw = sse(start({ input_tokens: 2 })) + "data: " + "x".repeat(9 * 1024 * 1024);
    const complete = vi.fn();
    expect(await observeProviderResponse(streamingResponse(raw), { onComplete: complete }).text()).toBe(raw);
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ outcome: "failure", inputTokens: 2, usageReported: true }));
  });

  it("observes JSON without changing its body or mistaking text inside content for usage", async () => {
    const value = { ...message({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 1 }), content: [{ type: "text", text: '{"usage":{"input_tokens":999}}' }] };
    const raw = JSON.stringify(value); const complete = vi.fn();
    const response = observeProviderResponse(new Response(raw, { headers: { "content-type": "application/json" } }), { onComplete: complete });
    expect(await response.json()).toEqual(value);
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, cacheCreationTokens: 1, usageReported: true }));
  });

  it("handles large JSON content incrementally with usage after the content", async () => {
    const raw = JSON.stringify({ ...message(), content: [{ type: "text", text: "long response 你好\n\"".repeat(100_000) }], usage: { input_tokens: 4, output_tokens: 3 } });
    const bytes = encoder.encode(raw); let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + 1023)); offset += 1023; } } }, { highWaterMark: 0 });
    const complete = vi.fn();
    expect(await observeProviderResponse(new Response(body, { headers: { "content-type": "application/json" } }), { onComplete: complete }).text()).toBe(raw);
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ inputTokens: 4, outputTokens: 3, usageReported: true }));
  });

  it.each(["", "{}", "[]", '{"type":"error","error":{"message":"failed"}}', '{"type":"message","content":[]', JSON.stringify(message()) + " trailing"])("rejects invalid or incomplete JSON message %s", async (raw) => {
    const complete = vi.fn();
    expect(await observeProviderResponse(new Response(raw), { onComplete: complete }).text()).toBe(raw);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].outcome).toBe("failure");
  });

  it.each([
    '{"type":"message","role":"assistant","content":[],"stop_reason":"end_turn",}',
    '{"type":"message","role":"assistant","content":[1,],"stop_reason":"end_turn"}',
    '{"type":"message","role":"assistant","content":[],"stop_reason":"end_turn","content":false}',
    '{"type":"message","role":"assistant","content":[],"stop_reason":"end_turn","type":{}}',
    '{"type":"message","role":"assistant","content":[],"stop_reason":"end_turn","invalid":"\\q"}',
  ])("rejects malformed message structure %s", async (raw) => {
    const complete = vi.fn();
    await observeProviderResponse(new Response(raw), { onComplete: complete }).text();
    expect(complete.mock.calls[0][0].outcome).toBe("failure");
  });

  it("rejects a malformed empty SSE data event", async () => {
    const complete = vi.fn();
    await observeProviderResponse(streamingResponse(sse(start()) + "data:\n\n" + sse(stop)), { onComplete: complete }).text();
    expect(complete.mock.calls[0][0].outcome).toBe("failure");
  });

  it("retains JSON usage that arrived before a broken body", async () => {
    const complete = vi.fn();
    await observeProviderResponse(new Response('{"usage":{"input_tokens":4},"content":['), { onComplete: complete }).text();
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ outcome: "failure", inputTokens: 4, usageReported: true }));
  });

  it("records HTTP errors without requiring their bodies to be consumed", async () => {
    const complete = vi.fn(); const raw = JSON.stringify({ type: "error", error: { message: "quota" } });
    const response = observeProviderResponse(new Response(raw, { status: 429, statusText: "Too Many Requests" }), { onComplete: complete });
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ outcome: "failure" }));
    expect(response.status).toBe(429); expect(response.statusText).toBe("Too Many Requests");
    expect(await response.text()).toBe(raw); expect(complete).toHaveBeenCalledTimes(1);
  });

  it("reports a null successful response body as failure", () => {
    const complete = vi.fn();
    const response = observeProviderResponse(new Response(null, { status: 204 }), { onComplete: complete });
    expect(response.status).toBe(204);
    expect(complete).toHaveBeenCalledExactlyOnceWith(result({ outcome: "failure" }));
  });

  it("keeps a statistics callback exception from breaking the response", async () => {
    const raw = sse(start()) + sse(stop);
    const complete = vi.fn(() => { throw new Error("statistics store unavailable"); });
    expect(await observeProviderResponse(streamingResponse(raw), { onComplete: complete }).text()).toBe(raw);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
