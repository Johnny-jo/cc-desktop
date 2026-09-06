import type {
  AgentProgressUpdate, ProgressAgent, ProgressTask, SdkNormalizedEvent,
  TodoItem, ToolCardState, ToolTaskUpdate,
} from "@claude-desktop/shared";

type UnknownRecord = Record<string, unknown>;
type ResolveTool = (id: string) => ToolCardState | undefined;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isAgentTool(name: string): boolean {
  return name === "Task" || name === "Agent";
}

function progressTaskStatus(value: unknown): ProgressTask["status"] | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : undefined;
}

function taskFields(input: UnknownRecord, scope?: string): NonNullable<ToolTaskUpdate["patch"]> {
  const patch: NonNullable<ToolTaskUpdate["patch"]> = {};
  const title = nonemptyString(input.subject) ?? nonemptyString(input.title);
  if (title) patch.title = title;
  for (const key of ["description", "activeForm", "owner"] as const) {
    if (typeof input[key] === "string") patch[key] = input[key];
  }
  const status = progressTaskStatus(input.status);
  if (status) patch.status = status;
  if (input.status === "deleted") patch.deleted = true;
  const taskScope = nonemptyString(input.scope) ?? scope;
  if (taskScope != null) patch.scope = taskScope;
  return patch;
}

function taskInput(name: string, input: UnknownRecord, parent?: string): ToolTaskUpdate | undefined {
  const patch = taskFields(input, parent);
  switch (name) {
    case "TaskCreate":
      return { operation: "create", patch: { ...patch, status: "pending" } };
    case "TaskUpdate":
      return { operation: "update", taskId: nonemptyString(input.taskId), patch };
    case "TaskList":
      return { operation: "list", patch };
    case "TodoWrite": {
      const scope = parent ? "todos:" + parent : "todos";
      const valid = Array.isArray(input.todos) && input.todos.every((row) => isRecord(row) &&
        !!nonemptyString(row.content) && progressTaskStatus(row.status) != null);
      return {
        operation: "replace", patch: { scope },
        ...(valid ? { tasks: extractTodos(input).map((todo, index) => ({
          id: "todo-" + (index + 1), title: todo.content, status: todo.status, scope,
          ...(todo.activeForm != null ? { activeForm: todo.activeForm } : {}),
        })) } : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Decode complete JSON/SDK output before applying any UI preview limit. */
function structuredResult(value: unknown): unknown {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return undefined; }
  }
  if (Array.isArray(value) && value.some((entry) => isRecord(entry) && entry.type === "text")) {
    for (const entry of value) {
      if (!isRecord(entry) || typeof entry.text !== "string") continue;
      const parsed = structuredResult(entry.text);
      if (parsed != null) return parsed;
    }
    return undefined;
  }
  return value;
}

function taskResult(
  name: string,
  requested: ToolTaskUpdate | undefined,
  parsed: unknown,
  content: unknown,
  isError: boolean,
  parent?: string,
): ToolTaskUpdate | undefined {
  const base = requested ?? taskInput(name, {}, parent);
  if (!base) return;
  const result = isRecord(parsed) ? parsed : {};
  if (isError || result.success === false) return { ...base, success: false };
  if (base.operation === "create") {
    const task = isRecord(result.task) ? result.task : result;
    const text = toolPreview(content, Infinity) ?? "";
    const created = text.match(/^Task #([^\s:]+) created successfully:\s*(.+)$/s);
    const taskId = nonemptyString(task.id) ?? nonemptyString(result.taskId) ?? created?.[1];
    const patch = {
      ...base.patch, ...taskFields(task, base.patch?.scope ?? parent),
      ...(created?.[2] && !base.patch?.title && !nonemptyString(task.subject) ? { title: created[2] } : {}),
    };
    return { ...base, ...(taskId ? { taskId } : {}), patch, success: !!taskId && !!patch.title };
  }
  if (base.operation === "update") {
    const taskId = nonemptyString(result.taskId) ?? base.taskId;
    const status = isRecord(result.statusChange) ? progressTaskStatus(result.statusChange.to) : undefined;
    const marker = (toolPreview(content, Infinity) ?? "").trim().match(
      /^Updated task #([^\s]+) (?:subject|description|activeForm|status|owner|metadata|blocks|blockedBy)(?:, (?:subject|description|activeForm|status|owner|metadata|blocks|blockedBy))*$/,
    );
    const success = !!taskId && (result.success === true || marker?.[1] === taskId);
    return { ...base, taskId, ...(status ? { patch: { ...base.patch, status } } : {}), success };
  }
  if (base.operation === "list") {
    const raw = Array.isArray(parsed) ? parsed : result.tasks;
    if (!Array.isArray(raw)) return { ...base, success: false };
    const tasks: ProgressTask[] = [];
    for (const value of raw) {
      if (!isRecord(value)) return { ...base, success: false };
      const id = nonemptyString(value.id);
      const fields = taskFields(value, base.patch?.scope ?? parent);
      if (!id || !fields.title || !fields.status) return { ...base, success: false };
      tasks.push({ ...fields, id, title: fields.title, status: fields.status });
    }
    return { ...base, tasks, success: true };
  }
  const accepted = result.newTodos != null
    ? taskInput("TodoWrite", { todos: result.newTodos }, parent) ?? base
    : base;
  return { ...accepted, success: Array.isArray(accepted.tasks) };
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
  resolveTool?: ResolveTool,
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
      return normalizeUser(msg, sessionId, resolveTool);
    case "system":
      return normalizeAgentLifecycle(msg, sessionId, resolveTool);
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

function normalizeAgentLifecycle(
  msg: UnknownRecord,
  sessionId: string,
  resolveTool?: ResolveTool,
): SdkNormalizedEvent[] {
  if (!["task_started", "task_progress", "task_notification", "task_updated"].includes(String(msg.subtype))) return [];
  const id = nonemptyString(msg.task_id);
  if (!id) return [];
  const toolUseId = nonemptyString(msg.tool_use_id);
  const tool = (toolUseId ? resolveTool?.(toolUseId) : undefined) ?? resolveTool?.(id);
  const agentTypes = ["local_agent", "remote_agent", "agent"];
  // System tasks also describe Bash commands and workflows. Never infer an
  // agent merely from a task_id or from prose mentioning an agent.
  if (typeof msg.task_type === "string" && !agentTypes.includes(msg.task_type)) return [];
  const explicitAgent = agentTypes.includes(String(msg.task_type)) || !!nonemptyString(msg.subagent_type);
  const associatedAgent = tool != null && (isAgentTool(tool.name) || tool.agent != null);
  if ((tool && !associatedAgent) || (!explicitAgent && !associatedAgent)) return [];

  const patch = isRecord(msg.patch) ? msg.patch : {};
  const agent: AgentProgressUpdate = { id };
  const linkedTool = toolUseId ?? tool?.agent?.toolUseId ?? tool?.id;
  if (linkedTool) agent.toolUseId = linkedTool;
  const parent = nonemptyString(msg.parent_tool_use_id) ?? tool?.parentToolUseId ?? tool?.agent?.parentToolUseId;
  if (parent) agent.parentToolUseId = parent;
  const title = nonemptyString(msg.description) ?? nonemptyString(patch.description) ?? tool?.agent?.title ?? tool?.summary;
  if (title) agent.title = title;
  if (msg.subtype === "task_started" || msg.subtype === "task_progress") {
    agent.status = "running";
  } else {
    const status = msg.subtype === "task_updated" ? patch.status : msg.status;
    if (status === "completed" || status === "failed" || status === "stopped" || status === "paused" || status === "running") agent.status = status;
    else if (status === "killed") agent.status = "stopped";
    else if (status === "pending") agent.status = "unknown";
    else if (msg.subtype === "task_notification" || status != null) return [];
  }
  const summary = typeof msg.summary === "string" ? msg.summary : typeof patch.error === "string" ? patch.error : undefined;
  if (summary != null) agent.summary = summary.slice(0, 2000);
  const duration = isRecord(msg.usage) ? num(msg.usage.duration_ms) : undefined;
  if (duration != null && duration >= 0) agent.elapsedSeconds = duration / 1000;
  if (typeof patch.is_backgrounded === "boolean") agent.background = patch.is_backgrounded;
  return [{ type: "agent_progress", sessionId, agent }];
}

function resultAgent(
  tool: ToolCardState,
  parsed: unknown,
  preview: string | undefined,
  isError: boolean,
): ProgressAgent {
  const result = isRecord(parsed) ? parsed : {};
  const launched = result.status === "async_launched" || result.status === "remote_launched" || result.isAsync === true;
  const background = launched ? true : tool.agent?.background;
  const status: ProgressAgent["status"] = isError ? "failed"
    : result.status === "completed" ? "completed"
      : launched || background === true ? "running"
        : background === false ? "completed" : "unknown";
  const duration = num(result.totalDurationMs);
  return {
    ...tool.agent,
    id: nonemptyString(result.agentId) ?? nonemptyString(result.taskId) ?? tool.agent?.id ?? tool.id,
    toolUseId: tool.id,
    title: tool.agent?.title ?? (tool.summary || nonemptyString(result.description) || tool.name),
    status,
    ...(tool.parentToolUseId ? { parentToolUseId: tool.parentToolUseId } : {}),
    ...(background != null ? { background } : {}),
    ...(preview != null ? { summary: preview } : {}),
    ...(duration != null && duration >= 0 ? { elapsedSeconds: duration / 1000 } : {}),
  };
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
      const parentToolUseId = nonemptyString(msg.parent_tool_use_id);
      const task = taskInput(name, input, parentToolUseId);
      const tool: ToolCardState = {
        id,
        name,
        summary: summarizeTool(name, input),
        status: "running",
        ...(isSub ? { isSubagent: true } : {}),
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(name === "TodoWrite" ? { todos: extractTodos(input) } : {}),
        ...(name === "TaskCreate" ? { todos: taskCreateTodo(input) } : {}),
        ...(task ? { task } : {}),
        ...(isAgentTool(name) ? { agent: {
          id: nonemptyString(input.resume) ?? id, toolUseId: id,
          title: summarizeTool(name, input), status: "running" as const,
          ...(parentToolUseId ? { parentToolUseId } : {}),
          ...(typeof input.run_in_background === "boolean" ? { background: input.run_in_background } : {}),
        } } : {}),
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
  resolveTool?: ResolveTool,
): SdkNormalizedEvent[] {
  const message = isRecord(msg.message) ? msg.message : null;
  const content = message ? asArray(message.content) : [];
  const out: SdkNormalizedEvent[] = [];
  const resultCount = content.filter((block) => isRecord(block) && block.type === "tool_result").length;

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
      const before = resolveTool?.(id);
      const named = nonemptyString(block.name);
      const name = named && named !== "tool" ? named : before?.name ?? "tool";
      const parentToolUseId = nonemptyString(msg.parent_tool_use_id) ?? before?.parentToolUseId;
      const isSub = isSubagentMessage(msg) || before?.isSubagent === true;
      const parsed = structuredResult(block.tool_use_result) ??
        (resultCount === 1 ? structuredResult(msg.tool_use_result) : undefined) ?? structuredResult(block.content);
      const input = isRecord(block.input) ? block.input : {};
      const task = taskResult(name, before?.task ?? taskInput(name, input, parentToolUseId), parsed, block.content, isError, parentToolUseId);
      // Keep skill bodies in the collapsed card; don't also emit as chat text.
      // Task/Agent results are the subagent's final report — high value, so widen
      // the preview cap. TodoWrite relies on structured todos, not resultPreview.
      const previewContent = isAgentTool(name) && isRecord(parsed) && parsed.status === "completed" && parsed.content != null
        ? parsed.content : block.content;
      const preview =
        name === "Skill" || name === "skill"
          ? toolPreview(block.content, 4000) ??
            (typeof block.content === "string"
              ? block.content.slice(0, 4000)
              : undefined)
          : name === "Task" || name === "Agent"
            ? toolPreview(previewContent, 2000)
            : toolPreview(block.content);
      const tool: ToolCardState = {
        ...before,
        id,
        name,
        summary:
          name === "Skill" || name === "skill"
            ? skillSummaryFromText(
                typeof block.content === "string"
                  ? block.content
                  : preview ?? "",
              )
            : before?.summary ?? "",
        status: isError ? "error" : "done",
        resultPreview: preview,
        ...(isSub ? { isSubagent: true } : {}),
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(task ? { task } : {}),
        ...(name === "TaskList" && task?.success ? { todos: task.tasks?.map((entry) => ({ content: entry.title, status: entry.status })) } : {}),
        ...(name === "TodoWrite" && task?.success ? { todos: task.tasks?.map((entry) => ({
          content: entry.title, status: entry.status,
          ...(entry.activeForm != null ? { activeForm: entry.activeForm } : {}),
        })) } : {}),
      };
      if (isAgentTool(name)) tool.agent = resultAgent(tool, parsed, preview, isError);
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
