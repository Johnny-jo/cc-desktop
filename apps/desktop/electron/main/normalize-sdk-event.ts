import type { SdkNormalizedEvent, TodoItem, ToolCardState } from "@claude-desktop/shared";

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
  if (name === "Skill" || name === "skill") {
    // Skill tool dumps full SKILL.md — keep card summary short (path/name only).
    return String(
      input.skill ?? input.name ?? input.path ?? input.skill_name ?? "skill",
    ).slice(0, 120);
  }
  if (name === "TodoWrite") {
    return todoSummary(extractTodos(input));
  }
  if (name === "TaskCreate") {
    // Single-task creation: show its subject; full card renders from todos.
    return String(input.subject ?? input.description ?? "TaskCreate").slice(0, 120);
  }
  if (name === "TaskUpdate") {
    return `Update #${String(input.taskId ?? "")} → ${String(input.status ?? "")}`.trim();
  }
  if (name === "Task" || name === "Agent") {
    // Subagent launch: show the task description (or agent type) as the summary.
    return String(input.description ?? input.subagent_type ?? input.prompt ?? name).slice(
      0,
      120,
    );
  }
  return name;
}

/** Extract the structured todo list from a TodoWrite tool input. */
function extractTodos(input: UnknownRecord): TodoItem[] {
  const raw = asArray(input.todos);
  const out: TodoItem[] = [];
  for (const t of raw) {
    if (!isRecord(t)) continue;
    const content = String(t.content ?? t.task ?? "");
    if (!content) continue;
    const status =
      t.status === "completed" || t.status === "in_progress"
        ? t.status
        : "pending";
    out.push({
      content,
      status,
      ...(typeof t.activeForm === "string" ? { activeForm: t.activeForm } : {}),
    });
  }
  return out;
}

function todoSummary(todos: TodoItem[]): string {
  if (!todos.length) return "TodoWrite";
  const done = todos.filter((t) => t.status === "completed").length;
  return `${done}/${todos.length} completed`;
}

/** TaskCreate input → a single pending todo (subject + activeForm). */
function taskCreateTodo(input: UnknownRecord): TodoItem[] {
  const content = String(input.subject ?? input.description ?? "");
  if (!content) return [];
  return [
    {
      content,
      status: "pending",
      ...(typeof input.activeForm === "string"
        ? { activeForm: input.activeForm }
        : {}),
    },
  ];
}

/** TaskList tool_result content → todos (id, subject, status). */
function taskListTodos(content: unknown): TodoItem[] {
  // content may be a JSON string or a parsed object/array depending on SDK framing.
  let parsed: unknown = content;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      return [];
    }
  }
  if (Array.isArray(content)) {
    // content blocks: find a text block holding JSON
    for (const c of content) {
      if (isRecord(c) && typeof c.text === "string") {
        try {
          parsed = JSON.parse(c.text);
          break;
        } catch {
          // keep looking
        }
      }
    }
  }
  const tasks = isRecord(parsed) ? asArray(parsed.tasks) : asArray(parsed);
  const out: TodoItem[] = [];
  for (const t of tasks) {
    if (!isRecord(t)) continue;
    const content = String(t.subject ?? t.content ?? "");
    if (!content) continue;
    const status =
      t.status === "completed" || t.status === "in_progress"
        ? t.status
        : "pending";
    out.push({ content, status });
  }
  return out;
}

/** Skill / long system-injected bodies should not dump open in the chat. */
export function isCollapsibleSkillText(text: string): boolean {
  if (text.length < 200) return false;
  return (
    /Base directory for this skill/i.test(text) ||
    /<SUBAGENT-STOP>/i.test(text) ||
    /<EXTREMELY-IMPORTANT>/i.test(text) ||
    (/Launching skill:/i.test(text) && text.length > 300) ||
    (/SKILL\.md|skill body|using-superpowers/i.test(text) && text.length > 400)
  );
}

function toolPreview(content: unknown, maxLen = 200): string | undefined {
  if (typeof content === "string") {
    return content.slice(0, maxLen);
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => {
        if (isRecord(c) && typeof c.text === "string") return c.text;
        if (typeof c === "string") return c;
        return "";
      })
      .filter(Boolean);
    if (texts.length) return texts.join("\n").slice(0, maxLen);
  }
  if (content == null) return undefined;
  try {
    return JSON.stringify(content).slice(0, maxLen);
  } catch {
    return String(content).slice(0, maxLen);
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

/** True when the SDK message carries a parent_tool_use_id (ran inside a subagent). */
function isSubagentMessage(msg: UnknownRecord): boolean {
  return msg.parent_tool_use_id != null;
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

  if (event.type === "content_block_start" && isRecord(event.content_block)) {
    const kind = event.content_block.type;
    if (kind === "thinking" || kind === "redacted_thinking") {
      return [{ type: "thinking_delta", sessionId, text: "" }];
    }
  }

  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    const delta = event.delta;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return [{ type: "text_delta", sessionId, text: delta.text }];
    }
    if (delta.type === "thinking_delta") {
      const thinking =
        typeof delta.thinking === "string" ? delta.thinking : "";
      return [{ type: "thinking_delta", sessionId, text: thinking }];
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

    // Some compatible providers omit partial stream events but include the
    // completed reasoning block in the final assistant message. Normalize it
    // too; the transcript reducer ignores a late duplicate once answer text
    // has already started, so streamed providers are not rendered twice.
    if (block.type === "thinking" && typeof block.thinking === "string") {
      out.push({ type: "thinking_delta", sessionId, text: block.thinking });
      continue;
    }

    if (block.type === "text" && typeof block.text === "string") {
      // Skill dumps often arrive as assistant text — fold into a collapsible tool card.
      if (isCollapsibleSkillText(block.text)) {
        const id = `skill-text-${String(block.id ?? block.text.slice(0, 24))}`;
        const tool: ToolCardState = {
          id,
          name: "Skill",
          summary: skillSummaryFromText(block.text),
          status: "done",
          resultPreview: block.text.slice(0, 4000),
        };
        out.push({ type: "tool_start", sessionId, tool });
        out.push({ type: "tool_end", sessionId, tool });
      } else {
        out.push({ type: "text_done", sessionId, text: block.text });
      }
      continue;
    }

    if (block.type === "tool_use") {
      const id = String(block.id ?? "");
      const name = String(block.name ?? "tool");
      const input = isRecord(block.input) ? block.input : {};
      const isSub = isSubagentMessage(msg);
      const tool: ToolCardState = {
        id,
        name,
        summary: summarizeTool(name, input),
        status: "running",
        ...(isSub ? { isSubagent: true } : {}),
        ...(name === "TodoWrite" ? { todos: extractTodos(input) } : {}),
        ...(name === "TaskCreate" ? { todos: taskCreateTodo(input) } : {}),
      };
      out.push({ type: "tool_start", sessionId, tool });
    }
  }

  return out;
}

function skillSummaryFromText(text: string): string {
  const dir = text.match(/Base directory for this skill:\s*(.+)/i);
  if (dir?.[1]) {
    const p = dir[1].trim().split(/[/\\]/).filter(Boolean);
    return p[p.length - 1] ?? dir[1].trim().slice(0, 80);
  }
  const first = text.split("\n").find((l) => l.trim().length > 0);
  return (first ?? "skill content").trim().slice(0, 80);
}

function normalizeUser(
  msg: UnknownRecord,
  sessionId: string,
): SdkNormalizedEvent[] {
  const message = isRecord(msg.message) ? msg.message : null;
  const content = message ? asArray(message.content) : [];
  const out: SdkNormalizedEvent[] = [];

  // Synthetic / meta user frames (tool echoes, etc.) — never show as chat bubbles.
  if (msg.isSynthetic === true || msg.is_synthetic === true) {
    // still process tool_result below; skip bare text
  }

  // string content form
  if (typeof message?.content === "string") {
    if (msg.isSynthetic === true || msg.is_synthetic === true) {
      return out;
    }
    return [{ type: "user_message", sessionId, text: message.content }];
  }

  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string") continue;

    if (block.type === "text" && typeof block.text === "string") {
      if (msg.isSynthetic !== true && msg.is_synthetic !== true) {
        out.push({ type: "user_message", sessionId, text: block.text });
      }
      continue;
    }

    if (block.type === "tool_result") {
      const id = String(block.tool_use_id ?? block.toolUseId ?? "");
      const isError = Boolean(block.is_error ?? block.isError);
      const name = String(block.name ?? "tool");
      const isSub = isSubagentMessage(msg);
      // Keep skill bodies in the collapsed card; don't also emit as chat text.
      // Task/Agent results are the subagent's final report — high value, so widen
      // the preview cap. TodoWrite relies on structured todos, not resultPreview.
      const preview =
        name === "Skill" || name === "skill"
          ? toolPreview(block.content, 4000) ??
            (typeof block.content === "string"
              ? block.content.slice(0, 4000)
              : undefined)
          : name === "Task" || name === "Agent"
            ? toolPreview(block.content, 2000)
            : toolPreview(block.content);
      const tool: ToolCardState = {
        id,
        name,
        summary:
          name === "Skill" || name === "skill"
            ? skillSummaryFromText(
                typeof block.content === "string"
                  ? block.content
                  : preview ?? "",
              )
            : "",
        status: isError ? "error" : "done",
        resultPreview: preview,
        ...(isSub ? { isSubagent: true } : {}),
        ...(name === "TaskList" ? { todos: taskListTodos(block.content) } : {}),
      };
      out.push({ type: "tool_end", sessionId, tool });
    }
  }

  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Pull token/cost/timing fields from an SDK result message (success or error). */
export function extractTurnUsage(msg: UnknownRecord): {
  costUsd?: number;
  usage?: import("@claude-desktop/shared").TurnUsage;
} {
  const costUsd =
    num(msg.total_cost_usd) ?? num(msg.totalCostUsd) ?? undefined;

  const usageObj = isRecord(msg.usage) ? msg.usage : null;
  // Anthropic-style snake_case on NonNullableUsage / BetaUsage
  const inputTokens =
    num(usageObj?.input_tokens) ??
    num(usageObj?.inputTokens) ??
    num(usageObj?.prompt_tokens) ??
    num(usageObj?.promptTokens) ??
    undefined;
  const outputTokens =
    num(usageObj?.output_tokens) ??
    num(usageObj?.outputTokens) ??
    num(usageObj?.completion_tokens) ??
    num(usageObj?.completionTokens) ??
    undefined;
  const cacheReadTokens =
    num(usageObj?.cache_read_input_tokens) ??
    num(usageObj?.cacheReadInputTokens) ??
    undefined;
  const cacheCreationTokens =
    num(usageObj?.cache_creation_input_tokens) ??
    num(usageObj?.cacheCreationInputTokens) ??
    undefined;

  // Also sum modelUsage map if present (camelCase ModelUsage entries)
  let modelIn = 0;
  let modelOut = 0;
  let modelCost = 0;
  const modelUsage = isRecord(msg.modelUsage)
    ? msg.modelUsage
    : isRecord(msg.model_usage)
      ? msg.model_usage
      : null;
  if (modelUsage) {
    for (const v of Object.values(modelUsage)) {
      if (!isRecord(v)) continue;
      modelIn +=
        num(v.inputTokens) ??
        num(v.input_tokens) ??
        num(v.promptTokens) ??
        num(v.prompt_tokens) ??
        0;
      modelOut +=
        num(v.outputTokens) ??
        num(v.output_tokens) ??
        num(v.completionTokens) ??
        num(v.completion_tokens) ??
        0;
      modelCost += num(v.costUSD) ?? num(v.cost_usd) ?? 0;
    }
  }

  const durationMs = num(msg.duration_ms) ?? num(msg.durationMs);
  const durationApiMs = num(msg.duration_api_ms) ?? num(msg.durationApiMs);
  const numTurns = num(msg.num_turns) ?? num(msg.numTurns);

  const rawUsage = {
    durationMs,
    durationApiMs,
    inputTokens: inputTokens ?? (modelIn || undefined),
    outputTokens: outputTokens ?? (modelOut || undefined),
    cacheReadTokens,
    cacheCreationTokens,
    costUsd: costUsd ?? (modelCost || undefined),
    numTurns,
  };

  // Drop undefined keys so snapshots / equality checks stay clean.
  const usage: import("@claude-desktop/shared").TurnUsage = {};
  for (const [k, v] of Object.entries(rawUsage)) {
    if (v != null) (usage as Record<string, number>)[k] = v;
  }

  const hasAny = Object.keys(usage).length > 0;
  return {
    costUsd: usage.costUsd,
    usage: hasAny ? usage : undefined,
  };
}

function normalizeResult(
  msg: UnknownRecord,
  sessionId: string,
): SdkNormalizedEvent[] {
  const isError =
    msg.is_error === true ||
    msg.subtype === "error" ||
    (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));

  const { costUsd, usage } = extractTurnUsage(msg);

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
    return [{ type: "result", sessionId, ok: false, costUsd, error, usage }];
  }

  return [{ type: "result", sessionId, ok: true, costUsd, usage }];
}
