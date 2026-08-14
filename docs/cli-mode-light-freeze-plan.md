# CLI 模式（轻冻结）方案

## 目标与边界

- 一键把界面切成「纯 CLI 状态」：会话继续跑、git 变更继续追、transcript 继续落盘，但聊天/编辑器/变更栏的 React 树全部卸载，只留下一个轻量终端页。
- 切回来时窗口**不重建**，按已有的分页加载（尾部 40 条）秒回。
- 本期只做**轻冻结**。深冻结（销毁 BrowserWindow、改用系统终端）留后手——它能再省 ~150MB 渲染壳 + GPU 进程，但切回要重建窗口 + 冷启，体验差一截，且改动面大。

## 为什么必须先做第 0 步（这是硬前置）

现在 transcript 的累积在**渲染进程**：`store.ts` 的 `applySessionEvent` 按事件拼 `items`，再经 200ms debounce `saveSessionTranscript` 回传主进程落盘（merge 模式）。一旦冻结/卸载渲染层，这条链就断了——模型还在跑，但没有任何地方在攒对话，切回来历史就是缺的。

所以第一步是把「事件 → items 累积 → 落盘」整个搬进主进程 `SessionManager`。这一步**独立成立**，顺带修掉一个老隐患：渲染进程崩溃/被 kill 时，debounce 窗口内的内容会丢。

## 收益预估（基于上一轮结论）

- 空闲/短会话：300–400MB → ~150–250MB，省 30–40%
- 长会话 + 多编辑器 tab：700MB–1GB+ → ~150–250MB，省 60–80%
- 冻结期间：无 markdown/layout/GPU 合成，渲染 CPU 趋近 0；模型流照常在主进程跑

## 设计

### 第 0 步：transcript 累积下沉到主进程（前置，独立交付）

主进程已有 `entry.summary`/`sdkUserMsgIds`/diff 追踪，唯独没有累积 items。给它加一份 `entry.items: ChatItem[]`（内存权威），`consumeQuery` 里 `normalizeSdkEvent` 产出事件后，**先在主进程套用一遍累积逻辑，再照常 `emit` 给渲染**（渲染协议不变，UI 不受影响）：

- `text_delta`：追加到末尾 streaming assistant 气泡（与 `store.ts:259-277` 同逻辑，但写进 `entry.items`）
- `text_done`：落定该气泡
- `tool_start`/`tool_end`/`tool_progress`：按 tool id 合并（同 `store.ts:308-378`）
- `user_message`：追加 user 项（去重逻辑保留：SDK 回显、post-compact 恢复前缀）
- `result`：收尾 streaming 气泡 + 追加 usage 项 + **主进程直接 `archive.mergeSaveItems` 落盘**，不再等渲染回传
- `items_replaced`（压缩）：主进程本就 `archive.saveItems`，同时更新 `entry.items`
- ID 生成：`nextId` 逻辑搬主进程（或主进程用 `main-` 前缀，渲染继续用自己的，落盘以主进程为准）

去重规则（`user_message` 的回显/重复过滤、`bindSdkUserMsgIds` 的从尾部对齐）原样搬，保证主进程攒出的 items 与今天渲染攒出的**逐项一致**——用现有 session 落盘文件做对照验证。

渲染端的变化：

- `saveSessionTranscript` debounce **废弃**；`applySessionEvent` 仍更新 UI 内存（用于渲染），但不再回传落盘
- `flushAllTranscripts` 退出前不再兜底（主进程自己落盘了）
- 切会话/冷启动加载仍走 `session:select` 分页，不变

**这一步完成后，即使不做 CLI 模式，『渲染崩了丢对话』也修好了。**

### 第 1 步：CLI 模式开关 + 极简终端页

**入口**：标题栏 `.titlebar-right` 加一个切换图标（和更新日志图标并列），或设置里加开关。全局状态 `cliMode: boolean` 放 store。

**冻结动作**（`cliMode: false → true`）：

1. `App.tsx` 顶层判断：`cliMode` 时**不渲染** `ChatPanel` / `FileEditor` / `ChangesPanel` / `SessionList` / `RoomStage`——整棵重 UI 树卸载，只挂一个 `<CliModePage />`
2. 卸载前把必要 UI 状态存进 store（滚动位置、打开的编辑 tab、activeSessionId 已有）
3. `itemsBySession` 里非活动会话的内存 items **清空**（活动会话保留尾部窗口即可，反正主进程有全量）——这一步是省内存的大头
4. xterm 终端若开着（`TerminalPanel`），CLI 页可以直接复用它当主界面

**CLI 页内容**（轻量，一个文件）：

- 活动会话的流式输出：直接订 `session:event` 的 `text_delta`，**纯文本 append**（不跑 ReactMarkdown），类似今天的 `md-stream-plain`
- 底部状态行：会话名、running 状态、token/成本
- 提示「按 Ctrl+` 或点图标返回桌面模式」
- 不需要完整 REPL——发消息可以保留一个简单输入框，走现有 `sendPrompt` IPC

**解冻动作**（`true → false`）：

1. 重新挂载原 UI 树
2. 活动会话走 `selectSession(sessionId, SELECT_PAGE)` 拉尾部 40 条（已有分页，主进程 items 是权威源）
3. 编辑器 tab 按 store 里存的清单重开（FileEditor 本就按需加载）
4. git 变更面板 `changesBySession` 主进程 DiffTracker 一直在追，切回直接 `gitStatus` 拉一次即可

### 第 2 步：冻结期间的后台保活清单

这些**已经在主进程**，冻结后天然继续工作，无需改动：

- 模型流（`consumeQuery`）+ 第 0 步的 items 累积 + 落盘
- DiffTracker / Bash 写盘扫描 / git status
- 快照（snapshot）
- 房间服务（RoomService——冻结时房间时间线也在主进程累积，切回再渲染）

需要确认的：房间消息目前渲染端有没有类似 transcript 的『渲染攒了再回传』？如果房间落盘也靠渲染，要一并下沉（查 `room-archive.ts` 的写入方）。

## 改动文件预估

| 文件 | 改动 |
|---|---|
| `electron/main/session-manager.ts` | `entry.items` 累积 + 落盘（第 0 步核心） |
| `electron/main/session-archive.ts` | 无需大改，`mergeSaveItems` 复用 |
| `packages/shared/src/models.ts` | 事件类型不变；可能加 `cliMode` 相关 IPC |
| `src/state/store.ts` | 去掉 debounce 落盘；加 `cliMode` 状态与冻结/解冻动作 |
| `src/App.tsx` | `cliMode` 分支渲染 |
| `src/components/CliModePage.tsx` | 新增，极简终端页 |
| `src/components/LayoutChrome.tsx` | 标题栏切换图标 |
| `src/styles.css` | CLI 页样式 |

## 验证

1. **第 0 步回归**（最重要）：正常发几轮对话，关掉渲染进程（任务管理器 kill renderer / `webContents.forcefullyCrashRenderer()`），主进程落盘的 transcript 应完整；重启后历史无缺。对比主进程累积的 items 与旧渲染落盘文件逐项一致。
2. 冻结：长会话 + 3 个编辑器 tab，切 CLI 模式，任务管理器看渲染进程内存应明显回落；模型继续出字（CLI 页看得到流式文本）。
3. 解冻：切回，活动会话尾部 40 条秒出，编辑器 tab 恢复，变更面板数据不丢。
4. 房间：冻结期间房间消息不丢，切回后时间线完整。
5. typecheck + `pnpm --filter @claude-desktop/desktop test` 全绿；`__resetStoreForTests` 同步处理新状态。

## 不做（本期）

- 深冻结（销毁 BrowserWindow / 系统终端）——后手
- 房间落盘下沉若不是必需（先查再定）
- CLI 页不做完整 REPL / 斜杠命令——保持极简

## 顺序建议

第 0 步单独一个提交先落地验证（它本身就修了渲染崩溃丢对话的 bug），第 1、2 步再跟上。这样即使 CLI 模式后面有反复，前置收益也拿到了。
