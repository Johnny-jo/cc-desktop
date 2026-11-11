import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@claude-desktop/shared";
import { forwardProviderMessage } from "./provider-protocol";

const signal = new AbortController().signal;
const config = (type: ProviderConfig["type"], oauth = false): ProviderConfig => ({
  id: "test", name: "test", type, enabled: true,
  auth: { type, authMethod: oauth ? "oauth2" : "api-key", ...(type === "openai-compatible" ? { baseUrl: "https://example.test/v1" } : {}) } as ProviderConfig["auth"],
});
const request = { model: "test-model", max_tokens: 100, messages: [{ role: "user", content: "hello" }] };
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const chatResult = { id: "chat1", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } };
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function eventData(text: string): any[] { return text.split(/\r?\n\r?\n/).filter(Boolean).map((event) => JSON.parse(event.split(/\r?\n/).find((line) => line.startsWith("data: "))!.slice(6))); }
function sdkReplayContent(events: any[]): any[] {
  const content: any[] = [];
  for (const event of events) {
    if (event.type === "content_block_start") {
      const block = event.content_block;
      // The Agent SDK initializes thinking/signature from deltas, ignoring the start payload.
      content[event.index] = block.type === "thinking" ? { ...block, thinking: "", signature: "" } : { ...block };
    }
    const block = content[event.index]; const delta = event.delta;
    if (delta?.type === "text_delta") block.text += delta.text;
    if (delta?.type === "thinking_delta") block.thinking += delta.thinking;
    if (delta?.type === "signature_delta") block.signature += delta.signature;
    if (delta?.type === "input_json_delta") block._json = (block._json ?? "") + delta.partial_json;
    if (event.type === "content_block_stop" && block._json !== undefined) {
      block.input = JSON.parse(block._json); delete block._json;
    }
  }
  return content;
}

afterEach(() => vi.unstubAllGlobals());

describe("native provider protocols", () => {
  it("accounts for disjoint Responses cache reads and writes", async () => {
    const reply = { type: "response.completed", response: { usage: { input_tokens: 12000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000 } } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse(reply), { headers: { "content-type": "text/event-stream" } })));
    const response = await forwardProviderMessage(config("openai"), "key", { ...request, model: "gpt-6.1-sol" }, { signal });
    expect((await response.json()).usage).toEqual({ input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 7000 });
  });

  it("does not copy SDK device/account metadata into Chat user", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(chatResult));
    vi.stubGlobal("fetch", fetcher);
    await forwardProviderMessage(config("openai-compatible"), "key", { ...request, metadata: { user_id: '{"device_id":"private-device","session_id":"private-session"}' } }, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty("user");
  });

  it("sets the host cache key only on official public Responses", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(sse({ type: "response.completed", response: {} }), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetcher);
    const custom = config("openai"); (custom.auth as any).baseUrl = "https://example.test/v1";
    for (const provider of [config("openai"), custom, config("openai", true)]) {
      await forwardProviderMessage(provider, "key", { ...request, model: "gpt-6.1-sol" }, { signal, promptCacheKey: "host-derived-key" });
    }
    expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body).prompt_cache_key)).toEqual(["host-derived-key", undefined, undefined]);
  });
  it.each([
    ["claude", "test-model", "messages"], ["openai", "gpt-6.1-sol", "responses"],
    ["openai", "gpt-4.1", "chat/completions"], ["deepseek", "test-model", "chat/completions"],
    ["kimi", "test-model", "chat/completions"], ["xai", "test-model", "chat/completions"],
    ["gemini", "test-model", "models/test-model:generateContent"], ["openai-compatible", "test-model", "chat/completions"],
  ] as const)("sends %s/%s API-key generation to its configured Base URL", async (type, model, resource) => {
    const fetcher = vi.fn().mockImplementation(async () => resource === "responses"
      ? new Response(sse({ type: "response.completed", response: {} }), { headers: { "content-type": "text/event-stream" } })
      : jsonResponse(type === "gemini" ? { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } : chatResult));
    vi.stubGlobal("fetch", fetcher);
    const provider = config(type); (provider.auth as any).baseUrl = "https://gateway.example/custom/api/";
    await forwardProviderMessage(provider, "key", { ...request, model }, { signal });
    expect(fetcher.mock.calls[0][0]).toBe(`https://gateway.example/custom/api/${resource}`);
  });

  it.each(["claude", "openai", "deepseek", "kimi", "xai", "gemini"] as const)("rejects invalid %s API overrides before sending a credential", async type => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const provider = config(type); (provider.auth as any).baseUrl = "https://user:secret@gateway.example/api";
    await expect(forwardProviderMessage(provider, "key", request, { signal })).rejects.toThrow(/Base URL/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps cached Chat tokens separate and counts reasoning within completion_tokens once", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...chatResult, usage: { prompt_tokens: 12, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 9 }, completion_tokens_details: { reasoning_tokens: 5 } } })));
    const response = await forwardProviderMessage(config("openai-compatible"), "key", request, { signal });
    expect((await response.json()).usage).toEqual({ input_tokens: 3, output_tokens: 8, cache_read_input_tokens: 9 });
  });

  it("preserves zero cached usage and leaves missing upstream usage unreported", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ ...chatResult, usage: undefined })).mockResolvedValueOnce(jsonResponse({ ...chatResult, usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } }));
    vi.stubGlobal("fetch", fetcher);
    expect((await (await forwardProviderMessage(config("openai-compatible"), "key", request, { signal })).json()).usage).toEqual({});
    expect((await (await forwardProviderMessage(config("openai-compatible"), "key", request, { signal })).json()).usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
  });

  it("merges partial streamed usage instead of resetting prior cumulative token counts", async () => {
    const events = [
      { choices: [{ delta: { content: "hi" } }], usage: { prompt_tokens: 12, prompt_tokens_details: { cached_tokens: 7 } } },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 4 } },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(events.map(sse).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })));
    const response = await forwardProviderMessage(config("openai-compatible"), "key", { ...request, stream: true }, { signal });
    expect(eventData(await response.text()).find((event) => event.type === "message_delta").usage).toEqual({ input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 7 });
  });

  it("normalizes Responses cached input without adding its reasoning detail to output", async () => {
    const events = [{ type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 11, input_tokens_details: { cached_tokens: 15 }, output_tokens_details: { reasoning_tokens: 6 } } } }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(events.map(sse).join(""), { headers: { "content-type": "text/event-stream" } })));
    const response = await forwardProviderMessage(config("openai", true), "oauth", request, { signal });
    expect((await response.json()).usage).toEqual({ input_tokens: 5, output_tokens: 11, cache_read_input_tokens: 15 });
  });

  it("counts Gemini cached input separately and includes thought tokens in output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 18, cachedContentTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 9 } })));
    const response = await forwardProviderMessage(config("gemini"), "key", request, { signal });
    expect((await response.json()).usage).toEqual({ input_tokens: 6, output_tokens: 13, cache_read_input_tokens: 12 });
  });

  it("does not synthesize usage from invalid provider counts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...chatResult, usage: { prompt_tokens: -5, completion_tokens: 1.5, prompt_tokens_details: { cached_tokens: "8" } } })));
    const response = await forwardProviderMessage(config("openai-compatible"), "key", request, { signal });
    expect((await response.json()).usage).toEqual({});
  });

  it("preserves native Claude cache usage unchanged", async () => {
    const original = { type: "message", usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 9, cache_creation_input_tokens: 3 } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(original)));
    expect(await (await forwardProviderMessage(config("claude"), "key", request, { signal })).json()).toEqual(original);
  });

  it.each(["gpt-6.1-sol", "gpt-6-astra"])("preserves public Responses xhigh and max effort for %s", async (model) => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(sse({ type: "response.completed", response: {} }), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetcher);
    for (const effort of ["xhigh", "max"]) {
      await forwardProviderMessage(config("openai"), "key", { ...request, model, thinking: { type: "adaptive" }, output_config: { effort } }, { signal });
      expect(fetcher.mock.calls.at(-1)![0]).toBe("https://api.openai.com/v1/responses");
      expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).reasoning.effort).toBe(effort);
    }
  });

  it("recomputes uncached input when a later usage event reports cached input", async () => {
    const events = [
      { choices: [{ delta: { content: "hi" } }], usage: { prompt_tokens: 12 } },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens_details: { cached_tokens: 7 }, completion_tokens: 4 } },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(events.map(sse).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })));
    const response = await forwardProviderMessage(config("openai-compatible"), "key", { ...request, stream: true }, { signal });
    expect(eventData(await response.text()).filter((event) => event.type === "message_delta").at(-1).usage).toEqual({ input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 7 });
  });

  it("keeps reported upstream usage visible before an error terminates translated SSE", async () => {
    const events = [{ choices: [{ delta: { content: "hi" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }, { error: { message: "upstream failed" } }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(events.map(sse).join(""), { headers: { "content-type": "text/event-stream" } })));
    const response = await forwardProviderMessage(config("openai-compatible"), "key", { ...request, stream: true }, { signal });
    const output = eventData(await response.text());
    const usageEvents = output.flatMap((event) => event.type === "message_start" ? [event.message.usage] : event.type === "message_delta" ? [event.usage] : []);
    expect(usageEvents).toContainEqual({ input_tokens: 12, output_tokens: 3 });
    expect(output.at(-1).type).toBe("error");
  });

  it("forwards Claude API keys and OAuth with the original Messages body and abort signal", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ type: "message" })); vi.stubGlobal("fetch", fetcher);
    await forwardProviderMessage(config("claude"), "key", request, { signal });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("key"); expect(init.signal).toBe(signal);
    expect(JSON.parse(init.body)).toEqual(request);
    await forwardProviderMessage(config("claude", true), "oauth", request, { signal });
    expect(fetcher.mock.calls[1][1].headers.authorization).toBe("Bearer oauth");
    expect(fetcher.mock.calls[1][1].headers["x-api-key"]).toBeUndefined();
  });

  it("preserves caller beta flags for ordinary Bearer gateways without adding OAuth flags", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ type: "message" })); vi.stubGlobal("fetch", fetcher);
    const provider = config("claude"); provider.auth.baseUrl = "https://gateway.example/v1";
    await forwardProviderMessage(provider, "key", request, { signal, anthropicBeta: "context-management-2025-06-27,context-management-2025-06-27", userAgent: "claude-code-test" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://gateway.example/v1/messages");
    expect(init.headers.authorization).toBe("Bearer key");
    expect(init.headers["x-api-key"]).toBeUndefined();
    const betas = init.headers["anthropic-beta"].split(",");
    expect(betas).toEqual(["context-management-2025-06-27"]);
    expect(betas.length).toBe(new Set(betas).size);
    expect(init.headers["user-agent"]).toBe("claude-code-test");
    expect(JSON.parse(init.body)).toEqual(request);
  });

  it("maps ordered tool results, images, tools and usage to Chat Completions", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    const result = await forwardProviderMessage(config("openai-compatible"), "key", {
      ...request, system: [{ type: "text", text: "system" }], tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { file: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }, { type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } }] }],
    }, { signal });
    const [url, init] = fetcher.mock.calls[0]; const body = JSON.parse(init.body);
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(body.messages).toEqual([{ role: "system", content: "system" }, { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: '{"file":"a"}' } }] }, { role: "tool", tool_call_id: "t1", content: "result" }, { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AQ==" } }] }]);
    expect(body.tools[0].function.parameters).toEqual({ type: "object" });
    expect(await result.json()).toMatchObject({ type: "message", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 4, output_tokens: 2 } });
  });

  it("incrementally parses fragmented SSE and parallel tools without buffering the response", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) { upstream = controller; } }), { headers: { "content-type": "text/event-stream" } })));
    const response = await forwardProviderMessage(config("deepseek"), "key", { ...request, stream: true }, { signal });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let output = "";
    const first = reader.read();
    const data = sse({ id: "s1", choices: [{ delta: { content: "你" }, finish_reason: null }] });
    const bytes = encoder.encode(data); upstream.enqueue(bytes.slice(0, bytes.length - 3)); upstream.enqueue(bytes.slice(bytes.length - 3));
    output += decoder.decode((await first).value);
    while (!output.includes('"text":"你"')) output += decoder.decode((await reader.read()).value);
    // The upstream has not closed, so receiving the text here proves real streaming.
    upstream.enqueue(encoder.encode(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "one", arguments: '{"a":' } }, { index: 1, id: "b", function: { name: "two", arguments: "{}" } }] } }] })));
    upstream.enqueue(encoder.encode(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, completion_tokens: 3 } }) + "data: [DONE]\r\n\r\n")); upstream.close();
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; output += decoder.decode(chunk.value); }
    const events = eventData(output);
    expect(events.filter((event) => event.content_block?.type === "tool_use").map((event) => event.content_block.name)).toEqual(["one", "two"]);
    expect(events.filter((event) => event.delta?.type === "input_json_delta").map((event) => event.delta.partial_json)).toEqual(['{"a":', "1}", "{}"]);
    let open: number | undefined;
    for (const event of events) {
      if (event.type === "content_block_start") { expect(open).toBeUndefined(); open = event.index; }
      if (event.type === "content_block_delta") expect(event.index).toBe(open);
      if (event.type === "content_block_stop") { expect(event.index).toBe(open); open = undefined; }
    }
    expect(events.find((event) => event.type === "message_delta")).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 8, output_tokens: 3 } });
    expect(events.at(-1).type).toBe("message_stop");
  });

  it("routes OpenAI OAuth only to Codex Responses and translates function call events", async () => {
    const events = [
      { type: "response.created", response: { id: "r1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item1", call_id: "call1", name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "item1", delta: '{"a":1}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "item1", call_id: "call1", name: "read", arguments: '{"a":1}' } },
      { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 2 }, output: [{ type: "function_call" }] } },
    ];
    const fetcher = vi.fn().mockResolvedValue(new Response(events.map(sse).join(""), { headers: { "content-type": "text/event-stream" } })); vi.stubGlobal("fetch", fetcher);
    const result = await forwardProviderMessage(config("openai", true), "oauth", { ...request, tools: [{ name: "read", input_schema: { type: "object" } }] }, { signal, oauthToken: { account_id: "acct" } });
    expect(fetcher.mock.calls[0][0]).toBe("https://chatgpt.com/backend-api/codex/responses");
    const init = fetcher.mock.calls[0][1]; expect(init.headers["ChatGPT-Account-Id"]).toBe("acct");
    expect(JSON.parse(init.body)).toMatchObject({ store: false, stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] });
    expect(await result.json()).toMatchObject({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "call1", name: "read", input: { a: 1 } }] });
  });

  it("maps Gemini functions, OAuth and opaque thought signatures through the next request", async () => {
    const upstream = { candidates: [{ content: { parts: [{ functionCall: { id: "g1", name: "read", args: { a: 1 } }, thoughtSignature: "opaque+signature=" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(upstream)); vi.stubGlobal("fetch", fetcher);
    const response = await forwardProviderMessage(config("gemini", true), "oauth", request, { signal });
    const message = await response.json();
    expect(message).toMatchObject({ stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 2 } });
    expect(fetcher.mock.calls[0][0]).toContain("/v1beta/models/test-model:generateContent");
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe("Bearer oauth");
    await forwardProviderMessage(config("gemini"), "key", { ...request, messages: [{ role: "assistant", content: message.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: message.content[0].id, content: "ok" }] }] }, { signal });
    const replay = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(replay.contents[0].parts[0]).toEqual(upstream.candidates[0].content.parts[0]);
    expect(replay.contents[1].parts[0].functionResponse).toEqual({ id: "g1", name: "read", response: { result: "ok" } });
  });

  it("rejects unsupported content before network and propagates upstream HTTP errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "quota exceeded" } }, 429)); vi.stubGlobal("fetch", fetcher);
    await expect(forwardProviderMessage(config("openai"), "key", { ...request, messages: [{ role: "user", content: [{ type: "document", source: {} }] }] }, { signal })).rejects.toThrow(/document/);
    expect(fetcher).not.toHaveBeenCalled();
    const result = await forwardProviderMessage(config("openai"), "key", request, { signal });
    expect(result.status).toBe(429); expect(await result.json()).toMatchObject({ type: "error", error: { message: "quota exceeded" } });
  });

  it("cancels an open upstream stream when the client cancels", async () => {
    let canceled = false;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } })));
    const result = await forwardProviderMessage(config("xai"), "key", { ...request, stream: true }, { signal });
    await result.body!.cancel(); expect(canceled).toBe(true);
  });

  it("does not claim successful completion when upstream SSE is truncated", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sse({ choices: [{ delta: { content: "partial" } }] }), { headers: { "content-type": "text/event-stream" } })));
    const result = await forwardProviderMessage(config("openai"), "key", { ...request, stream: true }, { signal });
    const events = eventData(await result.text());
    expect(events.at(-1)).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(events.some((event) => event.type === "message_stop")).toBe(false);
  });

  it.each([false, true])("replays Codex encrypted reasoning items between tool turns (stream=%s)", async (stream) => {
    const reasoning = { id: "reason1", type: "reasoning", summary: [{ type: "summary_text", text: "checking" }], encrypted_content: "opaque-encrypted-reasoning" };
    const upstream = [
      { type: "response.created", response: { id: "r2" } },
      { type: "response.output_item.added", output_index: 0, item: { id: "reason1", type: "reasoning" } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "checking" },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 3 } } },
    ];
    const fetcher = vi.fn().mockImplementation(async () => new Response(upstream.map(sse).join(""), { headers: { "content-type": "text/event-stream" } })); vi.stubGlobal("fetch", fetcher);
    const first = await forwardProviderMessage(config("openai", true), "oauth", { ...request, stream }, { signal });
    const content = stream ? sdkReplayContent(eventData(await first.text())) : (await first.json()).content;
    expect(content[0]).toMatchObject({ type: "thinking", thinking: "checking" });
    await forwardProviderMessage(config("openai", true), "oauth", { ...request, messages: [{ role: "assistant", content }, { role: "user", content: "continue" }] }, { signal });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).input[0]).toEqual(reasoning);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).include).toContain("reasoning.encrypted_content");
  });

  it("preserves Gemini signatures attached to ordinary text in streaming and replay", async () => {
    const upstream = [
      { candidates: [{ content: { parts: [{ text: "answer" }] } }] },
      { candidates: [{ content: { parts: [{ text: "", thoughtSignature: "text-signature" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } },
    ];
    const fetcher = vi.fn().mockImplementation(async () => new Response(upstream.map(sse).join(""), { headers: { "content-type": "text/event-stream" } })); vi.stubGlobal("fetch", fetcher);
    const first = await forwardProviderMessage(config("gemini"), "key", { ...request, stream: true }, { signal });
    const events = eventData(await first.text());
    expect(events.some((event) => event.type === "error")).toBe(false);
    const replay = sdkReplayContent(events);
    fetcher.mockImplementation(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }));
    await forwardProviderMessage(config("gemini"), "key", { ...request, messages: [{ role: "assistant", content: replay }, { role: "user", content: "next" }] }, { signal });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).contents[0].parts).toEqual([{ text: "answer", thoughtSignature: "text-signature" }]);
  });

  it("replays DeepSeek reasoning content for tool continuations", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({ ...chatResult, choices: [{ message: { content: null, reasoning_content: "check first", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })); vi.stubGlobal("fetch", fetcher);
    const first = await forwardProviderMessage(config("deepseek"), "key", request, { signal });
    const result = await first.json();
    await forwardProviderMessage(config("deepseek"), "key", { ...request, messages: [{ role: "assistant", content: result.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] }] }, { signal });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).messages[0].reasoning_content).toBe("check first");
  });

  it.each(["openai-compatible", "deepseek", "kimi"] as const)("replays streamed %s thinking after the SDK executes a tool", async (type) => {
    for (const text of ["", "I will check."]) {
      const upstream = [
        { choices: [{ delta: { reasoning_content: "check " } }] },
        { choices: [{ delta: { reasoning_content: "first" } }] },
        ...(text ? [{ choices: [{ delta: { content: text } }] }] : []),
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read", arguments: '{"file":"test.txt"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
      const fetcher = vi.fn().mockResolvedValueOnce(new Response(upstream.map(sse).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })).mockResolvedValueOnce(jsonResponse(chatResult));
      vi.stubGlobal("fetch", fetcher);
      const first = await forwardProviderMessage(config(type), "key", { ...request, stream: true }, { signal });
      const events = eventData(await first.text());
      expect(events.some((event) => event.type === "error")).toBe(false);
      const content = sdkReplayContent(events);
      expect(content[0]).toEqual({ type: "thinking", thinking: "check first", signature: "chat-reasoning" });
      const signatureIndex = events.findIndex((event) => event.delta?.type === "signature_delta");
      expect(signatureIndex).toBeGreaterThan(events.map((event) => event.delta?.type).lastIndexOf("thinking_delta"));
      expect(signatureIndex).toBeLessThan(events.findIndex((event) => event.type === "content_block_stop" && event.index === 0));
      await forwardProviderMessage(config(type), "key", { ...request, messages: [{ role: "assistant", content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "read1", content: "ok" }] }] }, { signal });
      expect(JSON.parse(fetcher.mock.calls[1][1].body).messages).toEqual([
        { role: "assistant", content: text || null, reasoning_content: "check first", tool_calls: [{ id: "read1", type: "function", function: { name: "read", arguments: '{"file":"test.txt"}' } }] },
        { role: "tool", tool_call_id: "read1", content: "ok" },
      ]);
    }
  });

  it("retries Chat tool continuations saved before streamed signatures were fixed", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    await forwardProviderMessage(config("openai-compatible"), "key", { ...request, messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "check first", signature: "" }, { type: "tool_use", id: "a", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
    ] }, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).messages[0].reasoning_content).toBe("check first");
  });

  it.each(["openai:opaque", "gemini:opaque", "anthropic-opaque-signature"])("keeps rejecting foreign signed reasoning in Chat: %s", async (signature) => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(forwardProviderMessage(config("openai-compatible"), "key", { ...request, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "check first", signature }] }] }, { signal })).rejects.toThrow("Only Chat Completions reasoning");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates abort while waiting for upstream SSE and avoids network for pre-aborted requests", async () => {
    const controller = new AbortController(); let canceled = false;
    const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } })); vi.stubGlobal("fetch", fetcher);
    const result = await forwardProviderMessage(config("openai"), "key", { ...request, stream: true }, { signal: controller.signal });
    const read = result.body!.getReader().read(); controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" }); expect(canceled).toBe(true);
    await expect(forwardProviderMessage(config("claude"), "key", request, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps Agent SDK adaptive thinking and effort to each provider protocol", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    const body = { ...request, thinking: { type: "adaptive" }, output_config: { effort: "high" } };
    await forwardProviderMessage(config("openai"), "key", { ...body, model: "o3" }, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).reasoning_effort).toBe("high");
    await forwardProviderMessage(config("deepseek"), "key", body, { signal });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    await forwardProviderMessage(config("kimi"), "key", { ...body, model: "kimi-k2.5" }, { signal });
    expect(JSON.parse(fetcher.mock.calls[2][1].body).thinking).toEqual({ type: "enabled" });
    fetcher.mockImplementation(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }));
    await forwardProviderMessage(config("gemini"), "key", { ...body, model: "gemini-3.1-pro-preview" }, { signal });
    expect(JSON.parse(fetcher.mock.calls[3][1].body).generationConfig.thinkingConfig).toMatchObject({ thinkingLevel: "HIGH", includeThoughts: true });
    fetcher.mockImplementation(async () => new Response(sse({ type: "response.completed", response: {} }), { headers: { "content-type": "text/event-stream" } }));
    await forwardProviderMessage(config("openai", true), "oauth", body, { signal });
    expect(JSON.parse(fetcher.mock.calls[4][1].body).reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("preserves custom compatible API prefixes and validates URL credentials", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    for (const [baseUrl, expected] of [["https://example.test", "https://example.test/v1/chat/completions"], ["https://example.test/custom/api/", "https://example.test/custom/api/chat/completions"], ["https://example.test/chat/completions", "https://example.test/chat/completions"]]) {
      const provider = config("openai-compatible"); (provider.auth as any).baseUrl = baseUrl;
      await forwardProviderMessage(provider, "key", request, { signal });
      expect(fetcher.mock.calls.at(-1)![0]).toBe(expected);
    }
    const provider = config("openai-compatible"); (provider.auth as any).baseUrl = "https://user:password@example.test";
    await expect(forwardProviderMessage(provider, "key", request, { signal })).rejects.toThrow(/credentials/);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("sends a configured quota project on Gemini OAuth generation only", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })); vi.stubGlobal("fetch", fetcher);
    const provider = { ...config("gemini", true), oauthProjectId: "my-project" };
    await forwardProviderMessage(provider, "oauth", request, { signal });
    expect(fetcher.mock.calls[0][1].headers["x-goog-user-project"]).toBe("my-project");
    await forwardProviderMessage({ ...config("gemini"), oauthProjectId: "my-project" }, "api-key", request, { signal });
    expect(fetcher.mock.calls[1][1].headers["x-goog-user-project"]).toBeUndefined();
  });

  it("uses OpenAI reasoning-compatible token limits and Kimi documented thinking controls", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    await forwardProviderMessage(config("openai"), "key", request, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ max_completion_tokens: 100 });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).max_tokens).toBeUndefined();
    await forwardProviderMessage(config("kimi"), "key", { ...request, model: "kimi-k3.1-pro", thinking: { type: "adaptive" }, output_config: { effort: "high" } }, { signal });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).thinking).toBeUndefined();
    expect(JSON.parse(fetcher.mock.calls[1][1].body).reasoning_effort).toBe("high");
    const response = await forwardProviderMessage(config("kimi"), "key", { ...request, model: "kimi-k2.6", thinking: { type: "adaptive" }, output_config: { effort: "high" } }, { signal });
    expect(JSON.parse(fetcher.mock.calls[2][1].body).thinking).toEqual({ type: "enabled", keep: "all" });
    expect(JSON.parse(fetcher.mock.calls[2][1].body).reasoning_effort).toBeUndefined();
    expect(response.headers.get("x-provider-limitations")).toMatch(/effort/);
  });

  it("sends Codex API-key models to public Responses with an output cap", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(sse({ type: "response.output_text.delta", output_index: 0, delta: "ok" }) + sse({ type: "response.completed", response: {} }), { headers: { "content-type": "text/event-stream" } })); vi.stubGlobal("fetch", fetcher);
    const result = await forwardProviderMessage(config("openai"), "api-key", { ...request, model: "gpt-5.3-codex" }, { signal });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(fetcher.mock.calls[0][1].headers.authorization).toBe("Bearer api-key");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ max_output_tokens: 100 });
    expect(await result.json()).toMatchObject({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    expect(result.headers.get("x-provider-limitations")).toBeNull();
  });

  it("redacts credentials echoed in native Claude, converted HTTP and streaming errors", async () => {
    const secret = "sk-secret-echo-check";
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({ error: { message: `Invalid credential: ${secret}` } }, 401)); vi.stubGlobal("fetch", fetcher);
    for (const provider of [config("claude"), config("openai")]) {
      const response = await forwardProviderMessage(provider, secret, request, { signal });
      expect(response.status).toBe(401); const body = await response.text();
      expect(body).not.toContain(secret); expect(body).toContain("[redacted]");
    }
    fetcher.mockImplementation(async () => new Response(sse({ error: { message: `Rejected ${secret}` } }), { headers: { "content-type": "text/event-stream" } }));
    const stream = await forwardProviderMessage(config("openai"), secret, { ...request, stream: true }, { signal });
    const body = await stream.text(); expect(body).not.toContain(secret); expect(body).toContain("[redacted]");
  });

  it("keeps screenshot tool images after every parallel Chat tool result, including split user messages", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } };
    const response = await forwardProviderMessage(config("openai-compatible"), "key", {
      ...request,
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "screen", name: "screenshot", input: {} }, { type: "tool_use", id: "state", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "screen", content: [{ type: "text", text: "captured screen" }, image] }] },
        { role: "user", content: [{ type: "text", text: "Inspect the screen" }, { type: "tool_result", tool_use_id: "state", content: "ready" }] }],
    }, { signal });
    const messages = JSON.parse(fetcher.mock.calls[0][1].body).messages;
    expect(messages.map((message: any) => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(messages[1]).toMatchObject({ tool_call_id: "screen", content: expect.stringContaining("captured screen") });
    expect(messages[2]).toMatchObject({ tool_call_id: "state", content: "ready" });
    expect(messages[3].content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AQ==" } });
    expect(messages[3].content).toContainEqual({ type: "text", text: "Inspect the screen" });
    expect(messages[3].content.some((part: any) => part.text?.includes("screen"))).toBe(true);
    expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "hi" }] });
  });

  it("returns screenshot text and images together in Responses function_call_output", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(sse({ type: "response.output_text.delta", output_index: 0, delta: "screen read" }) + sse({ type: "response.completed", response: {} }), { headers: { "content-type": "text/event-stream" } })); vi.stubGlobal("fetch", fetcher);
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } };
    const response = await forwardProviderMessage(config("openai", true), "oauth", {
      ...request, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "screen", name: "screenshot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "screen", content: [{ type: "text", text: "captured screen" }, image] }] }],
    }, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).input[1]).toEqual({ type: "function_call_output", call_id: "screen", output: [{ type: "input_text", text: "captured screen" }, { type: "input_image", image_url: "data:image/png;base64,AQ==", detail: "original" }] });
    expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "screen read" }] });
  });

  it("embeds screenshot images in Gemini 3 functionResponse parts and preserves errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: "screen read" }] }, finishReason: "STOP" }] })); vi.stubGlobal("fetch", fetcher);
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } };
    const response = await forwardProviderMessage(config("gemini"), "key", {
      ...request, model: "gemini-3.1-pro-preview", messages: [{ role: "assistant", content: [{ type: "tool_use", id: "screen", name: "screenshot", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "screen", is_error: true, content: [{ type: "text", text: "failed to locate element; current screen" }, image] }] }],
    }, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).contents[1].parts).toEqual([{ functionResponse: { name: "screenshot", response: { error: "failed to locate element; current screen" }, parts: [{ inlineData: { mimeType: "image/png", data: "AQ==" } }] } }]);
    expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "screen read" }] });
  });

  it("keeps older Gemini screenshots after all parallel function responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })); vi.stubGlobal("fetch", fetcher);
    await forwardProviderMessage(config("gemini"), "key", {
      ...request, model: "gemini-2.5-flash", messages: [{ role: "assistant", content: [{ type: "tool_use", id: "screen", name: "screenshot", input: {} }, { type: "tool_use", id: "state", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "screen", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQ==" } }] }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "state", content: "ready" }] }],
    }, { signal });
    const parts = JSON.parse(fetcher.mock.calls[0][1].body).contents[1].parts;
    expect(parts[0].functionResponse.name).toBe("screenshot"); expect(parts[1].functionResponse.name).toBe("read");
    expect(parts.at(-1)).toEqual({ inlineData: { mimeType: "image/png", data: "AQ==" } });
    expect(parts[2].text).toContain("screen");
  });

  it("still rejects unsupported document blocks inside tool results before the network", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const type of ["openai-compatible", "openai", "gemini"] as const) {
      await expect(forwardProviderMessage(config(type, type === "openai"), "key", { ...request, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "screen", name: "screenshot", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "screen", content: [{ type: "document", source: {} }] }] }] }, { signal })).rejects.toThrow(/document/);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts the captured SDK default system-message and keep-all context shape across protocols", async () => {
    // Sanitized shape captured from SDK 0.3.318 / bundled Claude Code, including
    // the trailing system message that its default request adds after the user.
    const actualSdkShape = { ...request, system: [{ type: "text", text: "global instructions" }], tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "Reply OK" }] }, { role: "system", content: [{ type: "text", text: "request instructions" }] }],
      thinking: { type: "adaptive", display: "updates" }, context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }, output_config: { effort: "high" },
    };
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    const chat = await forwardProviderMessage(config("openai-compatible"), "key", actualSdkShape, { signal });
    expect(await chat.json()).toMatchObject({ content: [{ type: "text", text: "hi" }] });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).messages).toEqual([{ role: "system", content: "global instructions" }, { role: "user", content: "Reply OK" }, { role: "system", content: "request instructions" }]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body).context_management).toBeUndefined();
    fetcher.mockImplementation(async () => new Response(sse({ type: "response.completed", response: {} }), { headers: { "content-type": "text/event-stream" } }));
    await forwardProviderMessage(config("openai", true), "oauth", actualSdkShape, { signal });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Reply OK" }] }, { role: "system", content: [{ type: "input_text", text: "request instructions" }] }]);
    fetcher.mockImplementation(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] }));
    await forwardProviderMessage(config("gemini"), "key", actualSdkShape, { signal });
    expect(JSON.parse(fetcher.mock.calls[2][1].body).systemInstruction.parts).toEqual([{ text: "global instructions" }, { text: "request instructions" }]);
    expect(JSON.parse(fetcher.mock.calls[2][1].body).contents).toEqual([{ role: "user", parts: [{ text: "Reply OK" }] }]);
  });

  it("rejects destructive context-management policies rather than stripping conversation", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(forwardProviderMessage(config("openai-compatible"), "key", { ...request, context_management: { edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 1 } }] } }, { signal })).rejects.toThrow(/context_management/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes only allowlisted Anthropic protocol headers and merges OAuth beta flags", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({ type: "message" })); vi.stubGlobal("fetch", fetcher);
    await forwardProviderMessage(config("claude", true), "oauth", request, { signal, anthropicBeta: "context-management-2025-06-27,oauth-2025-04-20,context-management-2025-06-27", anthropicVersion: "2023-06-01", userAgent: "claude-code-test" });
    const headers = fetcher.mock.calls[0][1].headers;
    expect(headers["anthropic-beta"]).toBe("context-management-2025-06-27,oauth-2025-04-20");
    expect(headers["anthropic-version"]).toBe("2023-06-01"); expect(headers["user-agent"]).toBe("claude-code-test");
    expect(headers.authorization).toBe("Bearer oauth"); expect(headers["x-api-key"]).toBeUndefined();
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("forwards custom Chat effort %s exactly as selected", async effort => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    for (const [type, model] of [["openai-compatible", "unknown-model"], ["openai", "gpt-4o"], ["openai", "o3"], ["deepseek", "deepseek-reasoner"], ["kimi", "kimi-k3.1-pro"], ["kimi", "kimi-k2.6"], ["xai", "grok-3-mini"]] as const) {
      const provider = config(type); provider.auth.baseUrl = "https://gateway.example/v1";
      const response = await forwardProviderMessage(provider, "key", { ...request, model, thinking: { type: "adaptive" }, output_config: { effort } }, { signal });
      const sent = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
      expect(sent.reasoning_effort, `${type}/${model}`).toBe(effort);
      expect(response.headers.get("x-provider-limitations")).toBeNull();
      if (type === "deepseek") expect(sent.thinking).toEqual({ type: "enabled" });
    }
  });

  it("does not enable custom reasoning after thinking was disabled", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    await forwardProviderMessage(config("openai-compatible"), "key", { ...request, thinking: { type: "disabled" }, output_config: { effort: "max" } }, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).reasoning_effort).not.toBe("max");
  });

  it("keeps official OpenAI request behavior when its default Base URL is entered explicitly", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    const provider = config("openai");
    const body = { ...request, model: "gpt-4o", thinking: { type: "adaptive" }, output_config: { effort: "medium" } };
    await forwardProviderMessage(provider, "key", body, { signal });
    provider.auth.baseUrl = "https://api.openai.com/v1";
    await forwardProviderMessage(provider, "key", body, { signal });
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual(JSON.parse(fetcher.mock.calls[0][1].body));
    expect(JSON.parse(fetcher.mock.calls[1][1].body).reasoning_effort).toBeUndefined();
  });

  it("keeps default SDK thinking controls from breaking non-reasoning official OpenAI models", async () => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse(chatResult)); vi.stubGlobal("fetch", fetcher);
    const sdkDefaults = { ...request, thinking: { type: "adaptive", display: "updates" }, output_config: { effort: "high" }, context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } };
    for (const [provider, model] of [["openai", "gpt-4o"], ["openai", "gpt-3.5-turbo"]] as const) {
      const response = await forwardProviderMessage(config(provider), "key", { ...sdkDefaults, model }, { signal });
      const sent = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
      expect(sent.reasoning_effort).toBeUndefined(); expect(sent.thinking).toBeUndefined();
      expect(response.headers.get("x-provider-limitations")).toMatch(/reasoning|effort/);
      expect(await response.json()).toMatchObject({ stop_reason: "end_turn" });
    }
  });

  it.each([
    ["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"], ["xhigh", "HIGH"], ["max", "HIGH"],
  ])("maps custom Gemini effort %s to a native %s thinking level", async (effort, nativeLevel) => {
    const fetcher = vi.fn().mockImplementation(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] })); vi.stubGlobal("fetch", fetcher);
    const provider = config("gemini"); provider.auth.baseUrl = "https://gateway.example/v1beta";
    for (const model of ["private-thinking-model", "gemini-3.1-pro-preview"]) {
      const response = await forwardProviderMessage(provider, "key", { ...request, model, thinking: { type: "adaptive" }, output_config: { effort } }, { signal });
      const sent = JSON.parse(fetcher.mock.calls.at(-1)![1].body);
      expect(sent.generationConfig.thinkingConfig, model).toEqual({ thinkingLevel: nativeLevel, includeThoughts: true });
      expect(sent.reasoning_effort).toBeUndefined();
      const limitations = response.headers.get("x-provider-limitations");
      if (effort === "xhigh" || effort === "max") expect(limitations).toMatch(new RegExp(`${effort}.*mapped.*HIGH`));
      else expect(limitations).toBeNull();
      expect(limitations ?? "").not.toMatch(/not advertised|cannot be enforced|default thinking budget/);
    }
  });

  it("does not send an invalid XHIGH thinking level to official Gemini", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] })); vi.stubGlobal("fetch", fetcher);
    const response = await forwardProviderMessage(config("gemini"), "key", { ...request, model: "gemini-3.1-pro-preview", output_config: { effort: "xhigh" } }, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).generationConfig.thinkingConfig).toMatchObject({ thinkingLevel: "HIGH" });
    expect(response.headers.get("x-provider-limitations")).toMatch(/xhigh.*mapped.*HIGH/);
  });

  it("keeps custom Gemini 2.5 models on their native dynamic thinking budget", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] })); vi.stubGlobal("fetch", fetcher);
    const provider = config("gemini"); provider.auth.baseUrl = "https://gateway.example/v1beta";
    const response = await forwardProviderMessage(provider, "key", { ...request, model: "gemini-2.5-pro", thinking: { type: "adaptive" }, output_config: { effort: "max" } }, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).generationConfig.thinkingConfig).toEqual({ thinkingBudget: -1, includeThoughts: true });
    expect(response.headers.get("x-provider-limitations")).toMatch(/default thinking budget/);
  });

  it("does not infer thinking support for an unknown official Gemini model", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] })); vi.stubGlobal("fetch", fetcher);
    await forwardProviderMessage(config("gemini"), "key", { ...request, model: "unknown-model", thinking: { type: "adaptive" }, output_config: { effort: "max" } }, { signal });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).generationConfig.thinkingConfig).toBeUndefined();
  });

  it("uses dynamic budgets rather than thinkingLevel for Gemini 2.5 with SDK default effort", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] })); vi.stubGlobal("fetch", fetcher);
    const response = await forwardProviderMessage(config("gemini"), "key", { ...request, model: "gemini-2.5-pro", thinking: { type: "adaptive", display: "updates" }, output_config: { effort: "high" } }, { signal });
    const thinking = JSON.parse(fetcher.mock.calls[0][1].body).generationConfig.thinkingConfig;
    expect(thinking).toEqual({ thinkingBudget: -1, includeThoughts: true });
    expect(response.headers.get("x-provider-limitations")).toMatch(/effort/);
    expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "OK" }] });
  });

  it("routes GPT-6 API-key tool calls through public Responses", async () => {
    const upstream = [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item", call_id: "call", name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call", name: "read", arguments: "{}" } },
      { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1 } } },
    ];
    const fetcher = vi.fn().mockResolvedValue(new Response(upstream.map(sse).join(""), { headers: { "content-type": "text/event-stream" } })); vi.stubGlobal("fetch", fetcher);
    const response = await forwardProviderMessage(config("openai"), "api-key", { ...request, model: "gpt-6.1-sol", thinking: { type: "adaptive" }, output_config: { effort: "high" }, tools: [{ name: "read", input_schema: { type: "object" } }] }, { signal });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ reasoning: { effort: "high" }, tools: [{ type: "function", name: "read" }] });
    expect(await response.json()).toMatchObject({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "call", name: "read", input: {} }] });
  });
});
