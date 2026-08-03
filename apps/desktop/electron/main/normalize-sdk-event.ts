import type { SdkNormalizedEvent, ToolCardState } from "@claude-desktop/shared";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function summarizeTool(name: string, input: UnknownRecord): string {
  if (name === "Bash") {
    return String(input.command ?? "").slice(0, 120);
  }
  if (name === "Edit" || name === "Write" || name === "Read") {
    return String(input.file_path ?? input.path ?? "");
  }
  return name;
}

function toolPreview(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.slice(0, 200);
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => {
        if (isRecord(c) && typeof c.text === "string") return c.text;
        if (typeof c === "string") return c;
        return "";
      })
      .filter(Boolean);
    if (texts.length) return texts.join("\n").slice(0, 200);
  }
  if (content == null) return undefined;
  try {
    return JSON.stringify(content).slice(0, 200);
  } catch {
    return String(content).slice(0, 200);
  }
}

/**
 * Normalize a single SDK message into zero-or-more UI events.
 * Shape is intentionally loose (any/unknown) until task 13 aligns real SDK types.
 */
export function normalizeSdkEvent(
  msg: unknown,
  sessionId: string,
): SdkNormalizedEvent[] {
  if (!isRecord(msg) || typeof msg.type !== "string") {
    return [];
  }

  switch (msg.type) {
    case "stream_event":
      return normalizeStreamEvent(msg, sessionId);
    case "assistant":
      return normalizeAssistant(msg, sessionId);
    case "user":
      return normalizeUser(msg, sessionId);
    case "result":
      return normalizeResult(msg, sessionId);
    case "tool_progress":
      return normalizeToolProgress(msg, sessionId);
    default:
      return [];
  }
}

function normalizeToolProgress(
  msg: UnknownRecord,
  sessionId: string,
): SdkNormalizedEvent[] {
  const toolUseId = String(msg.tool_use_id ?? "");
  if (!toolUseId) return [];
  const elapsed =
    typeof msg.elapsed_time_seconds === "number"
      ? msg.elapsed_time_seconds
      : 0;
  return [
    {
      type: "tool_progress",
      sessionId,
      toolUseId,
      toolName: String(msg.tool_name ?? "tool"),
      elapsedSeconds: elapsed,
    },
  ];
}

function normalizeStreamEvent(
  msg: UnknownRecord,
  sessionId: string,
): SdkNormalizedEvent[] {
  const event = isRecord(msg.event) ? msg.event : null;
  if (!event) return [];

  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    const delta = event.delta;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return [{ type: "text_delta", sessionId, text: delta.text }];
    }
  }
  return [];
}

function normalizeAssistant(
  msg: UnknownRecord,
  sessionId: string,
): SdkNormalizedEvent[] {
  const message = isRecord(msg.message) ? msg.message : null;
  const content = message ? asArray(message.content) : [];
  const out: SdkNormalizedEvent[] = [];

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;

    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text_done", sessionId, text: block.text });
      continue;
    }

    if (block.type === "tool_use") {
      const id = String(block.id ?? "");
      const name = String(block.name ?? "tool");
      const input = isRecord(block.input) ? block.input : {};
      const tool: ToolCardState = {
        id,
        name,
        summary: summarizeTool(name, input),
        status: "running",
      };
      out.push({ type: "tool_start", sessionId, tool });
    }
  }

  return out;
}

function normalizeUser(
  msg: UnknownRecord,
  sessionId: string,
): SdkNormalizedEvent[] {
  const message = isRecord(msg.message) ? msg.message : null;
  const content = message ? asArray(message.content) : [];
  const out: SdkNormalizedEvent[] = [];

  // string content form
  if (typeof message?.content === "string") {
    return [{ type: "user_message", sessionId, text: message.content }];
  }

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;

    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "user_message", sessionId, text: block.text });
      continue;
    }

    if (block.type === "tool_result") {
      const id = String(block.tool_use_id ?? block.toolUseId ?? "");
      const isError = Boolean(block.is_error ?? block.isError);
      const tool: ToolCardState = {
        id,
        name: String(block.name ?? "tool"),
        summary: "",
        status: isError ? "error" : "done",
        resultPreview: toolPreview(block.content),
      };
      out.push({ type: "tool_end", sessionId, tool });
    }
  }

  return out;
}

function normalizeResult(
  msg: UnknownRecord,
  sessionId: string,
): SdkNormalizedEvent[] {
  const isError =
    msg.is_error === true ||
    msg.subtype === "error" ||
    (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));

  const costUsd =
    typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined;

  if (isError) {
    let error: string | undefined;
    if (Array.isArray(msg.errors) && msg.errors.length) {
      error = msg.errors.map(String).join("; ");
    } else if (typeof msg.error === "string") {
      error = msg.error;
    } else if (typeof msg.result === "string") {
      error = msg.result;
    } else {
      error = "SDK result error";
    }
    return [{ type: "result", sessionId, ok: false, costUsd, error }];
  }

  return [{ type: "result", sessionId, ok: true, costUsd }];
}
