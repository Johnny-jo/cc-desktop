import type {
  Attachment,
  AgentProgressUpdate,
  ChatItem,
  ProgressAgent,
  SdkNormalizedEvent,
  ToolCardState,
} from "./models";
import { isTerminalAgent, mergeAgentProgress, mergeLinkedAgentProgress, mergeTaskUpdate, sameTaskApplication } from "./session-progress";

export type TranscriptState = {
  items: ChatItem[];
  optimisticUserTexts: string[];
};

export type ApplySdkEventOptions = {
  nextId: (prefix: string) => string;
};

export function emptyTranscript(): TranscriptState {
  return { items: [], optimisticUserTexts: [] };
}

export function createIdFactory(now: () => number = Date.now): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => {
    counter += 1;
    return `${prefix}-${now()}-${counter}`;
  };
}

export function bindSdkUserMsgIds(items: ChatItem[], uuids: string[]): ChatItem[] {
  if (!uuids.length) return items;
  const userIdxs: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "text" && item.role === "user") userIdxs.push(i);
  }
  if (!userIdxs.length) return items;
  const offset = Math.max(0, uuids.length - userIdxs.length);
  let changed = false;
  const next = items.slice();
  for (let k = 0; k < userIdxs.length; k++) {
    const uuid = uuids[offset + k];
    const idx = userIdxs[k];
    const item = next[idx];
    if (uuid && item.kind === "text" && item.sdkMsgId !== uuid) {
      changed = true;
      next[idx] = { ...item, sdkMsgId: uuid };
    }
  }
  return changed ? next : items;
}

function consumeOptimistic(state: TranscriptState, text: string): TranscriptState | null {
  const q = state.optimisticUserTexts;
  const idx = q.indexOf(text);
  if (idx < 0) return null;
  const next = q.slice();
  next.splice(idx, 1);
  return { ...state, optimisticUserTexts: next };
}

export function appendUserItem(
  state: TranscriptState,
  text: string,
  opts: ApplySdkEventOptions & {
    optimistic?: boolean;
    attachments?: Attachment[];
  },
): TranscriptState {
  const last = state.items[state.items.length - 1];
  if (last?.kind === "text" && last.role === "user" && last.text === text) {
    if (!opts.optimistic) return state;
    return {
      ...state,
      optimisticUserTexts: [...state.optimisticUserTexts, text],
    };
  }
  const items: ChatItem[] = [
    ...state.items,
    {
      kind: "text",
      id: opts.nextId("user"),
      role: "user",
      text,
      ...(opts.attachments?.length
        ? { attachments: opts.attachments }
        : {}),
    },
  ];
  return {
    items,
    optimisticUserTexts: opts.optimistic
      ? [...state.optimisticUserTexts, text]
      : state.optimisticUserTexts,
  };
}

/** True when this event should be flushed to disk (not text_delta / tool_progress). */
export function shouldPersistTranscript(event: SdkNormalizedEvent): boolean {
  return (
    event.type === "user_message" ||
    event.type === "text_done" ||
    event.type === "tool_start" ||
    event.type === "tool_end" ||
    event.type === "agent_progress" ||
    event.type === "result" ||
    event.type === "turn_changes" ||
    event.type === "items_replaced"
  );
}

export function applySdkEvent(
  state: TranscriptState,
  event: SdkNormalizedEvent,
  opts: ApplySdkEventOptions,
): TranscriptState {
  const items = state.items.slice();

  switch (event.type) {
    case "user_message": {
      const afterOpt = consumeOptimistic(state, event.text);
      if (afterOpt) return afterOpt;
      if (
        event.text.startsWith(
          "This session is being continued from a previous conversation",
        ) ||
        event.text.startsWith("Earlier conversation summary:")
      ) {
        return state;
      }
      if (
        items.some(
          (i) => i.kind === "text" && i.role === "user" && i.text === event.text,
        )
      ) {
        return state;
      }
      return appendUserItem(state, event.text, opts);
    }
    case "thinking_delta": {
      const last = items[items.length - 1];
      if (last?.kind === "text" && last.role === "assistant" && last.streaming) {
        // Answer text already started (or thinking ended): ignore late deltas.
        if (!last.thinking) return state;
        if (!event.text) return state;
        const previous = last.thinkingText ?? "";
        items[items.length - 1] = {
          ...last,
          // Final assistant frames may repeat the complete reasoning after
          // partial deltas. Replace when the new payload already contains the
          // accumulated prefix; otherwise treat it as a true delta.
          thinkingText: event.text.startsWith(previous)
            ? event.text
            : previous + event.text,
        };
        return { ...state, items };
      }
      items.push({
        kind: "text",
        id: opts.nextId("asst"),
        role: "assistant",
        text: "",
        streaming: true,
        thinking: true,
        ...(event.text ? { thinkingText: event.text } : {}),
      });
      return { ...state, items };
    }
    case "text_delta": {
      const last = items[items.length - 1];
      if (last?.kind === "text" && last.role === "assistant" && last.streaming) {
        items[items.length - 1] = last.thinking
          ? { ...last, thinking: undefined, text: event.text }
          : { ...last, text: last.text + event.text };
      } else {
        items.push({
          kind: "text",
          id: opts.nextId("asst"),
          role: "assistant",
          text: event.text,
          streaming: true,
        });
      }
      return { ...state, items };
    }
    case "text_done": {
      const last = items[items.length - 1];
      if (last?.kind === "text" && last.role === "assistant" && last.streaming) {
        const text =
          last.text.length >= event.text.length ? last.text : event.text;
        items[items.length - 1] = { ...last, text, streaming: false };
      } else if (
        last?.kind === "text" &&
        last.role === "assistant" &&
        !last.streaming &&
        last.text === event.text
      ) {
        return state;
      } else {
        items.push({
          kind: "text",
          id: opts.nextId("asst"),
          role: "assistant",
          text: event.text,
          streaming: false,
        });
      }
      return { ...state, items };
    }
    case "tool_start": {
      const tool = event.tool;
      const last = items[items.length - 1];
      if (
        last?.kind === "text" &&
        last.role === "assistant" &&
        last.streaming &&
        last.thinking
      ) {
        // Starting a tool is also a reasoning boundary: fold the preceding
        // thought immediately instead of leaving "思考中…" open until result.
        if (!last.text && !last.thinkingText) {
          items.pop();
        } else {
          items[items.length - 1] = {
            ...last,
            streaming: false,
            thinking: undefined,
          };
        }
      }
      const existing = items.findIndex(
        (i) => i.kind === "tool" && (i.tool.id === tool.id ||
          (tool.agent != null && i.tool.agent?.id === tool.agent.id)),
      );
      if (existing >= 0) {
        const cur = items[existing];
        if (cur.kind === "tool") {
          items[existing] = { kind: "tool", id: cur.id, tool: mergeToolCard(cur.tool, tool, true) };
        }
      } else {
        items.push({
          kind: "tool",
          id: tool.id || opts.nextId("tool"),
          tool: { ...tool },
        });
      }
      if (tool.agent) reconcileToolAgents(items, tool.agent);
      return { ...state, items };
    }
    case "tool_end": {
      const tool = event.tool;
      const existing = items.findIndex(
        (i) => i.kind === "tool" && i.tool.id === tool.id,
      );
      if (existing >= 0) {
        const cur = items[existing];
        if (cur.kind === "tool") {
          const merged = stampTaskApplication(items, mergeToolCard(cur.tool, tool), cur.tool);
          items[existing] = { kind: "tool", id: cur.id, tool: merged };
        }
      } else {
        items.push({
          kind: "tool",
          id: tool.id || opts.nextId("tool"),
          tool: stampTaskApplication(items, { ...tool }),
        });
      }
      if (tool.agent) reconcileToolAgents(items, tool.agent);
      return { ...state, items };
    }
    case "tool_progress": {
      const existing = items.findIndex(
        (i) => i.kind === "tool" && i.tool.id === event.toolUseId,
      );
      if (existing >= 0) {
        const cur = items[existing];
        if (cur.kind === "tool") {
          if (cur.tool.agent ? isTerminalAgent(cur.tool.agent.status) : cur.tool.status !== "running") return state;
          items[existing] = {
            kind: "tool",
            id: cur.id,
            tool: {
              ...cur.tool,
              elapsedSeconds: event.elapsedSeconds,
              ...(cur.tool.agent ? { agent: mergeAgentProgress(cur.tool.agent, { id: cur.tool.agent.id, elapsedSeconds: event.elapsedSeconds }) } : {}),
              name:
                event.toolName && event.toolName !== "tool"
                  ? event.toolName
                  : cur.tool.name,
            },
          };
          return { ...state, items };
        }
      }
      return state;
    }
    case "agent_progress": {
      const update = event.agent;
      const reconciled = reconcileToolAgents(items, update, true);
      if (reconciled.matched) return reconciled.changed ? { ...state, items } : state;
      const agent = mergeAgentProgress(undefined, update);
      if (!agent) return state;
      const id = agent.toolUseId ?? "agent:" + agent.id;
      const tool: ToolCardState = {
        id, name: "Agent", summary: agent.title,
        status: agent.status === "failed" ? "error" : isTerminalAgent(agent.status) ? "done" : "running",
        agent,
        ...(agent.parentToolUseId != null ? { parentToolUseId: agent.parentToolUseId, isSubagent: true } : {}),
        ...(agent.elapsedSeconds != null ? { elapsedSeconds: agent.elapsedSeconds } : {}),
        ...(isTerminalAgent(agent.status) && agent.summary != null ? { resultPreview: agent.summary } : {}),
      };
      items.push({ kind: "tool", id, tool });
      return { ...state, items };
    }
    case "result": {
      let userIndex = -1;
      for (let index = items.length - 1; index >= 0; index--) {
        const candidate = items[index];
        if (candidate.kind === "text" && candidate.role === "user") { userIndex = index; break; }
      }
      const user = items[userIndex];
      const activeItems = items.slice(userIndex + 1);
      const interrupted = event.outcome === "interrupted" || event.outcome === "cancelled";
      const hadActivity = activeItems.some(item => item.kind === "tool" ||
        (item.kind === "text" && item.role === "assistant" && Boolean(item.text.trim() || item.thinkingText?.trim())));
      const outcome = interrupted ? (hadActivity ? "interrupted" : "cancelled") : event.outcome ?? (event.ok ? "completed" : "failed");
      // Late success/duplicate stop notifications cannot rewrite a terminal turn.
      if (user?.kind === "text" && (user.turnOutcome === "interrupted" || user.turnOutcome === "cancelled")) return state;
      if (user?.kind === "text") items[userIndex] = { ...user, turnOutcome: outcome };
      // Tools can push after a streaming assistant, so the bubble is no
      // longer last — still settle every in-flight assistant so markdown
      // mounts and "思考中…" does not stick after the turn ends.
      const settled: typeof items = [];
      for (const [index, item] of items.entries()) {
        if (index > userIndex && interrupted && item.kind === "tool" && item.tool.status === "running" && !item.tool.agent) {
          settled.push({ ...item, tool: { ...item.tool, status: "stopped" } });
          continue;
        }
        if (
          item.kind === "text" &&
          item.role === "assistant" &&
          item.streaming
        ) {
          if (item.thinking && !item.text && !item.thinkingText) continue;
          settled.push({ ...item, streaming: false, thinking: undefined });
        } else {
          settled.push(item);
        }
      }
      items.length = 0;
      items.push(...settled);
      if (!event.ok && event.error) {
        items.push({
          kind: "text",
          id: opts.nextId("sys"),
          role: "system",
          text: event.error,
        });
      }
      if (event.usage) {
        items.push({
          kind: "usage",
          id: opts.nextId("usage"),
          usage: event.usage,
        });
      }
      return { ...state, items };
    }
    case "turn_changes": {
      if (items.some((item) => item.id === event.item.id)) return state;
      items.push(event.item);
      return { ...state, items };
    }
    case "items_replaced":
      return { ...state, items: event.items };
    case "user_msg_ids":
    case "raw":
    default:
      return state;
  }
}

function mergeToolCard(previous: ToolCardState, update: ToolCardState, isStart = false): ToolCardState {
  const agent = update.agent ? mergeAgentProgress(previous.agent, update.agent) : previous.agent;
  const lateLaunch = previous.agent && isTerminalAgent(previous.agent.status) && update.agent && !isTerminalAgent(update.agent.status);
  return {
    ...previous, ...update,
    name: update.name && update.name !== "tool" ? update.name : previous.name,
    summary: update.summary || previous.summary,
    status: agent && isTerminalAgent(agent.status)
      ? agent.status === "failed" ? "error" : "done"
      : isStart && previous.status !== "running" ? previous.status : update.status,
    todos: update.todos ?? previous.todos,
    isSubagent: update.isSubagent ?? previous.isSubagent,
    parentToolUseId: update.parentToolUseId ?? previous.parentToolUseId,
    task: mergeTaskUpdate(previous.task, update.task),
    agent,
    resultPreview: lateLaunch ? previous.resultPreview : update.resultPreview ?? previous.resultPreview,
    elapsedSeconds: update.elapsedSeconds ?? previous.elapsedSeconds,
  };
}

function reconcileToolAgents(items: ChatItem[], update: AgentProgressUpdate, lifecycle = false): { matched: boolean; changed: boolean } {
  const candidates: Array<{ index: number; item: Extract<ChatItem, { kind: "tool" }> }> = [];
  const agents: ProgressAgent[] = [];
  for (const [index, item] of items.entries()) {
    if (item.kind !== "tool" || (!item.tool.agent && item.tool.id !== update.toolUseId)) continue;
    candidates.push({ index, item });
    agents.push(item.tool.agent ?? {
      id: update.id, toolUseId: item.tool.id, title: item.tool.summary || item.tool.name, status: "unknown",
    });
  }
  const { agent, indices } = mergeLinkedAgentProgress(agents, update);
  if (!agent || !indices.length) return { matched: false, changed: false };
  const linked = indices.map((index) => candidates[index]);
  const isPlaceholder = (item: Extract<ChatItem, { kind: "tool" }>) => item.tool.id === "agent:" + item.tool.agent?.id;
  const hasInvocation = linked.some(({ item }) => !isPlaceholder(item));
  let changed = false;
  for (let cursor = linked.length - 1; cursor >= 0; cursor--) {
    const { index, item } = linked[cursor];
    // Only synthetic lifecycle placeholders disappear. Real invocation and
    // message positions are retained, including multiple calls to one agent.
    if (isPlaceholder(item) && (hasInvocation || cursor > 0)) {
      items.splice(index, 1);
      changed = true;
      continue;
    }
    const before = item.tool;
    const tool: ToolCardState = {
      ...before, agent,
      status: isTerminalAgent(agent.status) ? agent.status === "failed" ? "error" : "done"
        : lifecycle ? "running" : before.status,
      ...(agent.parentToolUseId != null ? { parentToolUseId: agent.parentToolUseId, isSubagent: true } : {}),
      ...(agent.elapsedSeconds != null ? { elapsedSeconds: agent.elapsedSeconds } : {}),
      ...(isTerminalAgent(agent.status) && agent.summary != null ? { resultPreview: agent.summary } : {}),
    };
    if (Object.keys(tool).some((key) => tool[key as keyof ToolCardState] !== before[key as keyof ToolCardState])) {
      items[index] = { ...item, tool };
      changed = true;
    }
  }
  return { matched: true, changed };
}

function stampTaskApplication(items: ChatItem[], tool: ToolCardState, previous?: ToolCardState): ToolCardState {
  const task = tool.task;
  if (tool.status !== "done" || !task || task.success === false) return tool;
  if (previous?.status === "done" && previous.task &&
      Number.isSafeInteger(previous.task.appliedOrder) && previous.task.appliedOrder! > 0 &&
      sameTaskApplication(previous.task, task)) {
    return { ...tool, task: { ...task, appliedOrder: previous.task.appliedOrder } };
  }
  let latest = 0;
  for (const item of items) {
    const order = item.kind === "tool" ? item.tool.task?.appliedOrder : undefined;
    if (order != null && Number.isSafeInteger(order) && order > latest) latest = order;
  }
  return { ...tool, task: { ...task, appliedOrder: latest + 1 } };
}
