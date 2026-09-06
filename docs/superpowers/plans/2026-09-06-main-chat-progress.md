# 主聊天任务进度实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development；对可独立写入的子任务使用 dispatching-parallel-agents，逐任务审查规格与质量。采用测试驱动开发。

**目标：** 实现输入框上方任务／Agent 进度面板、运行与历史分离、紧凑且尊重用户滚动的回答定位。

**架构：** SDK 归一化携带可选结构化进度元数据，主进程将轻量进度存入 SessionSummary 并沿用 sessionUpdated 通知。ChatPanel 连接进度面板，MessageList 使用运行／历史分离的展示块及独立滚动几何函数。各模块只处理自己的状态，不增加执行控制。

**技术栈：** TypeScript、React 19、Electron、现有 SDK、Vitest。

## 全局约束

- 只改主聊天与其必需数据接线；已有群聊工作区改动完整保留。
- 不提交、不推送、不部署。当前分支 group，基线 7183fa2；原地增量工作，已有依赖无需重新安装。
- 面板只显示真实结构化状态，后台 Agent 启动返回不等于任务完成；跨分页、会话切换和重启不漏掉已知进度。
- 主聊天样式使用独立 CSS 文件并限定选择器，不改动群聊 CSS。
- 每个实现先添加失败测试，确认 RED 后再实现；运行聚焦 GREEN，最后运行全量回归。

## 文件边界

1. 数据模块：`packages/shared/src/session-progress.ts`、`models.ts`、`index.ts`、`transcript-reducer.ts`、`apps/desktop/electron/main/normalize-sdk-event.ts`及对应测试。
2. 过程组件：`apps/desktop/src/lib/conversation-blocks.ts`、`components/ChatActivity.tsx`、`ChatActivity.css`及测试。集成到 MessageList 由主代理执行。
3. 进度面板：`apps/desktop/src/components/ChatTaskDock.tsx`、`ChatTaskDock.css`及测试。组件输入为快照，不读取 store。
4. 主代理集成：`ChatPanel.tsx`、`MessageList.tsx`、`lib/chat-scroll.ts`、`components/ChatProgressLayout.css`、`session-manager.ts`、`session-archive.ts`及测试。

## 接口契约

```ts
type ProgressTask = {
  id: string; title: string; status: "pending" | "in_progress" | "completed";
  description?: string; activeForm?: string; owner?: string; scope?: string;
};
type ProgressAgent = {
  id: string; toolUseId?: string; parentToolUseId?: string; title: string;
  status: "running" | "completed" | "failed" | "stopped" | "paused" | "unknown";
  summary?: string; elapsedSeconds?: number; background?: boolean;
};
type SessionProgress = { tasks: ProgressTask[]; agents: ProgressAgent[] };
type ToolTaskUpdate = {
  operation: "create" | "update" | "list" | "replace";
  taskId?: string; tasks?: ProgressTask[];
  patch?: Partial<ProgressTask> & { deleted?: boolean }; success?: boolean;
};
type AgentProgressUpdate = Pick<ProgressAgent, "id"> & Partial<Omit<ProgressAgent, "id">>;
// Optional additions to ToolCardState: task?: ToolTaskUpdate;
// agent?: ProgressAgent; parentToolUseId?: string.
// Optional addition to SessionSummary: progress?: SessionProgress.
// Event: { type: "agent_progress"; sessionId: string; agent: AgentProgressUpdate }.
// normalizeSdkEvent(msg, sessionId, resolveTool?: (id: string) => ToolCardState | undefined)
// updateSessionProgress(previous, event, toolBeforeEvent?) returns same reference on no-op.
// rebuildSessionProgress(items) replays complete retained transcript.
// restoreSessionProgress(value) validates a persisted snapshot and marks live agents unknown.
```

### 任务 1：结构化进度与 SDK 生命周期

- [ ] 添加 `session-progress.test.ts` 与归一化测试：创建 ID、成功／失败更新、删除、列表替换、不同作用域同 ID、TodoWrite、并行／后台 Agent、终态后迟到心跳、恢复与重放。
- [ ] RED：`pnpm --filter @claude-desktop/shared test`；`pnpm --filter @claude-desktop/desktop exec vitest run electron/main/normalize-sdk-event.test.ts`。断言例如：

```ts
expect(updateSessionProgress(undefined, created)?.tasks[0]).toMatchObject({ id: "7", title: "测试", status: "pending" });
expect(updateSessionProgress(runningAgent, backgroundLaunch)?.agents[0]?.status).toBe("running");
```

- [ ] 按接口实现纯函数与可选模型字段；normalizeUser 先用 resolveTool 补足缺失工具名／输入信息，再解析未截断结果；SDK system task 事件使用明确 Agent 类型／调用关联过滤。
- [ ] reducer 合并可选字段，并将 Agent 生命周期回写关联 tool，保持历史记录可重放。
- [ ] GREEN：上述命令及 shared transcript-reducer 测试。写入任务报告，主代理审查后标记完成。

### 任务 2：运行与历史分离、统一工具图标

- [ ] 在 conversation-blocks 测试增加运行步骤在 `live-activity` 中、完成后仅在 `activity` 中、多个并行项、思考到正文边界、不同回合隔离以及全程稳定归档 ID。
- [ ] RED：`pnpm --filter @claude-desktop/desktop exec vitest run src/lib/conversation-blocks.test.ts src/components/ChatActivity.test.ts`。
- [ ] 从 MessageList 提取相关展示组件到 ChatActivity，输出 `ChatActivity({id, entries, durationMs, live?})`，保持现有文件跳转、思考详情及格式；增加清单、更新、Agent 图标。

```ts
const archived = entries.filter(entry => !isLiveActivityEntry(entry));
const live = entries.filter(isLiveActivityEntry);
// 同一条记录只能进入一个数组；live-activity 放在本轮正文尾部。
```

- [ ] 历史默认折叠且不因运行事件重复切换；实时条目全部标为进行中，失败汇总清晰。
- [ ] GREEN：聚焦测试并记录报告；不修改 MessageList.tsx，由主代理接线。

### 任务 3：输入框上方进度入口

- [ ] 用组件渲染／交互测试验证无数据不渲染、真实计数、任务与 Agent 状态、仅一个面板打开、Escape 关闭恢复焦点及会话切换重置。
- [ ] RED：`pnpm --filter @claude-desktop/desktop exec vitest run src/components/ChatTaskDock.test.ts`。
- [ ] 新建 `ChatTaskDock({sessionId, progress})`，数据类型从 shared 导入。采用描边、柔和主题色、rem 字号；绝对定位上拉面板不参与输入框高度计算，窄窗口受可用宽高限制。

```tsx
<button type="button" aria-expanded={open === "tasks"} aria-controls={panelId}>
  TaskList <span>{completed}/{progress.tasks.length}</span>
</button>
```

- [ ] GREEN 并记录报告；不接线 ChatPanel、不编辑全局样式。

### 任务 4：持久化、滚动几何与主界面接线

- [ ] 添加 session-manager/archive 进度跨分页、恢复、回退测试；添加 chat-scroll 针对初始 55% 定位、24px 安全间距、增长时缩减占位和历史阅读不被抢滚动的测试。
- [ ] RED：`pnpm --filter @claude-desktop/desktop exec vitest run electron/main/session-manager.test.ts electron/main/session-archive.test.ts src/lib/chat-scroll.test.ts`。
- [ ] 主进程在应用相关事件时更新 summary.progress，只有变更才持久化／通知；使用工具 ID 查找归一化上下文；消息回退／替换更新快照；恢复未结束 Agent 为 unknown。
- [ ] ChatPanel 将当前会话快照传给 ChatTaskDock；MessageList 接入 ChatActivity 和 live-activity；移除旧过程组件，避免两份实现。
- [ ] 初始定位以输入框顶部为可见底边；最小必要占位计算为 `max(0, targetScrollTop + clientHeight - naturalScrollHeight)`，只在新发送时定位；跟随模式下内容增长重算并减少占位；用户 wheel / touch / 键盘滚动释放跟随，显式到底部恢复。
- [ ] 独立 CSS 覆盖主聊天底部间距为 `calc(var(--composer-h, 140px) + 24px)`，不改已有全局文件。
- [ ] GREEN，审查跨文件整合和历史恢复风险。

### 任务 5：验收与交付

- [ ] 独立代码审查规格、状态时序、面板键盘交互及滚动约束；修复重要问题并重跑覆盖测试。
- [ ] `pnpm --filter @claude-desktop/desktop test`。
- [ ] `pnpm --filter @claude-desktop/shared test`。
- [ ] `pnpm --filter @claude-desktop/desktop typecheck`。
- [ ] `pnpm --filter @claude-desktop/desktop build`。
- [ ] `git diff --check`；核对群聊文件未被本轮额外改动，记录真实窗口验证情况。

## 基线

- 2026-09-06 14:51，desktop 86 文件／1312 项测试全部通过。
- 工作树已包含群聊 WIP；本轮不创建隔离检出以免遗漏这些未提交依赖，不操作已有修改的生命周期。
