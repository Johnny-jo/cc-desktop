import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "@claude-desktop/shared";
import { claudeApiKeyHeaders, providerApiUrl } from "@claude-desktop/shared";
import { hasCustomProviderApi } from "./provider-model-capabilities";

// Wire formats are validated at the boundary; provider-specific optional fields stay local.
type Wire = Record<string, any>;
type Protocol = "chat" | "responses" | "gemini";
type ForwardOptions = {
  signal: AbortSignal;
  oauthToken?: { account_id?: string; id_token?: string };
  anthropicBeta?: string;
  anthropicVersion?: string;
  userAgent?: string;
};
type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
type Block = { index: number; value: Wire; closed: boolean };
const encoder = new TextEncoder();

export class ProviderProtocolError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = "ProviderProtocolError"; }
}
function unsupported(message: string): never { throw new ProviderProtocolError(message); }
function apiUrl(config: ProviderConfig, resource: string): string {
  try { return providerApiUrl(config, resource); }
  catch (error) { unsupported(error instanceof Error ? error.message : "Invalid Base URL"); }
}
function object(value: unknown, label: string): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value)) unsupported(`${label} must be an object`);
  return value as Wire;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") unsupported(`${label} must be a string`);
  return value;
}
function array(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) unsupported(`${label} must be an array`);
  return value;
}
function blocks(value: unknown): Wire[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return array(value, "message content").map((part) => object(part, "content block"));
}
function text(value: unknown, label: string): string {
  return blocks(value).map((part) => {
    if (part.type !== "text") unsupported(`${label}: unsupported ${part.type} content`);
    if (part.citations?.length) unsupported(`${label}: citations cannot be translated`);
    return string(part.text, `${label}.text`);
  }).join("\n");
}
function imageUrl(part: Wire): string {
  const source = object(part.source, "image source");
  if (source.type === "url") {
    const url = string(source.url, "image URL");
    if (!/^https?:\/\//i.test(url)) unsupported("Image URLs must use HTTP or HTTPS");
    return url;
  }
  if (source.type === "base64") return `data:${string(source.media_type, "image media_type")};base64,${string(source.data, "image data")}`;
  return unsupported(`Unsupported image source: ${source.type}`);
}
function toolResultParts(part: Wire): Wire[] {
  return blocks(part.content ?? "").map((content) => {
    if (content.type === "text") { text([content], "tool_result"); return content; }
    if (content.type === "image") { imageUrl(content); return content; }
    return unsupported(`tool_result: unsupported ${content.type} content`);
  });
}
function geminiImage(part: Wire): Wire {
  const source = object(part.source, "image.source");
  if (source.type !== "base64") unsupported("Gemini images require a base64 source; URL images are not supported");
  return { inlineData: { mimeType: string(source.media_type, "image.media_type"), data: string(source.data, "image.data") } };
}
function toolDefinitions(body: Wire): Wire[] {
  return (body.tools ? array(body.tools, "tools") : []).map((tool) => {
    const value = object(tool, "tool");
    if (value.type && value.type !== "custom") unsupported(`Unsupported native tool type: ${value.type}`);
    if (value.defer_loading) unsupported("Deferred tools are not supported by this provider");
    return { name: string(value.name, "tool.name"), ...(value.description ? { description: string(value.description, "tool.description") } : {}), parameters: object(value.input_schema, "tool.input_schema") };
  });
}
function validateRequest(value: unknown): Wire {
  const body = object(value, "Messages request");
  string(body.model, "model");
  if (!body.model.trim()) unsupported("model cannot be empty");
  for (const message of array(body.messages, "messages")) {
    object(message, "message");
    if (!["user", "assistant", "system"].includes(message.role)) unsupported(`Unsupported message role: ${message.role}`);
    blocks(message.content);
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) unsupported("max_tokens must be a positive integer");
  // Cache hints and metadata are transport/accounting hints, not conversation content.
  // Every semantic extension must be explicitly handled instead of being silently stripped.
  const supported = new Set(["model", "messages", "max_tokens", "system", "tools", "tool_choice", "temperature", "top_p", "top_k", "stop_sequences", "stream", "metadata", "thinking", "output_config", "service_tier", "context_management"]);
  for (const key of Object.keys(body)) if (!supported.has(key)) unsupported(`Unsupported Messages parameter: ${key}`);
  if (body.service_tier && body.service_tier !== "auto") unsupported("service_tier cannot be translated to this provider");
  if (body.output_config) {
    const config = object(body.output_config, "output_config");
    for (const key of Object.keys(config)) if (key !== "effort") unsupported(`Unsupported output_config parameter: ${key}`);
    if (config.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(config.effort)) unsupported(`Unsupported reasoning effort: ${config.effort}`);
  }
  if (body.thinking && !["adaptive", "enabled", "disabled"].includes(body.thinking.type)) unsupported(`Unsupported thinking type: ${body.thinking.type}`);
  if (body.context_management) {
    const context = object(body.context_management, "context_management");
    for (const key of Object.keys(context)) if (key !== "edits") unsupported(`Unsupported context_management field: ${key}`);
    for (const edit of array(context.edits, "context_management.edits")) {
      if (edit?.type !== "clear_thinking_20251015" || edit.keep !== "all" || Object.keys(edit).some((key) => key !== "type" && key !== "keep")) unsupported("Only context_management clear_thinking with keep: all can be translated without deleting conversation");
    }
    // Claude Code sends this by default. Keeping all thinking is a genuine no-op:
    // send every supplied conversation block intact, and do not ask the target
    // provider to clear, summarize or rewrite any history on the server.
  }
  return body;
}
function checkThinking(body: Wire, protocol: Protocol, customApi = false): Wire | undefined {
  const effort = body.output_config?.effort;
  if (!body.thinking && !effort) return undefined;
  if (protocol === "gemini") {
    const model = body.model.replace(/^models\//, "");
    if (/^gemini-2\.5(?:-|$)/.test(model)) {
      if (body.thinking?.type === "disabled") return /-pro(?:-|$)/.test(model) ? { includeThoughts: false } : { thinkingBudget: 0 };
      return { thinkingBudget: body.thinking?.type === "enabled" && Number.isInteger(body.thinking.budget_tokens) ? body.thinking.budget_tokens : -1, includeThoughts: true };
    }
    if (customApi || /^gemini-(?:[3-9]|[1-9]\d)(?:[.-]|$)/.test(model)) {
      if (body.thinking?.type === "disabled") return { includeThoughts: false };
      if (effort) return { thinkingLevel: (effort === "max" || effort === "xhigh" ? "high" : effort).toUpperCase(), includeThoughts: true };
      if (body.thinking?.type === "enabled" && Number.isInteger(body.thinking.budget_tokens)) return { thinkingBudget: body.thinking.budget_tokens, includeThoughts: true };
      return { includeThoughts: true };
    }
    return undefined;
  }
  if (protocol === "responses") return { effort: body.thinking?.type === "disabled" ? "none" : effort ?? "medium", summary: "auto" };
  return { effort: body.thinking?.type === "disabled" ? "none" : effort === "max" ? "xhigh" : effort ?? "medium" };
}

function chatMessages(body: Wire): Wire[] {
  const result: Wire[] = [];
  const awaitingTools = new Set<string>();
  let deferredUserContent: Wire[] = [];
  const flushUser = () => {
    if (awaitingTools.size || !deferredUserContent.length) return;
    result.push({ role: "user", content: deferredUserContent.length === 1 && deferredUserContent[0].type === "text" ? deferredUserContent[0].text : deferredUserContent });
    deferredUserContent = [];
  };
  if (body.system !== undefined) result.push({ role: "system", content: text(body.system, "system") });
  for (const message of body.messages) {
    let content: Wire[] = []; let calls: Wire[] = []; let reasoning = "";
    const flush = () => {
      if (!content.length && !calls.length && !reasoning) return;
      if (message.role === "user") { deferredUserContent.push(...content); content = []; return; }
      const onlyText = content.length === 1 && content[0].type === "text";
      result.push({ role: message.role, content: content.length ? (onlyText ? content[0].text : content) : null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) });
      content = []; calls = []; reasoning = "";
    };
    for (const part of blocks(message.content)) {
      switch (part.type) {
        case "text":
          if (part.citations?.length) unsupported("Text citations cannot be translated");
          content.push({ type: "text", text: string(part.text, "text.text") }); break;
        case "image":
          if (message.role !== "user") unsupported("Assistant images cannot be translated to Chat Completions");
          content.push({ type: "image_url", image_url: { url: imageUrl(part) } }); break;
        case "tool_use":
          if (message.role !== "assistant") unsupported("tool_use requires an assistant message");
          awaitingTools.add(string(part.id, "tool_use.id"));
          calls.push({ id: string(part.id, "tool_use.id"), type: "function", function: { name: string(part.name, "tool_use.name"), arguments: JSON.stringify(object(part.input, "tool_use.input")) } }); break;
        case "tool_result": {
          if (message.role !== "user") unsupported("tool_result requires a user message");
          flush();
          const id = string(part.tool_use_id, "tool_result.tool_use_id");
          let imageIndex = 0;
          const toolContent = toolResultParts(part).map((content) => {
            if (content.type === "text") return content.text;
            const label = `Image ${++imageIndex} from tool result ${id}${part.is_error ? " (tool error)" : ""}`;
            deferredUserContent.push({ type: "text", text: label }, { type: "image_url", image_url: { url: imageUrl(content) } });
            return `[${label}; attached after all parallel tool results.]`;
          }).join("\n");
          result.push({ role: "tool", tool_call_id: id, content: part.is_error ? JSON.stringify({ error: toolContent }) : toolContent });
          awaitingTools.delete(id); break;
        }
        case "thinking":
        // Earlier streamed Chat responses lost this marker in the Agent SDK.
        // Keep those saved turns replayable; foreign opaque signatures still fail.
        if (message.role !== "assistant" || (part.signature !== "chat-reasoning" && part.signature !== "")) unsupported("Only Chat Completions reasoning can be replayed to this provider");
          reasoning += string(part.thinking, "thinking.thinking"); break;
        default: unsupported(`Unsupported Anthropic content type for Chat Completions: ${part.type}`);
      }
    }
    flush();
    // OpenAI requires every function result before the next user message. MCP
    // screenshot images therefore wait for all parallel calls, even when the
    // Agent SDK puts those results in separate consecutive user messages.
    flushUser();
  }
  if (deferredUserContent.length) unsupported("Cannot attach tool images or user content before all parallel tool results have been supplied");
  return result;
}
function chatRequest(body: Wire, config: ProviderConfig): Wire {
  const provider = config.type;
  if (body.top_k !== undefined) unsupported("top_k is not supported by Chat Completions");
  const tools = toolDefinitions(body);
  const result: Wire = { model: body.model, messages: chatMessages(body), [provider === "openai" ? "max_completion_tokens" : "max_tokens"]: body.max_tokens, stream: Boolean(body.stream) };
  const thinking = checkThinking(body, "chat");
  if (thinking) {
    if (provider === "kimi" && /^kimi-k3(?:[.-]|$)/.test(body.model)) {
      if (body.thinking?.type === "disabled") unsupported("Kimi K3 models always reason; thinking cannot be disabled");
      if (body.output_config?.effort) result.reasoning_effort = body.output_config.effort === "medium" ? "high" : body.output_config.effort;
    } else if (provider === "kimi" && /^kimi-k2\.[567](?:-|$)/.test(body.model)) {
      if (body.thinking?.type === "disabled" && /^kimi-k2\.7/.test(body.model)) unsupported("Kimi K2.7 models always reason; thinking cannot be disabled");
      result.thinking = { type: body.thinking?.type === "disabled" ? "disabled" : "enabled", ...(/^kimi-k2\.[67]/.test(body.model) ? { keep: "all" } : {}) };
    } else if (provider === "deepseek") {
      result.thinking = { type: body.thinking?.type === "disabled" ? "disabled" : "enabled" };
      if (body.output_config?.effort) result.reasoning_effort = body.output_config.effort === "medium" ? "high" : body.output_config.effort;
    } else if (provider === "openai" && /^o[1-9](?:[.-]|$)/.test(body.model) && !/^o1-(?:mini|preview)(?:-|$)/.test(body.model)) {
      result.reasoning_effort = thinking.effort === "xhigh" ? "high" : thinking.effort;
    } else if (provider === "xai" && /^grok-(?:3-mini(?:-fast)?|4\.[34567])(?:-|$)/.test(body.model)) {
      result.reasoning_effort = /^grok-3-mini/.test(body.model) && thinking.effort !== "low" ? "high" : thinking.effort;
    }
    // Custom Chat services expose user-configurable levels even without catalog
    // metadata. Preserve the selected wire value, including medium and max.
    if (hasCustomProviderApi(config) && body.output_config?.effort && body.thinking?.type !== "disabled") result.reasoning_effort = body.output_config.effort;
    // Unknown official models keep their own generation defaults; report when
    // the SDK's effort control could not be enforced.
  }
  if (body.stream) result.stream_options = { include_usage: true };
  if (tools.length) result.tools = tools.map((tool) => ({ type: "function", function: tool }));
  for (const key of ["temperature", "top_p"]) if (body[key] !== undefined) result[key] = body[key];
  if (body.stop_sequences?.length) result.stop = body.stop_sequences;
  if (body.metadata?.user_id) result.user = body.metadata.user_id;
  if (body.tool_choice) {
    const choice = body.tool_choice;
    if (choice.type === "tool") result.tool_choice = { type: "function", function: { name: string(choice.name, "tool_choice.name") } };
    else if (["auto", "none", "any"].includes(choice.type)) result.tool_choice = choice.type === "any" ? "required" : choice.type;
    else unsupported(`Unsupported tool_choice: ${choice.type}`);
    if (choice.disable_parallel_tool_use !== undefined) result.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  return result;
}
function responsesRequest(body: Wire, chatgptBackend: boolean): Wire {
  if (body.top_k !== undefined || body.stop_sequences?.length) unsupported("Codex Responses does not support top_k or stop_sequences");
  // The ChatGPT backend accepts Responses item lists, store:false and streaming only.
  const input: Wire[] = [];
  for (const message of body.messages) {
    let content: Wire[] = [];
    const flush = () => { if (content.length) input.push({ role: message.role, content }); content = []; };
    for (const part of blocks(message.content)) {
      switch (part.type) {
        case "text": content.push({ type: message.role === "assistant" ? "output_text" : "input_text", text: string(part.text, "text.text") }); break;
        case "image":
          if (message.role !== "user") unsupported("Codex Responses does not accept assistant images");
          content.push({ type: "input_image", image_url: imageUrl(part) }); break;
        case "tool_use":
          if (message.role !== "assistant") unsupported("tool_use requires an assistant message");
          flush(); input.push({ type: "function_call", call_id: string(part.id, "tool_use.id"), name: string(part.name, "tool_use.name"), arguments: JSON.stringify(object(part.input, "tool_use.input")) }); break;
        case "tool_result": {
          if (message.role !== "user") unsupported("tool_result requires a user message");
          const parts = toolResultParts(part); const hasImages = parts.some((content) => content.type === "image");
          const output = hasImages ? [
            ...(part.is_error ? [{ type: "input_text", text: "Tool returned an error." }] : []),
            ...parts.map((content) => content.type === "text" ? { type: "input_text", text: content.text } : { type: "input_image", image_url: imageUrl(content), detail: "original" }),
          ] : part.is_error ? JSON.stringify({ error: text(parts, "tool_result") }) : text(parts, "tool_result");
          flush(); input.push({ type: "function_call_output", call_id: string(part.tool_use_id, "tool_result.tool_use_id"), output }); break;
        }
        case "thinking": {
          if (message.role !== "assistant" || !part.signature?.startsWith("openai:")) unsupported("Only Codex reasoning items can be replayed to Codex Responses");
          flush();
          let item: Wire;
          try { item = object(JSON.parse(Buffer.from(part.signature.slice(7), "base64url").toString()), "Codex reasoning item"); }
          catch { unsupported("Malformed Codex reasoning signature"); }
          if (item.type !== "reasoning") unsupported("Invalid Codex reasoning item type");
          input.push(item); break;
        }
        default: unsupported(`Unsupported Anthropic content type for Codex Responses: ${part.type}`);
      }
    }
    flush();
  }
  const result: Wire = { model: body.model, instructions: body.system === undefined ? "" : text(body.system, "system"), input, tools: toolDefinitions(body).map((tool) => ({ type: "function", ...tool, strict: false })), store: false, stream: true, include: ["reasoning.encrypted_content"] };
  // Codex intentionally does not send max_output_tokens, temperature or top_p:
  // those public Responses options are not accepted by the ChatGPT backend.
  if (chatgptBackend) {
    if ((body.temperature !== undefined && body.temperature !== 1) || (body.top_p !== undefined && body.top_p !== 1)) unsupported("Codex Responses does not support custom temperature or top_p");
  } else {
    result.max_output_tokens = body.max_tokens;
    for (const key of ["temperature", "top_p"]) if (body[key] !== undefined) result[key] = body[key];
  }
  const reasoning = checkThinking(body, "responses"); if (reasoning) result.reasoning = reasoning;
  if (body.tool_choice) {
    const choice = body.tool_choice;
    if (choice.type === "tool") result.tool_choice = { type: "function", name: string(choice.name, "tool_choice.name") };
    else if (["auto", "none", "any"].includes(choice.type)) result.tool_choice = choice.type === "any" ? "required" : choice.type;
    else unsupported(`Unsupported tool_choice: ${choice.type}`);
    if (choice.disable_parallel_tool_use !== undefined) result.parallel_tool_calls = !choice.disable_parallel_tool_use;
  }
  return result;
}

// Tool ids are opaque to the agent. Embedding provider metadata keeps required Gemini
// thought signatures available on the next turn and after a gateway/app restart.
function geminiId(call: Wire, signature?: string): string {
  return `gcall_${Buffer.from(JSON.stringify({ id: call.id, name: call.name, ...(signature ? { signature } : {}) })).toString("base64url")}_${randomUUID().slice(0, 8)}`;
}
function geminiCall(id: string, fallback?: string): Wire {
  if (id.startsWith("gcall_")) {
    try { return object(JSON.parse(Buffer.from(id.slice(6, id.lastIndexOf("_")), "base64url").toString()), "Gemini tool metadata"); }
    catch { unsupported("Malformed Gemini tool call id"); }
  }
  if (!fallback) unsupported("Gemini tool_result references an unknown tool_use id");
  return { name: fallback };
}
function geminiRequest(body: Wire, customApi = false): Wire {
  const names = new Map<string, string>();
  const systemInstructions: Wire[] = body.system === undefined ? [] : [{ text: text(body.system, "system") }];
  // Gemini has one systemInstruction rather than system-role history items.
  // Merge their text in source order at system priority; never downgrade them
  // to ordinary user instructions or discard the SDK's trailing system update.
  const messages = body.messages.filter((message: Wire) => {
    if (message.role !== "system") return true;
    systemInstructions.push({ text: text(message.content, "system message") }); return false;
  });
  const contents = messages.map((message: Wire) => {
    const parts: Wire[] = [];
    const toolImages: Wire[] = [];
    for (const part of blocks(message.content)) {
      if (part.type === "thinking" && part.signature?.startsWith("gemini-text:")) {
        const previous = parts.at(-1);
        if (!previous || typeof previous.text !== "string" || previous.thought) unsupported("Gemini text signature must follow its text block");
        previous.thoughtSignature = Buffer.from(part.signature.slice(12), "base64url").toString();
        continue;
      }
      const mapped = (() => {
      switch (part.type) {
        case "text": return { text: string(part.text, "text.text") };
        case "image": return geminiImage(part);
        case "tool_use": {
          if (message.role !== "assistant") unsupported("tool_use requires an assistant message");
          const id = string(part.id, "tool_use.id"); const name = string(part.name, "tool_use.name"); names.set(id, name);
          const meta = geminiCall(id, name);
          return { functionCall: { ...(meta.id ? { id: meta.id } : {}), name, args: object(part.input, "tool_use.input") }, ...(meta.signature ? { thoughtSignature: meta.signature } : {}) };
        }
        case "tool_result": {
          if (message.role !== "user") unsupported("tool_result requires a user message");
          const id = string(part.tool_use_id, "tool_result.tool_use_id"); const meta = geminiCall(id, names.get(id));
          const responseParts = toolResultParts(part); const images = responseParts.filter((content) => content.type === "image");
          const response: Wire = { ...(meta.id ? { id: meta.id } : {}), name: meta.name, response: { [part.is_error ? "error" : "result"]: text(responseParts.filter((content) => content.type === "text"), "tool_result") } };
          if (images.length) {
            const nativeMultimodal = /^gemini-(?:[3-9]|[1-9]\d)(?:[.-]|$)/.test(body.model.replace(/^models\//, ""));
            if (nativeMultimodal) response.parts = images.map((image) => {
              const mapped = geminiImage(image);
              if (!["image/png", "image/jpeg", "image/webp"].includes(mapped.inlineData.mimeType)) unsupported(`Unsupported Gemini function response image type: ${mapped.inlineData.mimeType}`);
              return mapped;
            });
            else {
              response.response[part.is_error ? "error" : "result"] += `\n[${images.length} image(s) from tool result ${id} attached after all function responses.]`;
              images.forEach((image, index) => toolImages.push({ text: `Image ${index + 1} from tool result ${id}${part.is_error ? " (tool error)" : ""}` }, geminiImage(image)));
            }
          }
          return { functionResponse: response };
        }
        case "thinking": {
          if (!part.signature?.startsWith("gemini:")) unsupported("Only Gemini thought signatures can be replayed to Gemini");
          return { text: string(part.thinking, "thinking.thinking"), thought: true, thoughtSignature: part.signature.slice(7) };
        }
        default: return unsupported(`Unsupported Anthropic content type for Gemini: ${part.type}`);
      }
      })();
      parts.push(mapped);
    }
    return { role: message.role === "assistant" ? "model" : "user", parts: [...parts, ...toolImages] };
  });
  const generationConfig: Wire = { maxOutputTokens: body.max_tokens };
  for (const [from, to] of [["temperature", "temperature"], ["top_p", "topP"], ["top_k", "topK"]]) if (body[from] !== undefined) generationConfig[to] = body[from];
  if (body.stop_sequences?.length) generationConfig.stopSequences = body.stop_sequences;
  const thinking = checkThinking(body, "gemini", customApi); if (thinking) generationConfig.thinkingConfig = thinking;
  const groupedContents: Wire[] = [];
  for (const content of contents) {
    const previous = groupedContents.at(-1);
    if (content.role === "user" && previous?.role === "user") previous.parts.push(...content.parts);
    else groupedContents.push(content);
  }
  // The SDK can split parallel tool results across user messages. Gemini expects
  // the full set of function responses together before any accompanying images.
  for (const content of groupedContents) if (content.role === "user" && content.parts.some((part: Wire) => part.functionResponse)) {
    content.parts = [...content.parts.filter((part: Wire) => part.functionResponse), ...content.parts.filter((part: Wire) => !part.functionResponse)];
  }
  const result: Wire = { contents: groupedContents, generationConfig };
  if (systemInstructions.length) result.systemInstruction = { parts: systemInstructions };
  const tools = toolDefinitions(body); if (tools.length) result.tools = [{ functionDeclarations: tools }];
  if (body.tool_choice) {
    const choice = body.tool_choice; const mode = ({ auto: "AUTO", none: "NONE", any: "ANY", tool: "ANY" } as Wire)[choice.type];
    if (!mode) unsupported(`Unsupported tool_choice: ${choice.type}`);
    if (choice.disable_parallel_tool_use) unsupported("Gemini cannot enforce disable_parallel_tool_use");
    result.toolConfig = { functionCallingConfig: { mode, ...(choice.type === "tool" ? { allowedFunctionNames: [string(choice.name, "tool_choice.name")] } : {}) } };
  }
  return result;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function usage(value: Wire | undefined, protocol: Protocol): Usage {
  if (!value) return {};
  const input = tokenCount(protocol === "gemini" ? value.promptTokenCount : protocol === "chat" ? value.prompt_tokens : value.input_tokens);
  let output = tokenCount(protocol === "gemini" ? value.candidatesTokenCount : protocol === "chat" ? value.completion_tokens : value.output_tokens);
  if (protocol === "gemini") {
    const thoughts = tokenCount(value.thoughtsTokenCount);
    if (thoughts !== undefined) output = tokenCount((output ?? 0) + thoughts);
  }
  const cached = tokenCount(protocol === "gemini" ? value.cachedContentTokenCount : protocol === "chat" ? value.prompt_tokens_details?.cached_tokens ?? value.prompt_cache_hit_tokens : value.input_tokens_details?.cached_tokens);
  // OpenAI/Gemini prompt totals already include cached input. Anthropic counts
  // uncached input and cache reads separately; output totals already include
  // OpenAI reasoning, while Gemini reports thoughts as a separate output count.
  return { ...(input !== undefined ? { input_tokens: Math.max(0, input - (cached ?? 0)) } : {}), ...(output !== undefined ? { output_tokens: output } : {}), ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}) };
}
function reason(value: string | undefined, hasTools: boolean): string {
  if (hasTools) return "tool_use";
  if (value === "length" || value === "MAX_TOKENS" || value === "max_output_tokens") return "max_tokens";
  if (["content_filter", "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(value ?? "")) return "refusal";
  return "end_turn";
}
function toolInput(value: unknown): Wire {
  try { return object(JSON.parse(string(value, "function arguments") || "{}"), "function arguments"); }
  catch (error) { throw new Error(`Invalid upstream function arguments: ${error instanceof Error ? error.message : "invalid JSON"}`); }
}
function message(model: string, content: Wire[], stop: string, tokenUsage: Usage, id?: string): Wire {
  return { id: id || `msg_${randomUUID()}`, type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage: tokenUsage };
}
function chatMessage(value: Wire, model: string): Wire {
  if (value.error) throw new Error(value.error.message || "Chat Completions returned an error");
  const choice = value.choices?.[0]; if (!choice?.message) throw new Error("Upstream Chat Completions response has no message");
  const source = choice.message; const content: Wire[] = [];
  if (source.content) {
    if (typeof source.content !== "string") throw new Error("Unsupported non-text upstream Chat Completions content");
    content.push({ type: "text", text: source.content });
  }
  if (source.refusal) content.push({ type: "text", text: source.refusal });
  if (source.audio || source.function_call) throw new Error("Unsupported upstream audio or legacy function_call output");
  if (source.reasoning_content || source.reasoning) content.unshift({ type: "thinking", thinking: source.reasoning_content || source.reasoning, signature: "chat-reasoning" });
  for (const call of source.tool_calls ?? []) {
    if (call.type && call.type !== "function") throw new Error(`Unsupported upstream tool call: ${call.type}`);
    content.push({ type: "tool_use", id: string(call.id, "tool call id"), name: string(call.function?.name, "tool call name"), input: toolInput(call.function.arguments) });
  }
  return message(model, content, reason(choice.finish_reason, Boolean(source.tool_calls?.length)), usage(value.usage, "chat"), value.id);
}
function geminiParts(parts: Wire[]): Wire[] {
  const content: Wire[] = [];
  for (const part of parts) {
    if (part.functionCall) content.push({ type: "tool_use", id: geminiId(part.functionCall, part.thoughtSignature), name: string(part.functionCall.name, "Gemini function name"), input: object(part.functionCall.args ?? {}, "Gemini function args") });
    else if (typeof part.text === "string") {
      if (part.thought) content.push({ type: "thinking", thinking: part.text, signature: part.thoughtSignature ? `gemini:${part.thoughtSignature}` : "gemini:" });
      else if (part.thoughtSignature) {
        // Preserve signatures attached to ordinary text as an adjacent opaque thinking block.
        content.push({ type: "text", text: part.text }, { type: "thinking", thinking: "", signature: `gemini-text:${Buffer.from(part.thoughtSignature).toString("base64url")}` });
      } else content.push({ type: "text", text: part.text });
    } else throw new Error(`Unsupported Gemini output part: ${Object.keys(part).join(", ")}`);
  }
  return content;
}
function geminiMessage(value: Wire, model: string): Wire {
  const candidate = value.candidates?.[0];
  if (!candidate) throw new Error(`Gemini returned no candidate${value.promptFeedback?.blockReason ? `: ${value.promptFeedback.blockReason}` : ""}`);
  if (candidate.finishReason && !["STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(candidate.finishReason)) throw new Error(`Gemini generation failed: ${candidate.finishReason}`);
  const content = geminiParts(candidate.content?.parts ?? []);
  return message(model, content, reason(candidate.finishReason, content.some((part) => part.type === "tool_use")), usage(value.usageMetadata, "gemini"), value.responseId);
}

class MessageEvents {
  readonly blocks = new Map<string, Block>();
  readonly events: Wire[] = [];
  tokenUsage: Usage = {};
  private rawUsage: Wire = {};
  stop = "end_turn";
  started = false;
  finished = false;
  hasTools = false;
  constructor(readonly model: string) {}
  updateUsage(value: Wire, protocol: Protocol) {
    // Providers may split cumulative usage fields across separate events. Merge
    // their raw totals before subtracting cache or adding Gemini thought output.
    const fields = protocol === "gemini" ? ["promptTokenCount", "cachedContentTokenCount", "candidatesTokenCount", "thoughtsTokenCount"] : protocol === "chat" ? ["prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens"] : ["input_tokens", "output_tokens"];
    for (const field of fields) if (tokenCount(value[field]) !== undefined) this.rawUsage[field] = value[field];
    for (const field of ["prompt_tokens_details", "input_tokens_details"]) {
      if (tokenCount(value[field]?.cached_tokens) !== undefined) this.rawUsage[field] = { cached_tokens: value[field].cached_tokens };
    }
    this.tokenUsage = usage(this.rawUsage, protocol);
  }
  start(id?: string) {
    if (this.started) return; this.started = true;
    this.events.push({ type: "message_start", message: { ...message(this.model, [], "", this.tokenUsage, id), stop_reason: null } });
  }
  block(key: string, value: Wire): Block {
    const previous = this.blocks.get(key); if (previous) return previous;
    this.start(); const block = { index: this.blocks.size, value, closed: false }; this.blocks.set(key, block);
    if (value.type === "tool_use") this.hasTools = true;
    // The SDK resets thinking signatures on block start and reconstructs them
    // only from signature_delta events, immediately before the block closes.
    this.events.push({ type: "content_block_start", index: block.index, content_block: value.type === "thinking" ? { ...value, signature: "" } : value }); return block;
  }
  delta(key: string, value: Wire, delta: Wire) {
    const block = this.block(key, value); if (block.closed) throw new Error("Upstream sent a delta after closing its content block");
    this.events.push({ type: "content_block_delta", index: block.index, delta });
  }
  close(key: string) {
    const block = this.blocks.get(key); if (!block || block.closed) return; block.closed = true;
    if (block.value.type === "thinking" && block.value.signature) this.events.push({ type: "content_block_delta", index: block.index, delta: { type: "signature_delta", signature: block.value.signature } });
    this.events.push({ type: "content_block_stop", index: block.index });
  }
  finish() {
    if (this.finished) return; this.start(); this.finished = true;
    for (const key of this.blocks.keys()) this.close(key);
    this.events.push({ type: "message_delta", delta: { stop_reason: this.hasTools ? "tool_use" : this.stop, stop_sequence: null }, usage: this.tokenUsage }, { type: "message_stop" });
  }
  drain() { return this.events.splice(0); }
}

// An incremental UTF-8/SSE parser: handles CRLF and JSON split at arbitrary byte boundaries.
// Only a single event is buffered (limited to 8 MiB), never the complete model response.
async function* readSse(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder(); let pending = ""; let lines: string[] = [];
  const aborted = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const { value, done } = await reader.read(); signal.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length + lines.reduce((sum, line) => sum + line.length, 0) > 8 * 1024 * 1024) throw new Error("Upstream SSE event exceeded 8 MiB");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, ""); pending = pending.slice(newline + 1);
        if (line === "") { if (lines.length) yield lines.join("\n"); lines = []; }
        else if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
      }
      if (done) { if (pending.startsWith("data:")) lines.push(pending.slice(5).replace(/^ /, "")); if (lines.length) yield lines.join("\n"); return; }
    }
  } finally { signal.removeEventListener("abort", aborted); }
}
function upstreamError(value: Wire): string {
  return value.error?.message || value.response?.error?.message || value.message || "Upstream provider reported an error";
}
async function* translateEvents(reader: ReadableStreamDefaultReader<Uint8Array>, protocol: Protocol, body: Wire, signal: AbortSignal): AsyncGenerator<Wire> {
  const out = new MessageEvents(body.model); const calls = new Map<number, Wire>(); let complete = false; let finishSeen = false; let geminiIndex = 0; let geminiTextIndex = 0; let activeChatTool: number | undefined;
  try {
    for await (const data of readSse(reader, signal)) {
      if (data === "[DONE]") { if (protocol !== "chat" || !finishSeen) throw new Error("Upstream SSE terminated without a finish reason"); complete = true; break; }
      const event = object(JSON.parse(data), "upstream SSE event");
      if (event.error || event.type === "error" || event.type === "response.failed") throw new Error(upstreamError(event));
      if (protocol === "chat") {
        if (event.usage) out.updateUsage(event.usage, protocol); out.start(event.id);
        for (const choice of event.choices ?? []) {
          if (choice.index && choice.index !== 0) throw new Error("Multiple Chat Completions choices are not supported");
          const delta = choice.delta ?? {};
          if (delta.audio || delta.function_call) throw new Error("Unsupported upstream audio or legacy function_call delta");
          if (delta.content) { out.close("thinking"); out.delta("text", { type: "text", text: "" }, { type: "text_delta", text: string(delta.content, "chat text delta") }); }
          if (delta.refusal) out.delta("refusal", { type: "text", text: "" }, { type: "text_delta", text: delta.refusal });
          if (delta.reasoning_content || delta.reasoning) out.delta("thinking", { type: "thinking", thinking: "", signature: "chat-reasoning" }, { type: "thinking_delta", thinking: delta.reasoning_content || delta.reasoning });
          for (const call of delta.tool_calls ?? []) {
            if (!Number.isInteger(call.index)) throw new Error("Upstream tool delta has no index");
            if (call.type && call.type !== "function") throw new Error(`Unsupported upstream tool type: ${call.type}`);
            const current = calls.get(call.index) ?? { id: "", name: "", pending: "", started: false };
            if (call.id) current.id += call.id;
            if (call.function?.name) { if (current.started) throw new Error("Upstream changed a tool name after streaming its arguments"); current.name += call.function.name; }
            const partial = call.function?.arguments ?? "";
            if (!current.started) {
              current.pending += partial;
              // Anthropic SDK callbacks assume one active block. Stream the first
              // function's arguments immediately; keep other parallel functions
              // separately until the upstream finish marker makes them complete.
              if (current.id && current.name && current.pending && (activeChatTool === call.index || (activeChatTool === undefined && (calls.size === 0 || calls.keys().next().value === call.index)))) {
                activeChatTool = call.index;
                for (const key of out.blocks.keys()) out.close(key);
                out.delta(`tool:${call.index}`, { type: "tool_use", id: current.id, name: current.name, input: {} }, { type: "input_json_delta", partial_json: current.pending }); current.started = true; current.pending = "";
              }
            } else if (partial) out.delta(`tool:${call.index}`, {}, { type: "input_json_delta", partial_json: partial });
            calls.set(call.index, current);
          }
          if (choice.finish_reason) {
            finishSeen = true; out.stop = reason(choice.finish_reason, calls.size > 0);
            for (const [index, call] of calls) {
              if (!call.started) {
                if (!call.id || !call.name) throw new Error("Incomplete upstream tool call");
                for (const key of out.blocks.keys()) out.close(key);
                out.block(`tool:${index}`, { type: "tool_use", id: call.id, name: call.name, input: {} });
                if (call.pending) out.delta(`tool:${index}`, {}, { type: "input_json_delta", partial_json: call.pending });
                call.started = true;
              }
              out.close(`tool:${index}`);
            }
          }
        }
      } else if (protocol === "responses") {
        const index = event.output_index; const key = `response:${index}`;
        if (event.type === "response.created") out.start(event.response?.id);
        else if (event.type === "response.output_item.added") {
          const item = event.item;
          if (item.type === "function_call") { calls.set(index, { ...item, argsStarted: false }); out.block(key, { type: "tool_use", id: string(item.call_id, "call_id"), name: string(item.name, "function name"), input: {} }); }
          else if (!["message", "reasoning"].includes(item.type)) throw new Error(`Unsupported Responses output item: ${item.type}`);
        } else if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
          out.delta(`${key}:text:${event.content_index ?? 0}`, { type: "text", text: "" }, { type: "text_delta", text: string(event.delta, "Responses text delta") });
        } else if (event.type === "response.function_call_arguments.delta") {
          if (!calls.has(index)) throw new Error("Responses arguments arrived before function call metadata"); calls.get(index)!.argsStarted = true;
          out.delta(key, {}, { type: "input_json_delta", partial_json: string(event.delta, "Responses argument delta") });
        } else if (event.type === "response.output_item.done") {
          const item = event.item;
          if (item.type === "function_call") {
            if (!calls.has(index)) out.block(key, { type: "tool_use", id: item.call_id, name: item.name, input: {} });
            if (!calls.get(index)?.argsStarted && item.arguments) out.delta(key, {}, { type: "input_json_delta", partial_json: item.arguments }); out.close(key);
          } else if (item.type === "reasoning") {
            out.delta(`${key}:thinking`, { type: "thinking", thinking: "", signature: "" }, { type: "signature_delta", signature: `openai:${Buffer.from(JSON.stringify(item)).toString("base64url")}` }); out.close(`${key}:thinking`);
          }
        } else if (event.type === "response.reasoning_summary_text.delta") {
          out.delta(`${key}:thinking`, { type: "thinking", thinking: "", signature: "" }, { type: "thinking_delta", thinking: event.delta });
        } else if (event.type === "response.completed" || event.type === "response.incomplete") {
          if (event.response?.usage) out.updateUsage(event.response.usage, protocol);
          out.stop = reason(event.response?.incomplete_details?.reason, out.hasTools); complete = true;
        } else if (/^response\.(audio|image|web_search|code_interpreter|mcp|file_search|computer|shell)/.test(event.type ?? "")) throw new Error(`Unsupported Responses event: ${event.type}`);
      } else {
        if (event.usageMetadata) out.updateUsage(event.usageMetadata, protocol); out.start(event.responseId);
        if (event.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt: ${event.promptFeedback.blockReason}`);
        for (const candidate of event.candidates ?? []) {
          if (candidate.index && candidate.index !== 0) throw new Error("Multiple Gemini candidates are not supported");
          for (const part of candidate.content?.parts ?? []) {
            if (part.functionCall) {
              const block = geminiParts([part])[0]; const key = `gemini-tool:${geminiIndex++}`;
              out.delta(key, { ...block, input: {} }, { type: "input_json_delta", partial_json: JSON.stringify(block.input) }); out.close(key);
            } else if (typeof part.text === "string") {
              const key = `${part.thought ? "gemini-thinking" : "gemini-text"}:${geminiTextIndex}`;
              out.delta(key, part.thought ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" }, part.thought ? { type: "thinking_delta", thinking: part.text } : { type: "text_delta", text: part.text });
              if (part.thoughtSignature) {
                if (part.thought) out.delta(key, {}, { type: "signature_delta", signature: `gemini:${part.thoughtSignature}` });
                else {
                  out.close(key);
                  out.delta(`${key}:signature`, { type: "thinking", thinking: "", signature: "" }, { type: "signature_delta", signature: `gemini-text:${Buffer.from(part.thoughtSignature).toString("base64url")}` }); out.close(`${key}:signature`);
                }
                out.close(key); geminiTextIndex++;
              }
            } else throw new Error(`Unsupported Gemini output part: ${Object.keys(part).join(", ")}`);
          }
          if (candidate.finishReason) {
            if (!["STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(candidate.finishReason)) throw new Error(`Gemini generation failed: ${candidate.finishReason}`);
            out.stop = reason(candidate.finishReason, out.hasTools); finishSeen = true;
          }
        }
      }
      for (const item of out.drain()) yield item;
      if (complete) break;
    }
    if (protocol === "chat" && finishSeen) complete = true;
    if (protocol === "gemini" && finishSeen) complete = true;
    if (!complete) throw new Error("Upstream SSE ended before a completion event");
    out.finish(); for (const item of out.drain()) yield item;
  } catch (error) {
    signal.throwIfAborted();
    for (const item of out.drain()) yield item;
    yield { type: "error", error: { type: "api_error", message: error instanceof Error ? error.message : "Upstream stream failed" } };
  } finally { await reader.cancel().catch(() => {}); }
}
function eventResponse(upstream: Response, protocol: Protocol, body: Wire, signal: AbortSignal, credential: string): Response {
  if (!upstream.body) throw new Error("Upstream returned an empty streaming body");
  const reader = upstream.body.getReader(); const events = translateEvents(reader, protocol, body, signal);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) controller.close();
        else {
          if (next.value.type === "error") next.value.error.message = redact(next.value.error.message, credential);
          controller.enqueue(encoder.encode(`event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`));
        }
      }
      catch (error) { controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}); await events.return(undefined).catch(() => {}); },
  }, { highWaterMark: 0 });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
async function collectEvents(response: Response, signal: AbortSignal): Promise<Wire> {
  const result: Wire = {}; const content: Wire[] = []; const reader = response.body!.getReader();
  try { for await (const data of readSse(reader, signal)) {
    const event = JSON.parse(data);
    if (event.type === "error") throw new Error(upstreamError(event));
    if (event.type === "message_start") Object.assign(result, event.message);
    if (event.type === "content_block_start") content[event.index] = { ...event.content_block };
    if (event.type === "content_block_delta") {
      const block = content[event.index]; const delta = event.delta;
      if (delta.type === "text_delta") block.text += delta.text;
      if (delta.type === "thinking_delta") block.thinking += delta.thinking;
      if (delta.type === "signature_delta") block.signature += delta.signature;
      if (delta.type === "input_json_delta") block._json = (block._json ?? "") + delta.partial_json;
    }
    if (event.type === "content_block_stop" && content[event.index]._json !== undefined) {
      content[event.index].input = toolInput(content[event.index]._json); delete content[event.index]._json;
    }
    if (event.type === "message_delta") { Object.assign(result, event.delta); result.usage = { ...result.usage, ...event.usage }; }
  } } finally { await reader.cancel().catch(() => {}); }
  return { ...result, content };
}
function redact(value: string, credential: string): string { return (credential ? value.split(credential).join("[redacted]") : value).slice(0, 2048); }
async function errorResponse(response: Response, credential: string): Promise<Response> {
  const raw = await response.text(); let detail = "";
  try { const value = JSON.parse(raw); const message = value.error?.message || value.message; if (typeof message === "string") detail = redact(message, credential); } catch { /* Do not expose HTML/proxy bodies or echoed credentials. */ }
  const type = response.status === 429 ? "rate_limit_error" : response.status === 401 || response.status === 403 ? "authentication_error" : response.status >= 500 ? "api_error" : "invalid_request_error";
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const key of ["retry-after", "request-id", "x-request-id"]) { const value = response.headers.get(key); if (value) headers[key] = value; }
  return new Response(JSON.stringify({ type: "error", error: { type, message: detail || `Provider returned HTTP ${response.status}` } }), { status: response.status, headers });
}

/** Translate the Agent SDK's Anthropic Messages wire format directly to a provider.
 * No CPA process or protocol dependency is involved. The caller owns credential refresh.
 * Sources: OpenAI Responses/Chat streaming reference; Codex's responses endpoint client;
 * Google generateContent/function-calling/thought-signature docs; Anthropic streaming docs.
 */
export async function forwardProviderMessage(config: ProviderConfig, credential: string, value: unknown, options: ForwardOptions): Promise<Response> {
  options.signal.throwIfAborted();
  const oauth = (config.auth as { authMethod: string }).authMethod === "oauth2";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.type === "claude") {
    Object.assign(headers, oauth ? { authorization: `Bearer ${credential}` } : claudeApiKeyHeaders(config, credential));
    headers["anthropic-version"] = options.anthropicVersion || "2023-06-01";
    const betas = new Set([options.anthropicBeta, headers["anthropic-beta"]].flatMap(value => (value ?? "").split(",")).map(beta => beta.trim()).filter(Boolean));
    if (oauth) betas.add("oauth-2025-04-20");
    if (betas.size) headers["anthropic-beta"] = [...betas].join(",");
    if (options.userAgent) headers["user-agent"] = options.userAgent;
    const response = await fetch(apiUrl(config, "messages"), { method: "POST", headers, body: JSON.stringify(value), signal: options.signal, redirect: "error" });
    return response.ok ? response : errorResponse(response, credential);
  }
  const body = validateRequest(value); let protocol: Protocol = "chat"; let url: string; let upstreamBody: Wire;
  const limitations: string[] = [];
  if (config.type === "kimi" && !hasCustomProviderApi(config) && /^kimi-k2\.[567](?:-|$)/.test(body.model) && body.output_config?.effort) limitations.push("reasoning effort is controlled by this Kimi model");
  if (config.type !== "gemini" && body.thinking?.type === "enabled" && body.thinking.budget_tokens !== undefined) limitations.push("thinking.budget_tokens is approximated by the provider reasoning effort");
  const withLimitations = (response: Response): Response => { if (limitations.length) response.headers.set("x-provider-limitations", limitations.join("; ")); return response; };
  if (config.type === "gemini") {
    protocol = "gemini"; upstreamBody = geminiRequest(body, hasCustomProviderApi(config));
    const thinking = upstreamBody.generationConfig.thinkingConfig;
    const effort = body.output_config?.effort;
    if (effort && thinking?.thinkingLevel && effort.toUpperCase() !== thinking.thinkingLevel) limitations.push(`Gemini reasoning effort ${effort} is mapped to native ${thinking.thinkingLevel}; the native protocol does not expose a separate ${effort} level`);
    else if (effort && thinking?.thinkingBudget !== undefined && body.thinking?.type !== "disabled") limitations.push("SDK reasoning effort levels cannot be enforced by this Gemini model; its default thinking budget is used");
    else if ((body.thinking || effort) && !thinking) limitations.push("thinking controls are not advertised for this Gemini model; provider defaults are used");
    if (body.thinking?.type === "disabled" && (hasCustomProviderApi(config) || /-pro(?:-|$)/.test(body.model) || /^gemini-(?:[3-9]|[1-9]\d)(?:[.-]|$)/.test(body.model.replace(/^models\//, "")))) limitations.push("this Gemini model controls its own thinking; only thought display is disabled");
    headers[oauth ? "authorization" : "x-goog-api-key"] = oauth ? `Bearer ${credential}` : credential;
    if (oauth && config.oauthProjectId) headers["x-goog-user-project"] = config.oauthProjectId;
    const model = body.model.replace(/^models\//, "");
    if (!/^[A-Za-z0-9._-]+$/.test(model)) unsupported("Invalid Gemini model name");
    url = apiUrl(config, `models/${encodeURIComponent(model)}:${body.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`);
  } else if (config.type === "openai" && (oauth || /(?:^|-)codex(?:-|$)/.test(body.model) || /^gpt-(?:[5-9]|[1-9]\d)(?:[.-]|$)/.test(body.model))) {
    protocol = "responses"; upstreamBody = responsesRequest(body, oauth);
    if (oauth) limitations.push("max_tokens is controlled by the ChatGPT Codex backend");
    url = oauth ? "https://chatgpt.com/backend-api/codex/responses" : apiUrl(config, "responses");
    headers.authorization = `Bearer ${credential}`; headers.accept = "text/event-stream";
    if (oauth) {
      headers.originator = "codex_cli_rs";
      if (options.oauthToken?.account_id) headers["ChatGPT-Account-Id"] = options.oauthToken.account_id;
    }
  } else {
    if (oauth) unsupported(`OAuth is not supported for ${config.type}`);
    upstreamBody = chatRequest(body, config); headers.authorization = `Bearer ${credential}`;
    if ((body.thinking || body.output_config?.effort) && !upstreamBody.thinking && upstreamBody.reasoning_effort === undefined) limitations.push("reasoning effort controls are not advertised for this model; provider defaults are used");
    url = apiUrl(config, "chat/completions");
  }
  const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody), signal: options.signal, redirect: "error" });
  if (!upstream.ok) return errorResponse(upstream, credential);
  if (protocol === "responses" || body.stream) {
    if (!upstream.headers.get("content-type")?.includes("text/event-stream")) { await upstream.body?.cancel(); throw new Error("Provider did not return the requested SSE stream"); }
    const response = eventResponse(upstream, protocol, body, options.signal, credential);
    if (body.stream) return withLimitations(response);
    return withLimitations(new Response(JSON.stringify(await collectEvents(response, options.signal)), { headers: { "content-type": "application/json" } }));
  }
  const source = object(await upstream.json(), "upstream response");
  return withLimitations(new Response(JSON.stringify(protocol === "gemini" ? geminiMessage(source, body.model) : chatMessage(source, body.model)), { headers: { "content-type": "application/json" } }));
}
