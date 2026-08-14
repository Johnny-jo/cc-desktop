# claude-desktop vs Claude Code 功能差异盘点

> 2026-08-11。左表为当前仓库已实现（见 Explore 盘点），右表为 Claude Code / Agent SDK 0.3.220 能力面。
> 按「用户可感知价值」排序，★ = 建议优先做。

## 一、交互层缺失（用户直接感知）

| 功能 | Claude Code | 本项目现状 | 建议 |
|---|---|---|---|
| ★ 消息级 rewind（代码+对话双回滚） | `Esc Esc` / `rewindFiles(userMessageId)` 回滚到任一用户消息处，代码与对话一起回 | 只有操作级文件回滚，对话不回滚 | SDK 自带 `enableFileCheckpointing` + `Query.rewindFiles` + `resumeSessionAt`，可替换/合并自研 SnapshotStore；UI 在每条用户消息加「回滚到此处」 |
| ★ 消息编辑 / 重发 | 编辑历史消息重新生成 | 无 | 结合 rewind 做 |
| ★ 权限规则持久化（allow/deny 列表） | settings.json `permissions.allow/deny/ask`，`/permissions` 管理页 | 只有会话内规则记忆 + 4 种模式 | Settings 加规则编辑器；SDK `canUseTool` 返回 `updatedPermissions` 建议可直接落盘 |
| 队列输入（running 时可继续打字排队） | 支持 | running 时 composer 禁用 | MessageStream 已支持 push，放开 UI 即可 |
| `/resume` 会话恢复选择器 | 列出历史 session 恢复 | 会话列表即恢复（已覆盖大半） | 低优先 |
| `/export` 导出对话 | 导出 markdown | 无 | 小功能 |
| `/copy` 复制最后回复 | 支持 | 无（可选中文本手动复制） | 小功能 |
| Vim 模式 / 键位自定义 | `/vim`、keybindings | 无 | 低优先 |
| 编辑器 Tab 补全（命令/路径/文件混合） | 完整 | `/` 与 `@` 两套独立菜单已近似 | 已大致覆盖 |

## 二、Agent 能力面（SDK 支持但未接）

| 功能 | SDK 能力 | 现状 | 建议 |
|---|---|---|---|
| ★ Effort / thinking 控制 | `options.effort`（low…max）、`maxThinkingTokens`、`Query.setMaxThinkingTokens` | 未暴露 | Composer 加 effort 选择；thinking 预算进 Settings |
| ★ 自定义 subagent（agents 配置） | `options.agents`（AgentDefinition：description/tools/model/prompt） | 只用内建 Task/Agent | 设置页允许定义项目级 agent（对齐 `.claude/agents/*.md`） |
| ★ Plugins | `options.plugins`、`Query.reloadPlugins` | 未接（strictMcpConfig 还显式排除插件 MCP） | 至少支持加载本地 plugin 目录 |
| Skills 选择 | `options.skills`、`Query.reloadSkills` | 被动接受 SDK 上报 | 低优先 |
| fallbackModel | 主模型失败自动降级 | 无 | CPA 多模型场景有用，小投入 |
| maxBudgetUsd / taskBudget | 预算硬顶 | 无 | Settings 加可选上限 |
| maxTurns | 轮次上限 | 无限制 | 可选设置 |
| outputFormat（json_schema 结构化输出） | 支持 | 不需要（交互 UI） | 跳过 |
| forkSession | resume 时 fork 新分支 | 无 | 配合 rewind 做「从这条消息分叉」 |
| additionalDirectories | 多目录工作区 | 单项目 cwd | 项目打开支持多目录 |
| sandbox | 命令沙箱隔离 | 未开 | 安全增强，Windows 支持有限，观望 |
| accountInfo / supportedModels | Query 控制请求 | 模型来自 CPA catalog | 已用 CPA 替代 |

## 三、Hooks（SDK 事件钩子全未接）

SDK `options.hooks` 支持 28 种事件。对用户最有价值的：

| Hook | 能做什么 |
|---|---|
| ★ `Notification` | 桌面通知（权限请求、任务完成、空闲）——桌面应用天然该有 |
| `SessionStart/Stop/SubagentStop` | 侧栏状态、声音提示 |
| `PreCompact/PostCompact` | compact 前后 UI 反馈（现在靠自研 compressor 触发点） |
| `PermissionDenied` | 统计/提示 |
| `FileChanged` | 外部改文件后刷新 diff/快照基线 |
| `ConfigChange` | settings 热更新 |

## 四、斜杠命令缺口

SDK `supportedCommands()` 会把 CLI 内建命令上报（已合并进 `/` 菜单、未识别命令会作为 prompt 发出——但很多 CLI 命令是**客户端本地行为**，发出去没效果）。值得做本地实现的：

- ★ `/resume`、`/rewind`（见一）
- `/permissions`（规则管理，见一）
- `/export`、`/copy`
- `/cost`（已有 usage chip，可只做文案汇总）
- `/doctor`、`/status`（CPA + SDK + 磁盘状态自检页）
- `/init`（生成 CLAUDE.md——现在 agent 也能做，低优先）
- `/review`、`/pr-comments` 等依赖 git/GitHub 集成（见五）

## 五、生态集成缺口（Desktop 相对 CLI 天然缺）

| 功能 | 说明 |
|---|---|
| Git 集成 | `/commit`、diff vs git、branch 感知——目前 diff 是会话内自研快照，不感知 git 仓库状态；可考虑「会话变更 vs git status」合并视图 |
| GitHub (`gh`) | PR 查看/review 工作流 |
| IDE 集成 | CLI 有 VS Code/JetBrains 插件；桌面版可反向做「在编辑器中打开文件」（`shell.openPath` 很简单） |
| 后台任务 | SDK `backgroundTasks` / `stopTask` / task_notification 未接 UI |
| Web 会话同步 | Claude.ai 会话互通——不适用（CPA 网关场景） |

## 六、已有但形态不同（不算缺口，记录差异）

- 模型/认证走本地 CPA 网关，非官方登录
- Compact 为自研摘要（CPA `/v1/messages`），非 CLI 内置 compact 路径
- 权限弹窗为自研 broker，非 settings.json 规则引擎全量
- MCP 配置只认应用内（strictMcpConfig），忽略 `.mcp.json`/用户级——**有意为之**

## 建议落地顺序

1. **消息级 rewind**（Esc Esc 等价物）：SDK checkpointing + resumeSessionAt，自研快照可保留做操作级粒度
2. **权限规则持久化 + `/permissions` 页**
3. **Composer 排队输入 + effort 控制**（小投入高感知）
4. **桌面通知（Notification hook）**
5. 自定义 agents / plugins 配置面
6. Git 集成（diff 视图叠加 git status、在编辑器打开）
