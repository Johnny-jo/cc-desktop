import type {
  Attachment,
  ChatItem,
  SdkNormalizedEvent,
  ToolCardState,
} from "./models";

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
    event.type === "result" ||
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
        items[items.length - 1] = {
          ...last,
          thinkingText: (last.thinkingText ?? "") + event.text,
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
      const existing = items.findIndex(
        (i) => i.kind === "tool" && i.tool.id === tool.id,
      );
      if (existing >= 0) {
        const cur = items[existing];
        if (cur.kind === "tool") {
          items[existing] = { kind: "tool", id: cur.id, tool: { ...tool } };
        }
      } else {
        items.push({
          kind: "tool",
          id: tool.id || opts.nextId("tool"),
          tool: { ...tool },
        });
      }
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
          const merged: ToolCardState = {
            ...cur.tool,
            ...tool,
            name: tool.name && tool.name !== "tool" ? tool.name : cur.tool.name,
            summary: tool.summary || cur.tool.summary,
            todos: tool.todos ?? cur.tool.todos,
            isSubagent: tool.isSubagent ?? cur.tool.isSubagent,
          };
          items[existing] = { kind: "tool", id: cur.id, tool: merged };
        }
      } else {
        items.push({
          kind: "tool",
          id: tool.id || opts.nextId("tool"),
          tool: { ...tool },
        });
      }
      return { ...state, items };
    }
    case "tool_progress": {
      const existing = items.findIndex(
        (i) => i.kind === "tool" && i.tool.id === event.toolUseId,
      );
      if (existing >= 0) {
        const cur = items[existing];
        if (cur.kind === "tool") {
          items[existing] = {
            kind: "tool",
            id: cur.id,
            tool: {
              ...cur.tool,
              status: "running",
              elapsedSeconds: event.elapsedSeconds,
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
    case "result": {
      // Tools can push after a streaming assistant, so the bubble is no
      // longer last — still settle every in-flight assistant so markdown
      // mounts and "思考中…" does not stick after the turn ends.
      const settled: typeof items = [];
      for (const item of items) {
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
    case "items_replaced":
      return { ...state, items: event.items };
    case "user_msg_ids":
    case "raw":
    default:
      return state;
  }
}
