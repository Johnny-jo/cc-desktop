import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCardState } from "@claude-desktop/shared";
import type { ActivityEntry } from "../lib/conversation-blocks";
import { ChatActivity } from "./ChatActivity";
import { requestRevealChange } from "../state/store";

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
type HookRun = {
  slots: unknown[]; cursor: number; dirty: boolean;
  effects: Map<number, Effect>; pending: Array<() => void>;
};
// The project's test environment is Node. Adapt hooks only for explicit handler
// tests, retaining real React hooks for all static renders and child components.
const harness = vi.hoisted(() => ({ current: null as HookRun | null }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  function effect(setup: () => void | (() => void), deps?: readonly unknown[]) {
    const run = harness.current!;
    const index = run.cursor++;
    const previous = run.effects.get(index);
    if (previous?.deps && deps && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps![i]))) return;
    run.pending.push(() => {
      previous?.cleanup?.();
      run.effects.set(index, { deps, cleanup: setup() || undefined });
    });
  }
  return {
    ...actual,
    useState: (initial: unknown) => {
      const run = harness.current;
      if (!run) return actual.useState(initial);
      const index = run.cursor++;
      if (!(index in run.slots)) run.slots[index] = typeof initial === "function" ? initial() : initial;
      return [run.slots[index], (value: unknown) => {
        const next = typeof value === "function" ? value(run.slots[index]) : value;
        if (!Object.is(next, run.slots[index])) { run.slots[index] = next; run.dirty = true; }
      }];
    },
    useRef: (initial: unknown) => {
      const run = harness.current;
      if (!run) return actual.useRef(initial);
      const index = run.cursor++;
      if (!(index in run.slots)) run.slots[index] = { current: initial };
      return run.slots[index];
    },
    useEffect: (setup: () => void | (() => void), deps?: readonly unknown[]) => harness.current ? effect(setup, deps) : actual.useEffect(setup, deps),
    useLayoutEffect: (setup: () => void | (() => void), deps?: readonly unknown[]) => harness.current ? effect(setup, deps) : actual.useLayoutEffect(setup, deps),
  };
});

// Keep the real component and dictionaries; isolate its existing store boundary.
vi.mock("../state/store", () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({
    activeSessionId: "session-one", settings: { locale: "zh" },
  }),
  requestRevealChange: vi.fn(),
}));

type AgentStatus = NonNullable<ToolCardState["agent"]>["status"];

function tool(
  id: string,
  name = "Read",
  status: ToolCardState["status"] = "done",
  agentStatus?: AgentStatus,
): ActivityEntry {
  return {
    kind: "tool", id,
    tool: {
      id, name, status, summary: `${id}.tsx`,
      ...(agentStatus ? {
        agent: { id: `agent-${id}`, title: id, status: agentStatus, background: true },
      } : {}),
    },
  };
}

function render(entries: ActivityEntry[], live = false, durationMs?: number) {
  return renderToStaticMarkup(React.createElement(ChatActivity, {
    id: live ? "live-activity-first" : "activity-first", entries, live, durationMs,
  }));
}

type Element = React.ReactElement<Record<string, unknown>>;
function nodes(tree: React.ReactNode): Element[] {
  return React.Children.toArray(tree).flatMap(child => React.isValidElement<Record<string, unknown>>(child)
    ? [child, ...nodes(child.props.children as React.ReactNode)] : []);
}

const cleanups: Array<() => void> = [];
function mount<Props extends object>(Component: (props: Props) => React.ReactNode, initial: Props) {
  const run: HookRun = { slots: [], cursor: 0, dirty: false, effects: new Map(), pending: [] };
  let props = initial;
  let tree: React.ReactNode;
  function update(next = props) {
    props = next;
    let attempts = 0;
    do {
      run.cursor = 0; run.dirty = false; run.pending = []; harness.current = run;
      try { tree = Component(props); } finally { harness.current = null; }
      for (const node of nodes(tree)) {
        if (node.props.className === "activity-thinking-text" && node.props.ref) {
          (node.props.ref as React.RefObject<unknown>).current = {
            scrollWidth: String(node.props.children).length * 8, clientWidth: 120,
          };
        }
      }
      for (const flush of run.pending) flush();
      if (++attempts > 10) throw new Error("Activity render did not settle");
    } while (run.dirty);
    return tree;
  }
  cleanups.push(() => { for (const effect of run.effects.values()) effect.cleanup?.(); });
  update();
  return {
    update,
    html: () => renderToStaticMarkup(update()),
    nodes: () => nodes(update()),
    click: (className: string) => {
      const button = nodes(update()).find(node => node.type === "button" && String(node.props.className).split(" ").includes(className));
      expect(button, `button ${className}`).toBeDefined();
      expect(button!.props.disabled).not.toBe(true);
      (button!.props.onClick as () => void)();
      update();
    },
  };
}

function mountEntry(entry: ActivityEntry) {
  const group = mount(ChatActivity, { id: "activity-first", entries: [entry], live: false });
  group.click("activity-group-toggle");
  const child = group.nodes().find(node => node.props.entry === entry)!;
  expect(child).toBeDefined();
  return mount(child.type as (props: Record<string, unknown>) => React.ReactNode, child.props);
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllMocks();
});

describe("ChatActivity", () => {
  it("starts archived activity collapsed and preserves the caller's stable anchor", () => {
    const html = render([tool("second")], false, 4200);

    expect(html).toContain('data-item-id="activity-first"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="activity-first-body"');
    expect(html).toContain("调用 1 个工具");
    expect(html).toContain("用时 4.2s");
    expect(html).not.toContain('class="activity-group-body"');
    expect(html).not.toContain("second.tsx");
  });

  it("keeps failed and compacted history collapsed with a visible failure count", () => {
    const html = render([
      tool("failed-tool", "Bash", "error"),
      tool("failed-agent", "Agent", "done", "failed"),
      { kind: "compaction", id: "compact" },
    ]);

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("有 2 项失败");
    expect(html).toContain("status-error");
    expect(html).not.toContain('class="activity-group-body"');
  });

  it("renders every live entry as in progress without a collapse toggle", () => {
    const html = render([
      tool("first", "Read", "running"),
      { kind: "thinking", id: "thought", text: "Inspecting the implementation", active: true },
      tool("second", "Bash", "running"),
      tool("background", "Agent", "done", "running"),
    ], true);

    expect(html).toContain("first.tsx");
    expect(html).toContain("second.tsx");
    expect(html).toContain("background.tsx");
    expect(html).toContain("Inspecting the implementation");
    expect(html.match(/class="activity-spinner"/g)).toHaveLength(4);
    expect(html.match(/class="activity-step-status"/g)).toHaveLength(4);
    expect(html.match(/>进行中</g)).toHaveLength(5);
    expect(html).not.toContain("activity-step-done");
    expect(html).not.toContain("activity-group-toggle");
  });

  it("uses structured agent progress instead of a failed startup tool status", () => {
    const html = render([tool("agent", "Agent", "error", "running")], true);

    expect(html).toContain("activity-spinner");
    expect(html).not.toContain("activity-step-error");
    expect(html).not.toContain("status-error");
  });

  it.each([
    ["unknown", "状态未知"], ["stopped", "已停止"], ["paused", "已暂停"],
  ] as const)("does not animate or label %s agents as complete", (status, label) => {
    const entry = tool("agent", "Agent", "running", status);
    const html = render([entry]);

    expect(html).toContain(label);
    expect(html).not.toContain("activity-spinner");
    expect(html).not.toContain(">完成<");
    expect(render([entry], true)).toBe("");
  });

  it("renders no button for an empty archive or empty live list", () => {
    expect(render([])).toBe("");
    expect(render([], true)).toBe("");
  });

  it("keeps live work out of the archive and finished work out of the live list", () => {
    const entries = [tool("running", "Read", "running"), tool("finished")];
    const live = render(entries, true);
    const archive = render(entries);

    expect(live).toContain("running.tsx");
    expect(live).not.toContain("finished.tsx");
    expect(archive).toContain("调用 1 个工具");
    expect(archive).not.toContain("activity-spinner");
    expect(render([entries[0]!])).toBe("");
  });

  it("keeps legacy duration formatting", () => {
    expect(render([tool("one")], false, 500)).toContain("用时 500ms");
    expect(render([tool("one")], false, 62000)).toContain("用时 1m 2s");
    expect(render([tool("one")], false, Number.NaN)).not.toContain("用时");
  });
});

describe("ChatActivity tool icons", () => {
  function icon(name: string) {
    const html = render([tool("icon", name, "running")], true);
    const svg = html.match(/<svg class="activity-step-icon"[\s\S]*?<\/svg>/)?.[0];
    expect(svg, `icon for ${name}`).toBeDefined();
    return svg;
  }

  it.each(["TodoWrite", "TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "update_plan", "Agent", "Task"])(
    "gives %s the same icon with an MCP prefix", name => {
      expect(icon(`mcp__claude__${name}`)).toBe(icon(name));
      expect(icon(`claude:${name}`)).toBe(icon(name));
    },
  );

  it("distinguishes task lists, task updates and agents from file edits", () => {
    const list = icon("TaskList");
    const update = icon("TaskUpdate");
    const agent = icon("Agent");
    const edit = icon("Edit");

    expect(icon("TodoWrite")).toBe(list);
    expect(icon("Task")).toBe(agent);
    expect(icon("update_plan")).toBe(update);
    expect(new Set([list, update, agent, edit]).size).toBe(4);
  });

  it.each(["Agent", "Task"])("renders %s as three connected branch nodes", name => {
    const svg = icon(name);

    expect(svg?.match(/<circle\b/g)).toHaveLength(3);
    expect(svg).toContain('d="M4 4.5v7M4 8.5h4a4 4 0 0 0 4-4"');
    expect(svg).not.toContain("<rect");
  });

  it.each(["Read", "Write", "Edit", "Bash", "Grep", "WebSearch", "AskUserQuestion", "Skill"])(
    "preserves the existing %s icon", name => { icon(name); },
  );
});

describe("ChatActivity interaction", () => {
  it("does not reopen collapsed history as new tools start and finish", () => {
    const props = { id: "activity-first", entries: [tool("finished")] };
    const view = mount(ChatActivity, props);
    view.update({ ...props, entries: [...props.entries, tool("next", "Bash", "running")] });
    expect(view.html()).toContain('aria-expanded="false"');
    view.update({ ...props, entries: [...props.entries, tool("next", "Bash", "done")] });
    expect(view.html()).toContain('aria-expanded="false"');
  });

  it("preserves a user's expanded history through live completion and failure", () => {
    const props = { id: "activity-first", entries: [tool("finished")] };
    const view = mount(ChatActivity, props);
    view.click("activity-group-toggle");
    view.update({ ...props, entries: [...props.entries, tool("next", "Bash", "running")] });
    view.update({ ...props, entries: [...props.entries, tool("next", "Bash", "done")] });
    expect(view.html()).toContain('aria-expanded="true"');
    view.update({ ...props, entries: [...props.entries, tool("next", "Bash", "error")] });
    expect(view.html()).toContain('aria-expanded="true"');
    expect(view.html()).toContain("有 1 项失败");
  });

  it.each(["Write", "Edit"])("preserves %s previews and file-change navigation", name => {
    const entry: ActivityEntry = {
      kind: "tool", id: "edit-row", tool: {
        id: "edit-use", name, status: "done", summary: "src/App.tsx",
        resultPreview: "<changed>\nsecond line",
      },
    };
    const view = mountEntry(entry);
    expect(view.html()).not.toContain("activity-tool-preview");
    view.click("activity-step-main");
    expect(view.html()).toContain("&lt;changed&gt;\nsecond line");
    view.click("activity-view-change");
    expect(requestRevealChange).toHaveBeenCalledWith({
      sessionId: "session-one", toolUseId: "edit-use", path: "src/App.tsx",
    });
  });

  it("keeps todo details readable without animating a historical snapshot", () => {
    const entry: ActivityEntry = { kind: "tool", id: "todos", tool: {
      id: "todos", name: "TodoWrite", summary: "Plan", status: "done",
      todos: [
        { content: "Implement", status: "in_progress" },
        { content: "Verify", status: "pending" },
        { content: "Inspect", status: "completed" },
      ],
    } };
    const view = mountEntry(entry);
    view.click("activity-step-main");
    expect(view.html()).toContain("Implement");
    expect(view.html()).toContain("activity-todo-pending");
    expect(view.html()).toContain("activity-todo-completed");
    expect(view.html()).not.toContain("activity-spinner");
  });

  it("preserves overflowing thinking details and lets the user collapse them", () => {
    const text = "Inspecting the existing implementation\nThen checking its boundary cases";
    const view = mountEntry({ kind: "thinking", id: "thought", text, active: false });
    expect(view.html()).toContain('aria-label="展开思考内容"');
    view.click("activity-thinking-toggle");
    expect(view.html()).toContain('aria-label="折叠思考内容"');
    expect(view.html()).toContain(text);
    view.click("activity-thinking-toggle");
    expect(view.html()).toContain('aria-expanded="false"');
  });

  it("preserves the compacted-context event when history is expanded", () => {
    const view = mount(ChatActivity, {
      id: "activity-first", entries: [{ kind: "compaction", id: "compact" }] as ActivityEntry[],
    });
    view.click("activity-group-toggle");
    expect(view.html()).toContain("activity-compaction-event");
    expect(view.html()).toContain("上下文已自动压缩");
  });

  it.each(["unknown", "stopped", "paused"] as const)("does not animate an expanded %s Agent", status => {
    const view = mountEntry(tool("agent", "Agent", "running", status));
    expect(view.html()).not.toContain("activity-spinner");
    expect(view.html()).not.toContain("activity-step-done");
  });
});

it("scopes the extracted activity styles to the new main-chat component", () => {
  const cssPath = new URL("./ChatActivity.css", import.meta.url);
  const css = existsSync(cssPath) ? readFileSync(cssPath, "utf8") : "";
  expect(css).toContain(".chat-activity");
  expect(render([tool("one")])).toContain('class="chat-activity ');
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].map(match => match[1]!.trim())
    .filter(selector => !selector.startsWith("@") && !/^(from|to|[\d.]+%)$/.test(selector));
  for (const selector of selectors.flatMap(selector => selector.split(","))) {
    expect(selector.trim()).toMatch(/^\.chat-activity(?:[ .:#\[]|$)/);
  }
});
