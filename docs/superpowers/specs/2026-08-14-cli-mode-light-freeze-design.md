# CLI 模式（轻冻结）规格

**日期：** 2026-08-14  
**状态：** 已获用户批准（方案文档 `docs/cli-mode-light-freeze-plan.md`）  
**范围：** 主进程 transcript 权威累积 + 渲染进程轻冻结 CLI 页。不做深冻结（不销毁 BrowserWindow）。

---

## 1. 背景

桌面端长会话 + 多编辑器 tab 时，渲染进程堆（Markdown DOM、CodeMirror、React 树）是内存大头。用户希望一键切到「CLI 状态」：模型继续跑、git 继续追、会话继续记，但把重 UI 卸掉；切回时按已有分页秒回。

硬阻塞：transcript 目前由渲染进程 `store.ts` 累积，再 200ms debounce 回传 `session:save-transcript`。冻结/卸载渲染层后这条链会断，对话丢失。渲染崩溃同样会丢 debounce 窗口内的内容。

房间时间线已由主进程 `RoomService` + `RoomArchive` 落盘，本期不改。

## 2. 目标

1. 主进程 `SessionManager` 持有 `entry.items` 作为 transcript 权威源，按 SDK 事件累积并自行落盘。
2. 渲染进程不再回传 transcript；`applySessionEvent` 只服务 UI。
3. 标题栏可切换 `cliMode`：卸载 Chat / Editor / Changes / SessionList / RoomStage，只留极简 CLI 页 + 标题栏 + 权限/提问弹窗。
4. 冻结期间模型流、DiffTracker、快照、房间服务不受影响。
5. 切回走已有 `selectSession(sessionId, 40)` 拉尾部，不重建窗口。

## 3. 非目标

- 深冻结（销毁 BrowserWindow / 改用系统终端）
- 合并 `text_delta`、拆 store 订阅
- CLI 页做完整 REPL / 斜杠命令菜单
- 房间落盘下沉（已在主进程）
- 删除 `session:save-transcript` IPC（保留，渲染不再调用，兼容旧 preload）

## 4. 事件累积语义（必须与现渲染一致）

共享纯函数 `applySdkEvent(state, event, { nextId })`，主进程与渲染共用。

| 事件 | 行为 |
|---|---|
| `user_message` | 若 text 命中 optimistic 队列则丢弃；若以 `This session is being continued from a previous conversation` 或 `Earlier conversation summary:` 开头则丢弃；若已有相同 user text 则丢弃；否则追加 user 文本项 |
| `text_delta` | 末尾是 streaming assistant 则拼接 text；否则新建 streaming assistant 气泡 |
| `text_done` | 落定末尾 streaming assistant（取较长一方）；重复全文忽略；否则追加非 streaming assistant |
| `tool_start` | 按 `tool.id` 更新或追加 tool 项 |
| `tool_end` | 按 id 合并（保留 name/summary/todos/isSubagent 缺省） |
| `tool_progress` | 按 `toolUseId` 更新 elapsedSeconds / name |
| `result` | 落定末尾 streaming assistant；`!ok && error` 追加 system 文本；有 `usage` 追加 usage 项 |
| `items_replaced` | 整表替换为 `event.items` |
| `user_msg_ids` | 不改 items 形状；由调用方随后跑 `bindSdkUserMsgIds`（从尾部对齐 uuid） |
| `raw` | 忽略 |

`nextId(prefix)` 格式：`${prefix}-${Date.now()}-${counter}`。主进程与渲染各自计数，**磁盘以主进程 id 为准**。直播期间 UI 可以有自己的 id；解冻 / 切会话后从主进程分页重载。

## 5. 主进程权威源

`SessionEntry` 增加：

- `items: ChatItem[]`
- `itemsHydrated: boolean`

规则：

- `start`：`items = []`，`itemsHydrated = true`，立刻追加一条 user 文本（展示文案与渲染一致：有附件时 `${text}\n\n[Attached: a, b]`），再开流。
- `continue`：若未 hydrate，先 `archive.loadItems` 填入再标 hydrate；立刻追加 user 文本（与已有末条相同 user text 则不重复）。
- `consumeQuery` 里每个 `normalizeSdkEvent` 产出的事件：先 `applySdkEvent` 写 `entry.items`，再 `emit`（协议不变）。
- `user_msg_ids`：更新 `entry.sdkUserMsgIds` 后对 `entry.items` 做 `bindSdkUserMsgIds`。
- 落盘：`text_delta` / `tool_progress` **不写盘**；`user_message`（新追加）、`text_done`、`tool_start`、`tool_end`、`result`、`items_replaced`、rewind 截断、start/continue 的乐观 user 追加 → 立刻 `archive.mergeSaveItems`（`items_replaced` / rewind / compress 用 `saveItems` 整表替换）。
- `getTranscript`：已 hydrate 则返回 `entry.items`，否则读盘。
- `getTranscriptPage`：已 hydrate 则对 `entry.items` 分页，否则走 archive。
- `compressSession`：优先 `entry.items`（空则读盘）；不再依赖渲染传入的窗口；成功后 `entry.items = result.items`。
- `rewind` 成功（非 dryRun）：按 `sdkMsgId` 截断 `entry.items` 至该 user 气泡（含），`saveItems` 整表替换。

## 6. 渲染进程

- `setItems` 不再 `scheduleSaveTranscript`。
- `flushAllTranscripts` 变为空操作（`App` 的 `pagehide` 调用可保留，不做事）。
- `compressActiveSession` / `maybeAutoCompressAfterResult` 不再先 `saveTranscriptNow`；`compressSession` 可不传 items。
- `rewindToMessage` 仍截断 UI items，不再回传落盘。
- `applySessionEvent` 改为调用共享 `applySdkEvent`，随后处理 running / lastError / 队列 flush / hasMore（这些仍只属于 UI）。
- `cliMode === true` 时：`session:event` 里会改 transcript 的事件**不写入** `itemsBySession`（权限 / `session:updated` / 错误仍处理）。CLI 页自己订 `text_delta` / `text_done` / `result` 做纯文本缓冲。

## 7. CLI 模式 UI

- 状态：`AppState.cliMode: boolean`，默认 `false`。`enterCliMode()` / `exitCliMode()`。
- `enterCliMode`：`cliMode = true`；`itemsBySession` 只保留 `activeSessionId` 的尾部（可直接清空全部，反正冻结期间不往里写）。
- `exitCliMode`：`cliMode = false`；调用方对活动会话再跑一次 `selectSession`。
- 入口：标题栏 `.titlebar-right` 在更新日志图标左侧加 `CliModeToggle`（终端字形图标）。`aria-pressed={cliMode}`。快捷键 `Ctrl+Shift+L`（避开终端面板）。
- `cliMode` 时 `App` **不渲染**：`SessionList`、`ChatPanel`、`FileEditor` 树、`ChangesPanel`、`RoomStage`、`TerminalPanel`。
- `cliMode` 时 **仍渲染**：标题栏、`ErrorBanner`、`UpdateBanner`、`PermissionModal`、`UserPromptModal`、`SettingsDrawer`（若已打开）、`OnboardingModal`、`ChangelogModal`、`<CliModePage />`。
- `CliModePage`：活动会话名 + running 点；一块 `pre` 纯文本流（本地 buffer，订 `session:event` 的 `text_delta`/`text_done`/`tool_start`/`tool_end`/`result`）；底部单行输入，Enter 调现有 `sendMessage`；提示「Ctrl+Shift+L 返回桌面」。
- 编辑器 tab 清单留在 `App` 的 `useState`，解冻后按清单重挂 `FileEditor`（CodeMirror 重建，可接受）。
- 房间：`bindRoomEvents` 保持挂在 `App`；冻结期间 store 继续收快照，解冻后 `RoomStage` 重挂即可。

## 8. 验证

1. 主进程单测：一轮 start 流过后 `getTranscript` 含 user + assistant + tool + usage；不经渲染 `saveTranscript`。
2. 共享 reducer 单测：与上表逐事件一致，含回显去重、post-compact 前缀丢弃、tool_end 保留 todos。
3. 渲染：`setItems` / `result` 后不再调用 `saveSessionTranscript`（store 测试用 stub 断言）。
4. typecheck + `pnpm --filter @claude-desktop/desktop test` + `pnpm --filter @claude-desktop/shared test` 全绿。
5. 手测：长会话切 CLI，任务管理器渲染内存回落；模型继续出字；切回尾部 40 条在、编辑 tab 还在、变更在。
