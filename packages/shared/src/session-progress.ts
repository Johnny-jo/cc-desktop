import type {
  AgentProgressUpdate,
  ChatItem,
  ProgressAgent,
  ProgressTask,
  SdkNormalizedEvent,
  SessionProgress,
  ToolCardState,
  ToolTaskUpdate,
} from "./models";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function taskStatus(value: unknown): value is ProgressTask["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function agentStatus(value: unknown): value is ProgressAgent["status"] {
  return value === "running" || value === "paused" || value === "unknown" ||
    value === "completed" || value === "failed" || value === "stopped";
}

export function isTerminalAgent(status: ProgressAgent["status"]): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function sameFields<T extends object>(left: T, right: T): boolean {
  const keys = Object.keys(left) as Array<keyof T>;
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function validTask(value: unknown): ProgressTask | undefined {
  if (!isRecord(value) || !nonempty(value.id) || !nonempty(value.title) || !taskStatus(value.status)) return;
  const task: ProgressTask = { id: value.id, title: value.title, status: value.status };
  for (const key of ["description", "activeForm", "owner", "scope"] as const) {
    if (typeof value[key] === "string") task[key] = value[key];
  }
  return task;
}

function validAgent(value: unknown): ProgressAgent | undefined {
  if (!isRecord(value) || !nonempty(value.id) || !nonempty(value.title) || !agentStatus(value.status)) return;
  const agent: ProgressAgent = { id: value.id, title: value.title, status: value.status };
  for (const key of ["toolUseId", "parentToolUseId", "summary"] as const) {
    if (typeof value[key] === "string") agent[key] = value[key];
  }
  if (typeof value.background === "boolean") agent.background = value.background;
  if (typeof value.elapsedSeconds === "number" && Number.isFinite(value.elapsedSeconds) && value.elapsedSeconds >= 0) {
    agent.elapsedSeconds = value.elapsedSeconds;
  }
  return agent;
}

/** Shared with the transcript reducer so replay cannot revive a terminal agent. */
export function mergeAgentProgress(
  previous: ProgressAgent | undefined,
  update: AgentProgressUpdate,
): ProgressAgent | undefined {
  if (!nonempty(update.id)) return previous;
  const lateHeartbeat = previous && isTerminalAgent(previous.status) && update.status && !isTerminalAgent(update.status);
  // A late start can still teach us the canonical ID; its live state/report
  // must not replace an already observed terminal result.
  const accepted = lateHeartbeat
    ? { id: update.id, toolUseId: update.toolUseId, parentToolUseId: update.parentToolUseId,
      background: previous.background ?? update.background }
    : update;
  const defined = Object.fromEntries(Object.entries(accepted).filter(([, value]) => value !== undefined));
  const candidate = validAgent({ title: update.id, status: "unknown", ...previous, ...defined });
  if (!candidate) return previous;
  // A repeated tool_start still carries its provisional invocation ID.
  if (previous && update.id === (update.toolUseId ?? previous.toolUseId) && previous.id !== previous.toolUseId) candidate.id = previous.id;
  return previous && sameFields(previous, candidate) ? previous : candidate;
}

export function mergeTaskUpdate(
  previous: ToolTaskUpdate | undefined,
  update: ToolTaskUpdate | undefined,
): ToolTaskUpdate | undefined {
  if (!update) return previous;
  if (!previous || previous.operation !== update.operation) return update;
  return {
    ...previous,
    ...update,
    taskId: update.taskId ?? previous.taskId,
    tasks: update.tasks ?? previous.tasks,
    patch: update.patch
      ? { ...previous.patch, ...Object.fromEntries(Object.entries(update.patch).filter(([, value]) => value !== undefined)) }
      : previous.patch,
    success: update.success ?? previous.success,
  };
}

/** Application identity excludes the reducer's local ordering metadata. */
export function sameTaskApplication(left: ToolTaskUpdate, right: ToolTaskUpdate): boolean {
  const equalFields = (a: object = {}, b: object = {}) => {
    const first = a as Record<string, unknown>;
    const second = b as Record<string, unknown>;
    return [...new Set([...Object.keys(first), ...Object.keys(second)])].every((key) => first[key] === second[key]);
  };
  return left.operation === right.operation && left.taskId === right.taskId &&
    left.success === right.success && equalFields(left.patch, right.patch) &&
    (left.tasks === right.tasks || (left.tasks != null && right.tasks != null &&
      left.tasks.length === right.tasks.length && left.tasks.every((task, index) => equalFields(task, right.tasks![index]))));
}

/** Reconcile every ID/tool-call alias, including links learned by earlier records. */
export function mergeLinkedAgentProgress(agents: ProgressAgent[], update: AgentProgressUpdate): {
  agent: ProgressAgent | undefined;
  indices: number[];
} {
  const byId = new Map<string, number[]>();
  for (const [index, agent] of agents.entries()) {
    for (const id of [agent.id, agent.toolUseId]) {
      if (!id) continue;
      const entries = byId.get(id) ?? [];
      entries.push(index);
      byId.set(id, entries);
    }
  }
  const queue = [update.id, ...(update.toolUseId ? [update.toolUseId] : [])];
  const seen = new Set<string>();
  const matched = new Set<number>();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    if (seen.has(id)) continue;
    seen.add(id);
    for (const index of byId.get(id) ?? []) {
      if (matched.has(index)) continue;
      matched.add(index);
      queue.push(agents[index].id);
      if (agents[index].toolUseId) queue.push(agents[index].toolUseId!);
    }
  }
  const indices = [...matched].sort((left, right) => left - right);
  let agent: ProgressAgent | undefined;
  for (const index of indices) agent = mergeAgentProgress(agent, agents[index]);
  agent = mergeAgentProgress(agent, update);
  const first = agents[indices[0]];
  if (agent && first && sameFields(agent, first)) agent = first;
  return { agent, indices };
}

function updateAgents(agents: ProgressAgent[], update: AgentProgressUpdate): ProgressAgent[] {
  const { agent, indices } = mergeLinkedAgentProgress(agents, update);
  if (!agent || (indices.length === 1 && agent === agents[indices[0]])) return agents;
  const next = agents.slice();
  if (!indices.length) next.push(agent);
  else {
    next[indices[0]] = agent;
    for (let index = indices.length - 1; index > 0; index--) next.splice(indices[index], 1);
  }
  return next;
}

function withAgent(previous: SessionProgress | undefined, update: AgentProgressUpdate): SessionProgress | undefined {
  const agents = previous?.agents ?? [];
  const next = updateAgents(agents, update);
  return next === agents ? previous : { tasks: previous?.tasks ?? [], agents: next };
}

function withTasks(
  previous: SessionProgress | undefined,
  update: ToolTaskUpdate,
  parentToolUseId?: string,
): SessionProgress | undefined {
  if (update.success === false) return previous;
  const scope = update.patch?.scope ?? parentToolUseId;
  const tasks = previous?.tasks ?? [];
  let next: ProgressTask[];

  if (update.operation === "list" || update.operation === "replace") {
    if (!update.tasks) return previous;
    const replacements = new Map<string, ProgressTask>();
    for (const value of update.tasks) {
      const task = validTask({ ...value, ...(value.scope == null && scope != null ? { scope } : {}) });
      // A malformed snapshot must not clear known tasks.
      if (!task) return previous;
      replacements.set(taskKey(task), task);
    }
    const scopes = new Set([...replacements.values()].map((task) => task.scope));
    if (!replacements.size || scope != null) scopes.add(scope);
    next = [];
    // Preserve stable row order and references when a scope is listed again.
    for (const current of tasks) {
      if (!scopes.has(current.scope)) {
        next.push(current);
        continue;
      }
      const key = taskKey(current);
      const replacement = replacements.get(key);
      if (replacement) next.push(sameFields(current, replacement) ? current : replacement);
      replacements.delete(key);
    }
    next.push(...replacements.values());
  } else {
    const id = update.taskId ?? update.patch?.id;
    if (!nonempty(id)) return previous;
    const index = tasks.findIndex((task) => task.id === id && task.scope === scope);
    if (update.patch?.deleted) {
      if (index < 0) return previous;
      next = tasks.slice();
      next.splice(index, 1);
    } else {
      if (index < 0 && update.operation !== "create") return previous;
      const task = validTask({
        status: "pending", ...(index < 0 ? {} : tasks[index]), ...update.patch,
        id, ...(scope != null ? { scope } : {}),
      });
      if (!task) return previous;
      if (index >= 0 && sameFields(tasks[index], task)) return previous;
      next = tasks.slice();
      if (index < 0) next.push(task);
      else next[index] = task;
    }
  }
  if (next.length === tasks.length && next.every((task, index) => sameFields(task, tasks[index]))) return previous;
  return { tasks: next, agents: previous?.agents ?? [] };
}

function taskKey(task: ProgressTask): string {
  return JSON.stringify([task.scope ?? null, task.id]);
}

/** Apply structured events only; text/usage and ordinary tools return immediately. */
export function updateSessionProgress(
  previous: SessionProgress | undefined,
  event: SdkNormalizedEvent,
  toolBeforeEvent?: ToolCardState,
): SessionProgress | undefined {
  switch (event.type) {
    case "agent_progress":
      return withAgent(previous, event.agent);
    case "tool_progress": {
      const agent = toolBeforeEvent?.agent ?? previous?.agents.find((entry) => entry.toolUseId === event.toolUseId || entry.id === event.toolUseId);
      if (!agent || isTerminalAgent(agent.status)) return previous;
      return withAgent(previous, { id: agent.id, toolUseId: event.toolUseId, elapsedSeconds: event.elapsedSeconds });
    }
    case "tool_start":
    case "tool_end": {
      const tool = event.tool;
      let next = previous;
      const agent = tool.agent ?? toolBeforeEvent?.agent;
      if (agent) next = withAgent(next, agent);
      if (event.type !== "tool_end" || tool.status !== "done") return next;
      let task = mergeTaskUpdate(toolBeforeEvent?.task, tool.task);
      if (previous && task && toolBeforeEvent?.id === tool.id && toolBeforeEvent.status === "done" &&
          toolBeforeEvent.task && sameTaskApplication(toolBeforeEvent.task, task)) return next;
      const parent = tool.parentToolUseId ?? toolBeforeEvent?.parentToolUseId;
      const name = tool.name === "tool" ? toolBeforeEvent?.name : tool.name;
      const todos = tool.todos ?? toolBeforeEvent?.todos;
      // Old archives predate structured task updates but retained TodoWrite input.
      if (!task && name === "TodoWrite" && todos) {
        const scope = parent ? "todos:" + parent : "todos";
        task = {
          operation: "replace", success: true, patch: { scope },
          tasks: todos.map((todo, index) => ({ id: "todo-" + (index + 1), title: todo.content, status: todo.status, scope, ...(todo.activeForm != null ? { activeForm: todo.activeForm } : {}) })),
        };
      }
      return task ? withTasks(next, task, parent) : next;
    }
    default:
      return previous;
  }
}

/** Replay the complete retained transcript, never a paginated UI window. */
export function rebuildSessionProgress(items: ChatItem[], baseline?: SessionProgress): SessionProgress | undefined {
  let progress = baseline;
  // Legacy records have no sequence and precede newly recorded applications.
  // Sort a separate replay list; transcript positions remain untouched.
  const replay = items.filter((item) => item.kind === "tool");
  const order = (item: (typeof replay)[number]) => {
    const value = item.tool.task?.appliedOrder;
    return value != null && Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  replay.sort((left, right) => order(left) - order(right));
  for (const item of replay) {
    progress = updateSessionProgress(progress, {
      type: item.tool.status === "running" ? "tool_start" : "tool_end",
      sessionId: "", tool: item.tool,
    });
  }
  return progress;
}

/** Restoring a snapshot does not prove that a formerly live agent is still alive. */
export function restoreSessionProgress(value: unknown): SessionProgress | undefined {
  if (!isRecord(value) || !Array.isArray(value.tasks) || !Array.isArray(value.agents)) return;
  const tasks: ProgressTask[] = [];
  let agents: ProgressAgent[] = [];
  for (const raw of value.tasks) {
    const task = validTask(raw);
    if (!task) continue;
    const index = tasks.findIndex((entry) => entry.id === task.id && entry.scope === task.scope);
    if (index < 0) tasks.push(task);
    else tasks[index] = task;
  }
  for (const raw of value.agents) {
    const agent = validAgent(raw);
    if (!agent) continue;
    agents = updateAgents(agents, agent);
  }
  agents = agents.map((agent) => agent.status === "running" || agent.status === "paused"
    ? { ...agent, status: "unknown" } : agent);
  return { tasks, agents };
}
