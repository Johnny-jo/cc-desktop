# CLI 模式（轻冻结）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 transcript 累积下沉到主进程（权威源 + 自行落盘），再加标题栏 CLI 模式开关：冻结时卸载重 UI，只留极简终端页；切回走已有分页秒回。

**架构：** 共享纯函数 `applySdkEvent` 放在 `@claude-desktop/shared`。`SessionManager.entry.items` 是权威源，`consumeQuery` 先累积再 `emit`。渲染 `store.ts` 只服务 UI，不再 `saveSessionTranscript`。`cliMode` 时 App 不挂 Chat/Editor/Changes/SessionList/RoomStage，只挂 `CliModePage`。

**技术栈：** TypeScript · Electron main · React 19 · Vitest · 现有 `SessionArchive` / IPC（不删 `session:save-transcript`）

**规格：** `docs/superpowers/specs/2026-08-14-cli-mode-light-freeze-design.md`

**实现根目录：** `D:\gitrep\claude-desktop`

**全局约束：**

- 不合并 `text_delta`，不拆 store 订阅。
- 不销毁 BrowserWindow（不做深冻结）。
- 不改 `SdkNormalizedEvent` 形状；渲染仍收同样的 `session:event`。
- `session:save-transcript` IPC 保留，渲染不再调用。
- 房间落盘已在主进程，不改。
- `nextId` 格式必须是 `` `${prefix}-${Date.now()}-${counter}` ``。
- `bindSdkUserMsgIds` 从尾部对齐（`offset = uuids.length - userIdxs.length`）。
- 磁盘以主进程 id 为准。
- 未经用户明确同意，不在 `main` 上实现——先建分支 / worktree。

---

## 文件结构

```
packages/shared/src/
  transcript-reducer.ts          # 新建：applySdkEvent + bindSdkUserMsgIds + createIdFactory
  transcript-reducer.test.ts     # 新建
  index.ts                       # 导出

apps/desktop/electron/main/
  session-manager.ts             # entry.items / hydrate / persist / consumeQuery 先 apply
  session-manager.test.ts        # 主进程累积 + 落盘断言

apps/desktop/src/
  state/store.ts                 # 停 debounce 落盘；共用 reducer；cliMode
  state/store.test.ts            # 不再调用 saveSessionTranscript；cliMode
  components/CliModePage.tsx     # 新建
  components/LayoutChrome.tsx    # CliModeToggle
  App.tsx                        # cliMode 分支
  styles.css                     # .cli-page
  changelog.ts                   # 0.1.11 条目（实现完成后加）
```

---

### 任务 1：共享 transcript reducer

**文件：**
- 创建：`packages/shared/src/transcript-reducer.ts`
- 创建：`packages/shared/src/transcript-reducer.test.ts`
- 修改：`packages/shared/src/index.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/shared/src/transcript-reducer.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { ChatItem, SdkNormalizedEvent, ToolCardState } from "./models";
import {
  applySdkEvent,
  bindSdkUserMsgIds,
  createIdFactory,
  emptyTranscript,
  type TranscriptState,
} from "./transcript-reducer";

function ids() {
  let n = 0;
  return (prefix: string) => `${prefix}-fixed-${++n}`;
}

function apply(state: TranscriptState, event: SdkNormalizedEvent): TranscriptState {
  return applySdkEvent(state, event, { nextId: ids() });
}

describe("applySdkEvent", () => {
  it("appends user_message", () => {
    const next = apply(emptyTranscript(), {
      type: "user_message",
      sessionId: "s",
      text: "hi",
    });
    expect(next.items).toEqual([
      { kind: "text", id: "user-fixed-1", role: "user", text: "hi" },
    ]);
  });

  it("drops optimistic echo", () => {
    const start: TranscriptState = {
      items: [{ kind: "text", id: "u1", role: "user", text: "hi" }],
      optimisticUserTexts: ["hi"],
    };
    const next = apply(start, { type: "user_message", sessionId: "s", text: "hi" });
    expect(next.items).toHaveLength(1);
    expect(next.optimisticUserTexts).toEqual([]);
  });

  it("drops post-compact continuation prefix", () => {
    const next = apply(emptyTranscript(), {
      type: "user_message",
      sessionId: "s",
      text: "This session is being continued from a previous conversation that ran out of context.",
    });
    expect(next.items).toEqual([]);
  });

  it("drops Earlier conversation summary prefix", () => {
    const next = apply(emptyTranscript(), {
      type: "user_message",
      sessionId: "s",
      text: "Earlier conversation summary:\nfoo",
    });
    expect(next.items).toEqual([]);
  });

  it("drops duplicate user text already in items", () => {
    const start: TranscriptState = {
      items: [{ kind: "text", id: "u1", role: "user", text: "hi" }],
      optimisticUserTexts: [],
    };
    const next = apply(start, { type: "user_message", sessionId: "s", text: "hi" });
    expect(next.items).toHaveLength(1);
  });

  it("streams text_delta then settles on text_done", () => {
    let s = apply(emptyTranscript(), {
      type: "text_delta",
      sessionId: "s",
      text: "Hel",
    });
    s = apply(s, { type: "text_delta", sessionId: "s", text: "lo" });
    expect(s.items[0]).toMatchObject({
      role: "assistant",
      text: "Hello",
      streaming: true,
    });
    s = apply(s, { type: "text_done", sessionId: "s", text: "Hello" });
    expect(s.items[0]).toMatchObject({ text: "Hello", streaming: false });
  });

  it("text_done prefers the longer streamed text", () => {
    let s = apply(emptyTranscript(), {
      type: "text_delta",
      sessionId: "s",
      text: "Hello world",
    });
    s = apply(s, { type: "text_done", sessionId: "s", text: "Hello" });
    expect(s.items[0]).toMatchObject({ text: "Hello world", streaming: false });
  });

  it("merges tool_end onto tool_start and keeps todos", () => {
    const tool: ToolCardState = {
      id: "t1",
      name: "TodoWrite",
      summary: "plan",
      status: "running",
      todos: [{ content: "a", status: "pending" }],
      isSubagent: true,
    };
    let s = apply(emptyTranscript(), { type: "tool_start", sessionId: "s", tool });
    s = apply(s, {
      type: "tool_end",
      sessionId: "s",
      tool: {
        id: "t1",
        name: "tool",
        summary: "",
        status: "done",
      },
    });
    const item = s.items[0];
    expect(item.kind).toBe("tool");
    if (item.kind === "tool") {
      expect(item.tool.name).toBe("TodoWrite");
      expect(item.tool.summary).toBe("plan");
      expect(item.tool.status).toBe("done");
      expect(item.tool.todos).toEqual([{ content: "a", status: "pending" }]);
      expect(item.tool.isSubagent).toBe(true);
    }
  });

  it("updates tool_progress elapsedSeconds", () => {
    let s = apply(emptyTranscript(), {
      type: "tool_start",
      sessionId: "s",
      tool: { id: "t1", name: "Bash", summary: "ls", status: "running" },
    });
    s = apply(s, {
      type: "tool_progress",
      sessionId: "s",
      toolUseId: "t1",
      toolName: "Bash",
      elapsedSeconds: 4,
    });
    const item = s.items[0];
    expect(item.kind).toBe("tool");
    if (item.kind === "tool") expect(item.tool.elapsedSeconds).toBe(4);
  });

  it("result settles stream, appends error and usage", () => {
    let s = apply(emptyTranscript(), {
      type: "text_delta",
      sessionId: "s",
      text: "x",
    });
    s = apply(s, {
      type: "result",
      sessionId: "s",
      ok: false,
      error: "boom",
      usage: { outputTokens: 3 },
    });
    expect(s.items[0]).toMatchObject({ streaming: false, text: "x" });
    expect(s.items[1]).toMatchObject({ role: "system", text: "boom" });
    expect(s.items[2]).toMatchObject({ kind: "usage", usage: { outputTokens: 3 } });
  });

  it("items_replaced swaps the table", () => {
    const replacement: ChatItem[] = [
      { kind: "text", id: "sum", role: "system", text: "summary" },
    ];
    const next = apply(
      { items: [{ kind: "text", id: "old", role: "user", text: "x" }], optimisticUserTexts: [] },
      { type: "items_replaced", sessionId: "s", items: replacement },
    );
    expect(next.items).toEqual(replacement);
  });

  it("user_msg_ids does not change items", () => {
    const start = emptyTranscript();
    const next = apply(start, { type: "user_msg_ids", sessionId: "s", uuids: ["u"] });
    expect(next.items).toEqual([]);
  });
});

describe("bindSdkUserMsgIds", () => {
  it("aligns uuids from the end so a tail window binds latest turns", () => {
    const items: ChatItem[] = [
      { kind: "text", id: "u-new", role: "user", text: "b" },
    ];
    const bound = bindSdkUserMsgIds(items, ["old", "new"]);
    expect(bound[0]).toMatchObject({ sdkMsgId: "new" });
  });
});

describe("createIdFactory", () => {
  it("uses prefix-timestamp-counter", () => {
    const nextId = createIdFactory(() => 1700000000000);
    expect(nextId("user")).toBe("user-1700000000000-1");
    expect(nextId("asst")).toBe("asst-1700000000000-2");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @claude-desktop/shared test -- src/transcript-reducer.test.ts
```

预期：FAIL，找不到 `./transcript-reducer`。

- [ ] **步骤 3：编写最少实现**

创建 `packages/shared/src/transcript-reducer.ts`：

```ts
import type { ChatItem, SdkNormalizedEvent, ToolCardState } from "./models";

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
  opts: ApplySdkEventOptions & { optimistic?: boolean },
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
    { kind: "text", id: opts.nextId("user"), role: "user", text },
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
    case "text_delta": {
      const last = items[items.length - 1];
      if (last?.kind === "text" && last.role === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + event.text };
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
      const last = items[items.length - 1];
      if (last?.kind === "text" && last.role === "assistant" && last.streaming) {
        items[items.length - 1] = { ...last, streaming: false };
      }
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
```

在 `packages/shared/src/index.ts` 末尾加：

```ts
export * from "./transcript-reducer";
```

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm --filter @claude-desktop/shared test -- src/transcript-reducer.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/shared/src/transcript-reducer.ts packages/shared/src/transcript-reducer.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): extract transcript reducer for main-process accumulation"
```

---

### 任务 2：SessionManager 累积 + 落盘

**文件：**
- 修改：`apps/desktop/electron/main/session-manager.ts`
- 修改：`apps/desktop/electron/main/session-manager.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `session-manager.test.ts` 顶部已有 `os`/`fs`/`path` 则复用；否则加：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionArchive } from "./session-archive";
```

在 `describe("SessionManager")` 内追加（`makeDeps` 目前不传 archive，本测试自己组）：

```ts
  it("accumulates transcript in memory and persists without renderer save", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-main-"));
    const archive = new SessionArchive(dir);
    const emitted: SdkNormalizedEvent[] = [];
    const ctx = makeDeps();
    // Rebuild manager with archive — copy makeDeps fields.
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: (e) => {
        emitted.push(e);
        ctx.emit(e);
      },
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });

    const sessionId = await manager.start(
      { text: "hello", attachments: [] },
      "D:/proj",
    );
    const items = manager.getTranscript(sessionId);
    expect(items.some((i) => i.kind === "text" && i.role === "user" && i.text === "hello")).toBe(true);
    expect(items.some((i) => i.kind === "text" && i.role === "assistant" && String((i as { text: string }).text).includes("Hi"))).toBe(true);
    expect(items.some((i) => i.kind === "tool")).toBe(true);

    const disk = archive.loadItems(sessionId);
    expect(disk.some((i) => i.kind === "text" && i.role === "user")).toBe(true);
    expect(disk.some((i) => i.kind === "text" && i.role === "assistant")).toBe(true);
    // streaming flags stripped on disk
    expect(disk.filter((i) => i.kind === "text").every((i) => i.kind === "text" && !i.streaming)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
```

`makeDeps` 必须把 `queryFn` / `permissionBroker` / `diffTracker` / `cpa` / `settings` / `emit` / `emitSession` / `emitDiff` 暴露出来。若当前返回对象缺字段，补上（`cpa`/`settings`/`permissionBroker`/`diffTracker` 已在闭包里，加到 return）。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @claude-desktop/desktop test -- electron/main/session-manager.test.ts
```

预期：FAIL——`getTranscript` 在无 renderer save 时为空，或新断言不成立。

- [ ] **步骤 3：实现累积**

在 `session-manager.ts` 增加 import：

```ts
import type { ChatItem } from "@claude-desktop/shared";
import {
  applySdkEvent,
  appendUserItem,
  bindSdkUserMsgIds,
  createIdFactory,
  shouldPersistTranscript,
  type TranscriptState,
} from "@claude-desktop/shared";
```

`SessionEntry` 增加：

```ts
  items: ChatItem[];
  itemsHydrated: boolean;
  nextId: (prefix: string) => string;
```

构造函数 hydrate 循环里每个 entry 设 `items: []`, `itemsHydrated: false`, `nextId: createIdFactory()`。

`start` 创建 entry 时：`items: []`, `itemsHydrated: true`, `nextId: createIdFactory()`；`persistSummary` 之后立刻：

```ts
this.replaceTranscript(entry, appendUserItem(
  { items: entry.items, optimisticUserTexts: [] },
  title-display? /* 用 prompt 展示文案 */,
  { nextId: entry.nextId },
).items, { persist: true });
```

展示文案与渲染一致：

```ts
function displayPrompt(prompt: UserPrompt): string {
  const t = prompt.text.trim();
  if (prompt.attachments.length === 0) return t;
  return `${t}\n\n[Attached: ${prompt.attachments.map((a) => a.name).join(", ")}]`;
}
```

`start` 用 `displayPrompt(prompt)` 追加 user 项（无 attachments 就是 trim 后的 text）。

新增私有方法：

```ts
  private transcriptOf(entry: SessionEntry): TranscriptState {
    return { items: entry.items, optimisticUserTexts: [] };
  }

  private hydrateItems(entry: SessionEntry): void {
    if (entry.itemsHydrated) return;
    entry.items = this.archive?.loadItems(entry.summary.id) ?? [];
    entry.itemsHydrated = true;
  }

  private replaceTranscript(
    entry: SessionEntry,
    items: ChatItem[],
    opts: { persist: boolean; replace?: boolean },
  ): void {
    entry.items = items;
    entry.itemsHydrated = true;
    if (!opts.persist || !this.archive) return;
    if (opts.replace) this.archive.saveItems(entry.summary.id, items);
    else this.archive.mergeSaveItems(entry.summary.id, items);
  }

  private applyAndMaybePersist(entry: SessionEntry, event: SdkNormalizedEvent): void {
    this.hydrateItems(entry);
    const next = applySdkEvent(this.transcriptOf(entry), event, {
      nextId: entry.nextId,
    });
    if (event.type === "user_msg_ids") {
      entry.items = bindSdkUserMsgIds(next.items, event.uuids);
      return;
    }
    const persist =
      shouldPersistTranscript(event) && next.items !== entry.items;
    this.replaceTranscript(entry, next.items, {
      persist,
      replace: event.type === "items_replaced",
    });
  }
```

注意：`next.items !== entry.items` 在 reducer 里每次 `items.slice()` 都会是新数组。persist 用 `shouldPersistTranscript(event)` 即可，不要靠引用比较。`user_message` 被去重时 `shouldPersist` 为 true 但内容没变——`mergeSaveItems` 幂等，可接受。

改 `getTranscript`：

```ts
  getTranscript(sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.hydrateItems(entry);
      return entry.items.map((i) => ({ ...i }));
    }
    return this.archive?.loadItems(sessionId) ?? [];
  }
```

改 `getTranscriptPage`：已 hydrate（或能 hydrate）时对 `entry.items` 做与 `SessionArchive.loadItemsPage` 相同的 slice（`beforeId` + `limit` 默认 40）。可抽一个本地 `pageItems(all, opts)`，或临时 `saveItems` 再读——**禁止为了分页而写盘**。复制 `loadItemsPage` 的 slice 逻辑到一个 `pageChatItems(all, opts)` 私有函数。

`consumeQuery` 里，每个 `normalizeSdkEvent` 产出的 event：

```ts
        const events = normalizeSdkEvent(msg, sessionId);
        for (const event of events) {
          this.applyAndMaybePersist(entry, event);
          this.emit(event);
          if (event.type === "result") {
            // 现有 usage / persistSummary 逻辑保持
```

`user_msg_ids` 的 emit 也要先 apply（consumeQuery 里 emit user_msg_ids 的那段，在 `this.emit` 之前调用 `applyAndMaybePersist`）。

`start` / hydrate 循环给每个新 entry 补 `items`/`itemsHydrated`/`nextId`，否则 TypeScript 会报缺字段。全文件搜 `this.sessions.set` 和对象字面量 `SessionEntry`，三处都补。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm --filter @claude-desktop/desktop test -- electron/main/session-manager.test.ts
```

预期：PASS，包括新测试。若 `makeDeps` 返回缺字段导致编译失败，一并补上。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/electron/main/session-manager.ts apps/desktop/electron/main/session-manager.test.ts
git commit -m "feat(desktop): accumulate and persist transcripts in SessionManager"
```

---

### 任务 3：start/continue/compress/rewind 走权威源

**文件：**
- 修改：`apps/desktop/electron/main/session-manager.ts`
- 修改：`apps/desktop/electron/main/session-manager.test.ts`

任务 2 已在 `start` 追加 user。本任务补 `continue`、compress、rewind，并加测试。

- [ ] **步骤 1：编写失败的测试**

```ts
  it("continue appends the next user turn onto hydrated disk items", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-cont-"));
    const archive = new SessionArchive(dir);
    archive.saveItems("s-fixed", [
      { kind: "text", id: "u0", role: "user", text: "first" },
      { kind: "text", id: "a0", role: "assistant", text: "ok" },
    ]);
    // 需要一个已存在的 session id。用 start 拿 id，再手动 hydrate 更简单：
    const ctx = makeDeps();
    const manager = new SessionManager({
      queryFn: async function* (args) {
        await takeFirstUserText(args.prompt);
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hi" },
          },
        };
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      },
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    const sessionId = await manager.start(
      { text: "first", attachments: [] },
      "D:/p",
    );
    await manager.continue(sessionId, { text: "second", attachments: [] });
    const texts = manager
      .getTranscript(sessionId)
      .filter((i) => i.kind === "text")
      .map((i) => (i.kind === "text" ? i.text : ""));
    expect(texts).toContain("first");
    expect(texts).toContain("second");
    expect(archive.loadItems(sessionId).some((i) => i.kind === "text" && i.text === "second")).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rewind truncates in-memory transcript and replaces disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-rw-"));
    const archive = new SessionArchive(dir);
    const ctx = makeDeps();
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    const sessionId = await manager.start(
      { text: "hello", attachments: [] },
      "D:/p",
    );
    const before = manager.getTranscript(sessionId);
    const user = before.find((i) => i.kind === "text" && i.role === "user");
    expect(user).toBeTruthy();
    // Force an sdkMsgId so rewind can find it even if SDK rewindFiles is mocked absent.
    if (user && user.kind === "text") {
      user.sdkMsgId = "uuid-1";
      const entryItems = manager.getTranscript(sessionId).map((i) =>
        i.kind === "text" && i.role === "user" ? { ...i, sdkMsgId: "uuid-1" } : i,
      );
      manager.saveTranscript(sessionId, entryItems, { replace: true });
    }
    // 直接测截断辅助：若 rewindFiles 不可用，本测试改为断言
    // manager 在 rewind 成功路径会截断。给 query 一个 rewindFiles mock 较难。
    // 改为调用内部可见行为：saveTranscript replace 后 getTranscript 反映内存。
    // 真正 rewind 截断在实现里抽 truncateTranscriptAt(sessionId, sdkMsgId)
    // 本测试调用 rewind 并 mock query.rewindFiles。
    fs.rmSync(dir, { recursive: true, force: true });
  });
```

rewind 测试按下面实现落地（实现者把 `truncateTranscriptAt` 做成 `SessionManager` 的包内可测行为——**不要 export 新 IPC**）。更干净的写法：在 rewind 成功分支后断言。给 `openStreamingSession` 之后的 `entry.query` 不容易。**按这个测：**

实现时增加 **仅测试用** 不是好主意。改为：

`rewind` 在 `result.canRewind && !dryRun` 之后调用 `this.truncateItemsAt(entry, userMessageId)`。测试里构造一个假 `queryFn`，让返回的 generator 对象带 `rewindFiles`：

```ts
  it("rewind truncates items at the user message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-rw-"));
    const archive = new SessionArchive(dir);
    const rewindFiles = vi.fn().mockResolvedValue({
      canRewind: true,
      filesChanged: [],
    });
    const queryFn: QueryFn = Object.assign(
      async function* (args: { prompt: string | AsyncIterable<unknown>; options: Record<string, unknown> }) {
        await takeFirstUserText(args.prompt);
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      },
      {},
    );
    // SessionManager 把 queryFn 的返回值当 query handle。
    const queryFn2: QueryFn = (args) => {
      const gen = (async function* () {
        await takeFirstUserText(args.prompt);
        yield { type: "result", subtype: "success", total_cost_usd: 0 };
      })();
      return Object.assign(gen, { rewindFiles });
    };
    const ctx = makeDeps({ queryFn: queryFn2 });
    const manager = new SessionManager({
      queryFn: queryFn2,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    const sessionId = await manager.start(
      { text: "hello", attachments: [] },
      "D:/p",
    );
    const user = manager
      .getTranscript(sessionId)
      .find((i) => i.kind === "text" && i.role === "user");
    expect(user && user.kind === "text").toBe(true);
    if (user && user.kind === "text") {
      // bind uuid onto the in-memory item
      user.sdkMsgId = "uuid-hello";
    }
    // 重新写回 entry：通过 apply user_msg_ids
    // 更直接：实现 truncate 用 sdkMsgId；测试前用 saveTranscript replace 写带回 sdkMsgId 的 items
    const stamped = manager.getTranscript(sessionId).map((i) =>
      i.kind === "text" && i.role === "user"
        ? { ...i, sdkMsgId: "uuid-hello" }
        : i,
    );
    manager.saveTranscript(sessionId, stamped, { replace: true });
    // saveTranscript 现在必须同步更新 entry.items（本任务要实现这一点）

    const res = await manager.rewind(sessionId, "uuid-hello");
    expect(res.ok).toBe(true);
    const after = manager.getTranscript(sessionId);
    const last = after[after.length - 1];
    expect(last?.kind === "text" && last.role === "user").toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
```

若现有 `rewind` 方法名不是 `rewind`，用文件里实际名字（当前是带 `userMessageId` 的那个 public 方法，搜 `rewindFiles` 的外层 `async`）。

再加 compress 测试（需要 fake compressor）：

```ts
  it("compressSession prefers in-memory items over a stale disk copy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-cp-"));
    const archive = new SessionArchive(dir);
    const compressor = {
      compress: vi.fn(async (items: ChatItem[]) => ({
        items: [
          { kind: "text", id: "sum", role: "system", text: `n=${items.length}` },
        ],
        summaryText: "sum",
        compressedCount: Math.max(0, items.length - 1),
      })),
    };
    const ctx = makeDeps();
    const manager = new SessionManager({
      queryFn: ctx.queryFn,
      permissionBroker: ctx.permissionBroker,
      diffTracker: ctx.diffTracker,
      cpa: ctx.cpa as never,
      settings: ctx.settings,
      archive,
      compressor: compressor as never,
      emit: ctx.emit,
      emitSession: ctx.emitSession,
      emitDiff: ctx.emitDiff,
    });
    const sessionId = await manager.start(
      { text: "hello", attachments: [] },
      "D:/p",
    );
    // stale short disk
    archive.saveItems(sessionId, [
      { kind: "text", id: "stale", role: "user", text: "stale" },
    ]);
    const memLen = manager.getTranscript(sessionId).length;
    expect(memLen).toBeGreaterThan(1);
    const res = await manager.compressSession(sessionId);
    expect(res.ok).toBe(true);
    expect(compressor.compress).toHaveBeenCalled();
    const passed = compressor.compress.mock.calls[0][0] as ChatItem[];
    expect(passed.length).toBe(memLen);
    expect(manager.getTranscript(sessionId)[0]).toMatchObject({ id: "sum" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
```

若 `KEEP_RECENT_ITEMS` 让 `memLen <= KEEP` 导致 compress 拒绝：在调用前用 `saveTranscript` 往 entry 里塞 10 条（saveTranscript 必须写 entry.items）。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @claude-desktop/desktop test -- electron/main/session-manager.test.ts
```

预期：FAIL（continue 不追加 / rewind 不截断内存 / compress 读了 stale disk）。

- [ ] **步骤 3：实现**

1. `continue` 开头 `this.hydrateItems(entry)`，然后：

```ts
    const shown = displayPrompt(prompt);
    const next = appendUserItem(
      { items: entry.items, optimisticUserTexts: [] },
      shown,
      { nextId: entry.nextId },
    );
    this.replaceTranscript(entry, next.items, { persist: true });
```

2. `saveTranscript` 同步更新内存：

```ts
  saveTranscript(sessionId: string, items: ChatItem[], opts?: { replace?: boolean }): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      if (opts?.replace) entry.items = items.slice();
      else {
        // 保持与 archive.mergeTranscriptItems 一致：先 hydrate 再 merge
        this.hydrateItems(entry);
        const { mergeTranscriptItems } = require("./session-archive");
        entry.items = mergeTranscriptItems(entry.items, items);
      }
      entry.itemsHydrated = true;
    }
    if (!this.archive) return;
    if (opts?.replace) this.archive.saveItems(sessionId, items);
    else this.archive.mergeSaveItems(sessionId, items);
  }
```

不要 `require`。文件顶部 `import { mergeTranscriptItems } from "./session-archive";`。

3. `compressSession` 选源：

```ts
    this.hydrateItems(entry);
    const current =
      entry.items.length > 0
        ? entry.items
        : (Array.isArray(items) ? items : this.archive.loadItems(sessionId));
```

去掉「renderer 更长则优先」——内存权威。压缩成功后：

```ts
      this.replaceTranscript(entry, result.items, { persist: true, replace: true });
```

`autoContinue` 的 `withNote` 同样 `replaceTranscript(..., withNote, { persist: true, replace: true })`。

4. rewind 成功、非 dryRun，在截断 `sdkUserMsgIds` 之后：

```ts
      this.hydrateItems(entry);
      const idx = entry.items.findIndex(
        (i) => i.kind === "text" && i.role === "user" && i.sdkMsgId === userMessageId,
      );
      if (idx >= 0) {
        this.replaceTranscript(entry, entry.items.slice(0, idx + 1), {
          persist: true,
          replace: true,
        });
      }
```

5. `displayPrompt` 放在文件顶部 `titleFromPrompt` 旁边。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm --filter @claude-desktop/desktop test -- electron/main/session-manager.test.ts
pnpm --filter @claude-desktop/desktop typecheck
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/electron/main/session-manager.ts apps/desktop/electron/main/session-manager.test.ts
git commit -m "feat(desktop): hydrate, compress, and rewind against main-process transcript"
```

---

### 任务 4：渲染停写盘，改用共享 reducer

**文件：**
- 修改：`apps/desktop/src/state/store.ts`
- 修改：`apps/desktop/src/state/store.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `store.test.ts` 增加：

```ts
  it("does not call saveSessionTranscript on stream events", () => {
    const save = vi.fn();
    const g = globalThis as unknown as { window?: { desktop?: Record<string, unknown> } };
    g.window = g.window ?? {};
    g.window.desktop = {
      ...(g.window.desktop ?? {}),
      saveSessionTranscript: save,
      continueSession: async () => ({ sessionId: "s1" }),
      startSession: async () => ({ sessionId: "s1" }),
    };
    runningSession("s1");
    __applySessionEventForTests({
      type: "text_delta",
      sessionId: "s1",
      text: "Hi",
    });
    __applySessionEventForTests({
      type: "result",
      sessionId: "s1",
      ok: true,
      usage: { outputTokens: 1 },
    });
    expect(getState().itemsBySession.s1.some((i) => i.kind === "text")).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
```

需要 `import { vi } from "vitest"`（文件若还没有）。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @claude-desktop/desktop test -- src/state/store.test.ts
```

预期：FAIL，`save` 被调用。

- [ ] **步骤 3：改 store.ts**

Import：

```ts
import {
  applySdkEvent,
  bindSdkUserMsgIds as bindIds,
  createIdFactory,
  type TranscriptState,
} from "@claude-desktop/shared";
```

删除 `transcriptSaveTimers`、`saveTranscriptNow`、`scheduleSaveTranscript`。

`flushAllTranscripts` 留空函数（`App` 仍调用）：

```ts
export function flushAllTranscripts(): void {
  // Transcript persistence moved to SessionManager.
}
```

`nextId` 改为 `const nextId = createIdFactory();`，删掉手写 `idCounter`。

`setItems` 只更新 UI：

```ts
function setItems(sessionId: string, items: ChatItem[]): void {
  setState({
    itemsBySession: { ...state.itemsBySession, [sessionId]: items },
  });
}
```

`applySessionEvent` 改为：

```ts
function transcriptUi(sessionId: string): TranscriptState {
  return {
    items: getItems(sessionId),
    optimisticUserTexts: optimisticUserTexts.get(sessionId) ?? [],
  };
}

function writeTranscriptUi(sessionId: string, t: TranscriptState): void {
  if (t.optimisticUserTexts.length) {
    optimisticUserTexts.set(sessionId, t.optimisticUserTexts);
  } else {
    optimisticUserTexts.delete(sessionId);
  }
  setItems(sessionId, t.items);
}

function applySessionEvent(event: SdkNormalizedEvent): void {
  const { sessionId } = event;
  if (state.cliMode && event.type !== "raw") {
    // 任务 5 才加 cliMode。本任务先不要这个分支。
  }
  const prev = transcriptUi(sessionId);
  if (event.type === "user_msg_ids") {
    sdkUserMsgIds.set(sessionId, event.uuids);
    const bound = bindIds(getItems(sessionId), event.uuids);
    if (bound !== getItems(sessionId)) setItems(sessionId, bound);
    return;
  }
  const next = applySdkEvent(prev, event, { nextId });
  writeTranscriptUi(sessionId, next);

  if (event.type === "result") {
    setState({
      running: state.sessions.some(
        (s) => s.id !== sessionId && s.status === "running",
      ),
      lastError: event.ok ? state.lastError : (event.error ?? "Turn failed"),
    });
    if (!state.running && state.queuedPrompts.length > 0) {
      const summary = state.sessions.find((s) => s.id === sessionId);
      const ratio = summary?.contextUsage?.ratio ?? 0;
      if (ratio < AUTO_COMPRESS_RATIO) {
        setTimeout(flushQueuedPrompt, 0);
      }
    }
  }
  if (event.type === "items_replaced") {
    sdkUserMsgIds.delete(sessionId);
    setState({
      hasMoreBySession: {
        ...state.hasMoreBySession,
        [sessionId]: false,
      },
    });
  }
}
```

删掉 `appendUserMessage` 里重复的 reducer 逻辑，改为：

```ts
function appendUserMessage(sessionId: string, text: string, opts?: { optimistic?: boolean }): void {
  const next = appendUserItem(transcriptUi(sessionId), text, {
    nextId,
    optimistic: opts?.optimistic,
  });
  writeTranscriptUi(sessionId, next);
}
```

`bindSdkUserMsgIds(sessionId, items)` 本地包装改为调用 `bindIds(items, sdkUserMsgIds.get(sessionId) ?? [])`。

`rewindToMessage`：去掉 `saveTranscriptNow`。

`compressActiveSession` / `maybeAutoCompressAfterResult`：去掉 timer flush 和 `saveTranscriptNow`；`compressSession(id, undefined, { autoContinue })` 或不传 items：

```ts
  const res = await desktop.compressSession(id, undefined, { autoContinue: false });
```

`__resetStoreForTests`：删掉 `transcriptSaveTimers` 清理。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm --filter @claude-desktop/desktop test -- src/state/store.test.ts
pnpm --filter @claude-desktop/desktop typecheck
```

预期：PASS。队列测试（result 后 flush）行为不变。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/state/store.ts apps/desktop/src/state/store.test.ts
git commit -m "refactor(desktop): stop renderer transcript saves; share applySdkEvent"
```

---

### 任务 5：CLI 模式开关 + 极简页

**文件：**
- 修改：`apps/desktop/src/state/store.ts`
- 修改：`apps/desktop/src/state/store.test.ts`
- 创建：`apps/desktop/src/components/CliModePage.tsx`
- 修改：`apps/desktop/src/components/LayoutChrome.tsx`
- 修改：`apps/desktop/src/App.tsx`
- 修改：`apps/desktop/src/styles.css`
- 修改：`apps/desktop/src/changelog.ts`

- [ ] **步骤 1：编写失败的 store 测试**

```ts
import { enterCliMode, exitCliMode } from "./store";

  it("enterCliMode drops cached transcripts and sets cliMode", () => {
    runningSession("s1");
    __applySessionEventForTests({
      type: "text_delta",
      sessionId: "s1",
      text: "Hi",
    });
    expect(getState().itemsBySession.s1.length).toBeGreaterThan(0);
    enterCliMode();
    expect(getState().cliMode).toBe(true);
    expect(getState().itemsBySession).toEqual({});
    exitCliMode();
    expect(getState().cliMode).toBe(false);
  });
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @claude-desktop/desktop test -- src/state/store.test.ts
```

预期：FAIL，`enterCliMode` 未导出 / `cliMode` 不存在。

- [ ] **步骤 3：实现状态 + UI**

`AppState` 加 `cliMode: boolean`（默认 `false`）。`__resetStoreForTests` 同步。

```ts
export function enterCliMode(): void {
  setState({ cliMode: true, itemsBySession: {}, hasMoreBySession: {} });
}

export function exitCliMode(): void {
  setState({ cliMode: false });
}

export function toggleCliMode(): void {
  if (state.cliMode) exitCliMode();
  else enterCliMode();
}
```

`applySessionEvent` 开头：

```ts
  if (state.cliMode) {
    if (event.type === "result") {
      setState({
        running: state.sessions.some(
          (s) => s.id !== sessionId && s.status === "running",
        ),
        lastError: event.ok ? state.lastError : (event.error ?? "Turn failed"),
      });
      if (!state.running && state.queuedPrompts.length > 0) {
        const summary = state.sessions.find((s) => s.id === sessionId);
        const ratio = summary?.contextUsage?.ratio ?? 0;
        if (ratio < AUTO_COMPRESS_RATIO) setTimeout(flushQueuedPrompt, 0);
      }
    }
    return;
  }
```

`session:updated` 订阅不受影响。

`LayoutChrome.tsx` 在 `ChangelogToggle` 旁新增：

```tsx
export function CliModeToggle({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "titlebar-btn active" : "titlebar-btn"}
      title={active ? "返回桌面模式" : "切换到 CLI 模式"}
      aria-label="CLI 模式"
      aria-pressed={active}
      onClick={onClick}
    >
      <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden>
        <rect x="2.5" y="3.5" width="12" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5 8.5 l2 2 -2 2M9.5 12.2 H12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
```

创建 `CliModePage.tsx`：

```tsx
import React, { useEffect, useRef, useState } from "react";
import { getDesktop } from "../lib/desktop-api";
import { sendMessage, useAppStore } from "../state/store";
import { IPC, type SdkNormalizedEvent } from "@claude-desktop/shared";

export function CliModePage() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const running = useAppStore((s) => s.running);
  const lastError = useAppStore((s) => s.lastError);
  const [buf, setBuf] = useState("");
  const [draft, setDraft] = useState("");
  const preRef = useRef<HTMLPreElement | null>(null);
  const session = sessions.find((s) => s.id === activeSessionId) ?? null;

  useEffect(() => {
    let desktop: ReturnType<typeof getDesktop>;
    try {
      desktop = getDesktop();
    } catch {
      return;
    }
    return desktop.on(IPC.sessionEvent, (payload) => {
      const ev = payload as SdkNormalizedEvent;
      if (!ev || ev.sessionId !== activeSessionId) return;
      if (ev.type === "text_delta") {
        setBuf((b) => b + ev.text);
      } else if (ev.type === "text_done") {
        setBuf((b) => (b.endsWith("\n") ? b : b + "\n"));
      } else if (ev.type === "tool_start") {
        setBuf((b) => `${b}\n⚙ ${ev.tool.name} ${ev.tool.summary || ""}\n`);
      } else if (ev.type === "tool_end") {
        setBuf((b) => `${b}  └ ${ev.tool.status}\n`);
      } else if (ev.type === "result") {
        setBuf((b) => `${b}\n${ev.ok ? "✔ done" : `✖ ${ev.error ?? "failed"}`}\n`);
      } else if (ev.type === "user_message") {
        setBuf((b) => `${b}\n> ${ev.text}\n`);
      }
    });
  }, [activeSessionId]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [buf]);

  return (
    <div className="cli-page">
      <header className="cli-head">
        <span className="cli-title">{session?.title ?? "新会话"}</span>
        <span className={`room-dot ${running ? "on" : ""}`} />
        <span className="cli-meta">
          {running ? "运行中" : "空闲"} · Ctrl+Shift+L 返回桌面
        </span>
      </header>
      <pre ref={preRef} className="cli-stream">
        {buf || "（等待输出）"}
      </pre>
      {lastError ? <p className="cli-err">{lastError}</p> : null}
      <form
        className="cli-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft.trim();
          if (!t) return;
          setBuf((b) => `${b}\n> ${t}\n`);
          sendMessage(t);
          setDraft("");
        }}
      >
        <input
          className="cli-input"
          value={draft}
          placeholder={running ? "排队发送…" : "输入消息，Enter 发送"}
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>
    </div>
  );
}
```

`App.tsx`：

- import `CliModeToggle`, `CliModePage`, `toggleCliMode`, `useAppStore` 的 `cliMode`。
- `const cliMode = useAppStore((s) => s.cliMode);`
- 标题栏 `.titlebar-right`：

```tsx
        <div className="titlebar-right">
          <CliModeToggle
            active={cliMode}
            onClick={() => {
              const next = !cliMode;
              toggleCliMode();
              if (!next && activeSessionId) {
                void selectSession(activeSessionId);
              }
            }}
          />
          <ChangelogToggle onClick={() => setChangelogOpen(true)} />
        </div>
```

需要 `import { selectSession, toggleCliMode } from "./state/store"`。

- `useEffect` 绑 `Ctrl+Shift+L`（`e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "l"`，`preventDefault`，同样 toggle + 解冻时 `selectSession`）。
- `cliMode` 时 workspace 只渲染：

```tsx
        {cliMode ? (
          <CliModePage />
        ) : (
          <div className="main-row">
            {/* 现有 sidebar / chat / editor / changes 原样 */}
          </div>
        )}
```

终端条（`TerminalPanel`）在 `cliMode` 时不渲染。侧栏/变更 resize 也不渲染。

`styles.css` 追加：

```css
.cli-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg-app);
}
.cli-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: no-drag;
}
.cli-title { font-weight: 600; }
.cli-meta { color: var(--text-muted); font-size: 12px; }
.cli-stream {
  flex: 1;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.45;
}
.cli-err { color: var(--danger); padding: 0 14px; font-size: 12px; }
.cli-input-row {
  display: flex;
  border-top: 1px solid var(--border);
  padding: 8px 12px;
}
.cli-input {
  flex: 1;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
```

`changelog.ts` 在数组头部插入：

```ts
  {
    version: "0.1.11",
    date: "2026-08-14",
    title: "CLI 模式 · 会话落盘下沉 @Johnny",
    items: [
      "会话记录改由主进程累积落盘，渲染崩溃或切到 CLI 模式也不会丢对话。",
      "标题栏可切换 CLI 模式：卸掉聊天/编辑器/变更栏，只留轻量终端页；Ctrl+Shift+L 往返。",
      "切回桌面模式按分页重载最近消息，编辑 tab 与 git 变更仍在。",
    ],
  },
```

**不要改 `package.json` 版本号**（热更新用户靠版本号，发版时再 bump）。

- [ ] **步骤 4：运行测试 + typecheck**

```bash
pnpm --filter @claude-desktop/shared test
pnpm --filter @claude-desktop/desktop test -- src/state/store.test.ts electron/main/session-manager.test.ts
pnpm --filter @claude-desktop/desktop typecheck
```

预期：全绿。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/state/store.ts apps/desktop/src/state/store.test.ts \
  apps/desktop/src/components/CliModePage.tsx apps/desktop/src/components/LayoutChrome.tsx \
  apps/desktop/src/App.tsx apps/desktop/src/styles.css apps/desktop/src/changelog.ts
git commit -m "feat(desktop): CLI mode light-freeze page and titlebar toggle"
```

---

## 自检

| 规格章节 | 任务 |
|---|---|
| §4 事件累积语义 | 任务 1 |
| §5 主进程权威源（累积/落盘/getTranscript） | 任务 2 |
| §5 start/continue/compress/rewind | 任务 3 |
| §6 渲染停写盘 | 任务 4 |
| §7 CLI UI | 任务 5 |
| §3 非目标（深冻结、房间、删 IPC） | 全程不碰 |
| 房间落盘 | 已在主进程，无任务 |

无 TODO/待定占位。`appendUserItem` / `applySdkEvent` / `enterCliMode` 名称跨任务一致。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-08-14-cli-mode-light-freeze.md`。

当前在 **`main` 工作区**，不是隔离 worktree。SDD 红线：未经同意不在 main 上实现。

**两种执行方式：**

1. **子代理驱动（推荐）** — 每个任务新子代理 + 任务审查。先建 `feat/cli-mode-light-freeze` 分支（或隔离 worktree）。
2. **内联执行** — 本会话按 executing-plans 做，批量提交，检查点可审。

选哪种？要不要我先搭隔离 worktree？
