# Claude Desktop（Codex 感 UI）设计规格

**日期：** 2026-08-02  
**状态：** 待用户审查  
**范围：** 本地桌面客户端，底层驱动 Claude Code / Claude Agent SDK，轻量集成本机 CPA（CLIProxyAPI）

---

## 1. 背景与目标

### 1.1 问题

Claude Code CLI 能力完整，但操作感偏弱：流式过程难扫、文件改动不直观、权限确认打断、多会话切换不顺。用户希望自建一套 **类似 OpenAI Codex 的桌面前端**，引擎尽量复用 Claude Code，并接入现有本机 CPA 代理以切换上游模型。

### 1.2 产品一句话

一个本地桌面 App：用更好看的会话 / 工具调用 / Diff UI 驱动 Claude Code，并通过本机 CPA 切换上游模型。

### 1.3 成功标准（MVP）

1. 用户可打开本地项目目录，发起多轮 agent 任务。
2. 实时看到流式回复与工具调用卡片（Read / Edit / Bash 等）。
3. 危险或未授权工具调用弹出批准 UI，可允许一次 / 本会话允许 / 拒绝。
4. 右侧能看到本会话 Agent 产生的文件变更列表，并打开 unified diff。
5. App 可自动检测 / 启动本机 CPA，并切换模型（如 kimi-for-coding、grok-4.5）。
6. 会话可列表、恢复，异常后不丢 transcript。

### 1.4 非目标（MVP 明确不做）

- 内嵌完整终端或文件树编辑器（轻 IDE）
- CPA 账号池、上游 OAuth、密钥渠道的深度管理
- 远程多租户 / 云托管 agent 服务
- 插件市场
- 完整 Git UI（commit / branch / PR）
- 把 Bash 间接修改的文件自动纳入 Diff

---

## 2. 已确认决策

| 项 | 选择 |
|----|------|
| 产品形态 | 桌面端 |
| MVP 完整度 | 完整 MVP（过程 + 改动 + 权限 + 多会话基础） |
| UI 深度 | 聊天 + Diff（非纯聊天、非轻 IDE） |
| 架构 | Electron + `@anthropic-ai/claude-agent-sdk` |
| CPA | 轻集成：启停 + env 指向 + 模型切换 |
| 仓库 | 独立新目录/仓库，不与当前标书文档目录混放 |

---

## 3. 系统架构

### 3.1 进程拓扑

```
┌─────────────────────────────────────────────┐
│ Electron Renderer (React + TS)              │
│  Sessions · Chat stream · Tool cards        │
│  Permission modal · Changes / Diff · Model  │
└──────────────────┬──────────────────────────┘
                   │ IPC（结构化事件，无密钥）
┌──────────────────▼──────────────────────────┐
│ Electron Main                               │
│  SessionManager   PermissionBroker          │
│  DiffTracker      CpaSupervisor             │
│  SettingsStore (safeStorage for secrets)    │
└───────┬──────────────────────────┬──────────┘
        │ SDK query/resume         │ spawn / health
        ▼                          ▼
 @anthropic-ai/claude-agent-sdk   cli-proxy-api.exe
        │                          (CPA :8317)
        ▼
  claude 子进程 + 项目工作区 FS
```

### 3.2 职责边界

| 单元 | 职责 | 不负责 |
|------|------|--------|
| **Renderer** | 渲染消息流、工具卡片、Diff、权限弹窗；发起用户输入 | 不持有 API token；不直接 spawn claude |
| **SessionManager** | 创建/恢复/列举会话；消费 SDK async generator；转发事件到 UI | 不解析 CPA 管理 API |
| **PermissionBroker** | 实现 `canUseTool`；将会话级允许规则缓存；回传 allow/deny | 不绕过用户做全局 bypass（MVP 默认） |
| **DiffTracker** | 从 Edit/Write 工具事件构建会话变更集；提供 unified hunk | 不 watch 全盘 git；不处理 Bash 侧写 |
| **CpaSupervisor** | 探测端口、按配置启停 CPA、健康状态、注入 env | 不改 CPA 上游凭据 / 账号池 |
| **SettingsStore** | 项目路径、CPA 路径、默认模型、token（加密） | 不提交明文密钥到磁盘配置仓库 |

### 3.3 为何不用「直接包 CLI」

`claude -p --output-format stream-json` 适合脚本，但权限回调、会话双向控制、类型化事件弱于 Agent SDK。SDK 仍会托管 claude 子进程，但提供 `query`、`canUseTool`、`includePartialMessages`、session API，更适合自建 UI。

---

## 4. 用户界面

### 4.1 主布局（三栏）

```
┌ Top bar: 项目路径 · CPA 状态灯 · 模型下拉 · 权限模式 ────────┐
│ Left          │ Center                    │ Right              │
│ Sessions      │ Chat                      │ Changes            │
│ · 当前项目    │ 流式 assistant            │ 文件列表 A/M       │
│ · 历史        │ 工具卡片                  │ 选中文件 Diff      │
│ · 新建        │ 权限相关状态              │ unified hunks      │
│               │ [输入框 · 发送]           │                    │
└───────────────┴───────────────────────────┴────────────────────┘
```

### 4.2 关键 UI 元素

- **会话列表：** 标题（可后续自动命名）、时间、进行中指示
- **消息气泡 / 流：** 文本增量；工具块折叠展开
- **工具卡片：** 工具名、关键参数摘要（路径、命令短预览）、状态（running / done / error）、结果摘要
- **权限弹窗：** 工具名、风险摘要、Allow once / Allow for session / Deny
- **Changes 面板：** 路径 + 状态；点击打开 diff
- **顶栏 CPA：** 绿/黄/红；点击可「启动代理 / 打开配置目录」

### 4.3 视觉方向（MVP）

深色、偏 IDE / Codex 的信息密度；不追求品牌插画。重点是可扫性：工具与 diff 一眼可辨。

---

## 5. 核心流程

### 5.1 打开项目并发起任务

1. 用户选择本地目录作为 `cwd`。
2. Main 校验目录可读；记录为当前项目。
3. 用户输入 prompt → Renderer IPC `session.start` 或 `session.continue`。
4. SessionManager 调用 SDK `query({ prompt, options })`，`options` 含：
   - `cwd`
   - `includePartialMessages: true`
   - `permissionMode` / `canUseTool`
   - 从 CpaSupervisor 取得的 env（BASE_URL / TOKEN / MODEL 等）
   - 合理的 `allowedTools` 默认集（Read, Edit, Write, Bash, Glob, Grep, …）
5. 事件流经 IPC 推到 Renderer 渲染。
6. `result` 事件更新成本、session_id、结束状态。

### 5.2 权限流

```
SDK canUseTool(toolName, input)
  → PermissionBroker 查会话规则（精确工具+路径/命令模式）
  → 未命中则 IPC permission_request
  → UI 选择
  → { behavior: "allow", updatedInput } | { behavior: "deny", message }
```

**模式（顶栏切换）：**

| 模式 | 行为 |
|------|------|
| `default` | 未匹配规则都问 |
| `acceptEdits` | Edit/Write 自动允许；Bash 等仍问 |
| `plan` | 只读探索，写操作拒绝或引导 |

**硬规则：**

- 破坏性 Bash（如 `rm -rf`、磁盘格式化等启发式）即使在 acceptEdits 下也强制确认。
- 「本会话允许」必须绑定足够具体的模式，避免 `Bash(*)` 一刀切（MVP 可先支持「同工具名 + 同路径前缀」级规则，并在 UI 展示已授权列表）。
- 权限请求超时（可配置，默认 5 分钟）视为 deny，避免 agent 永久挂起。

### 5.3 Diff / 变更追踪

**数据源（仅 Agent 工具）：**

| 工具 | 处理 |
|------|------|
| `Edit` | 记录 path、old_string、new_string → 生成 unified hunk |
| `Write` | 记录 path、完整新内容；若先前可读则与旧内容 diff，否则标为 Added |

**会话变更集模型：**

```ts
type FileChange = {
  path: string
  status: "A" | "M"
  hunks: string  // unified diff text
  updatedAt: number
}
```

同文件多次 Edit 时：MVP 采用「展示累计会话视图」——以会话开始时的文件快照（首次触达时读取）为 base，与当前磁盘内容或最后一次 Write/Edit 合成结果对比；若 baselining 成本过高，退化为「按事件列表展示每次 Edit 的 hunk，并在列表上聚合路径」。

**推荐实现顺序：**

1. 先做「事件级 hunk 列表 + 按路径聚合」
2. 再优化为「文件级累计 diff」

**明确不做：** git working tree 全量 watch；hunk 级 accept/reject；Bash 写文件回扫。

### 5.4 会话管理

- 每个 `query` 产生 `session_id`（来自 SDK result）
- 支持：新建、继续最近、按 id resume、列表（SDK `listSessions` / 本地索引）
- UI 显示历史消息：优先 SDK `getSessionMessages`；必要时本地镜像一份索引（标题、cwd、updatedAt）
- 崩溃恢复：保留 session_id 与本地索引；用户可 resume

### 5.5 CPA 轻集成

对齐现有 `D:\gitrep\CC\CPA` 用法（`claude-cpa.ps1` / `.cmd`）：

**启动逻辑：**

1. 探测 `127.0.0.1:{port}`（默认 8317）
2. 不通则 `spawn` 用户配置的 `cli-proxy-api.exe --config <config.yaml>`
3. 轮询直至健康或超时 → 顶栏状态
4. 为 SDK/claude 子进程设置进程环境：
   - `ANTHROPIC_BASE_URL=http://127.0.0.1:8317`
   - `ANTHROPIC_AUTH_TOKEN=<stored>`
   - `ANTHROPIC_MODEL=<selected>`
   - `ANTHROPIC_SMALL_FAST_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` 等映射到 CPA 上存在的轻量模型
   - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

**模型切换：** 更新设置与后续 turn 的 model/env；不要求重启整个 Electron。进行中的 turn 不中途热切模型。

**退出策略：**

- 设置项：`shutdownCpaOnQuit`（默认 false，避免影响用户其他 CLI 用法）
- 仅当 **本 App 拉起** 的 CPA 进程且用户开启该选项时，才在退出时终止

**配置项：**

- CPA 可执行文件路径
- config.yaml 路径
- port（默认 8317）
- auth token（`safeStorage` 加密）
- 默认模型 + 可选模型列表（用户可编辑简单列表；MVP 不从 CPA management API 动态拉取）

**不做：** 写入/修改 CPA 上游凭据；嵌入完整 management 后台（可后续「在浏览器打开 management」链接）。

### 5.6 错误处理

| 情况 | 行为 |
|------|------|
| CPA 未就绪 | 禁止新 turn 或明确报错；历史只读 |
| SDK/claude 崩溃 | 标记会话 error；保留 transcript；提供 resume |
| 权限超时 | deny + 聊天区提示 |
| 模型不被上游识别 | 展示 CPA/上游返回错误；建议切换模型 |
| 工作区无权限 | 打开项目时失败提示 |

---

## 6. 技术栈与工程结构

### 6.1 技术选型

| 层 | 选型 |
|----|------|
| 壳 | Electron（Windows 优先） |
| UI | React + TypeScript + Vite |
| 引擎 | `@anthropic-ai/claude-agent-sdk` |
| Diff 展示 | 自研轻量 unified 渲染，可后换专用库 |
| 密钥 | Electron `safeStorage` + 主进程内存 |
| 包管理 | pnpm 或 npm（实现阶段定一种） |

### 6.2 建议仓库布局

```
claude-desktop/           # 新目录，勿与 ceshi 标书文件混放
  apps/desktop/
    electron/main/        # SessionManager, CpaSupervisor, ...
    electron/preload/
    src/                  # React UI
  packages/shared/        # IPC 事件类型、DTO
  docs/
  package.json
  README.md
```

### 6.3 IPC 事件（草案）

**Renderer → Main**

- `project.open`
- `session.start` / `session.continue` / `session.abort`
- `permission.respond`
- `settings.get` / `settings.set`
- `cpa.start` / `cpa.status`
- `model.set`

**Main → Renderer**

- `session.event`（透传/规范化后的 SDK message：assistant、stream_event、user、result…）
- `permission.request`
- `diff.updated`
- `cpa.status`
- `session.list` / `session.updated`
- `app.error`

渲染进程 **永不** 收到 raw auth token。

### 6.4 安全要求

1. Token 仅主进程；preload 白名单 API。
2. 建议用户将 CPA `host` 设为 `127.0.0.1`（文档与设置向导中提示；当前示例 config 若 `host: ""` 存在全网卡绑定风险）。
3. 不在日志中打印 token 与完整 Authorization 头。
4. 默认不使用 `bypassPermissions`；若未来提供，需显式二次确认且仅限受信目录。
5. 产品文案定位为「自托管本地代理 + 用户自备凭据」，不提供账号共享能力。

---

## 7. CPA 集成风险与缓解

| 风险 | 级别 | 缓解 |
|------|------|------|
| 进程启停 / 端口占用 | 低 | 健康检查 + 明确错误；可配置路径 |
| 流式/tool 与上游兼容 | 中 | MVP 锁定常用模型；错误可观测 |
| CPA 版本升级 | 中 | 当外部依赖；版本说明；不深绑 management API |
| 密钥落盘 / 日志 | 高（可控） | safeStorage；禁日志明文 |
| 监听非 localhost | 高（可控） | 文档强制建议 127.0.0.1；状态页提示 |
| ToS / 合规 | 产品层 | 自托管声明；不内置共享号池 |

**结论：** 工程风险中等偏低，不阻塞 MVP；安全与合规用产品边界与本地存储策略覆盖。

---

## 8. MVP 里程碑（实现阶段参考）

1. **骨架：** Electron + React 空壳、IPC、打开文件夹  
2. **引擎接通：** Agent SDK 单会话流式聊天  
3. **工具与权限：** 工具卡片 + 权限弹窗  
4. **Diff：** Edit/Write 变更面板  
5. **会话：** 列表 / resume  
6. **CPA：** 启停 + 模型切换 + 状态灯  
7. **打磨：** 错误态、设置页、打包安装（Windows）

---

## 9. 测试策略（规格级）

- **单元：** DiffTracker 对 Edit/Write fixture 的 hunk 输出；权限规则匹配  
- **集成：** mock SDK 事件流 → UI 状态；CpaSupervisor 端口探测（可 mock）  
- **手工：** 真实项目下改文件、拒绝权限、CPA 关闭时的提示、模型切换后新 turn  

---

## 10. 开放问题（实现前可默认）

下列项规格已给默认值；实现计划可采用，除非审查时推翻：

1. 会话标题：首条用户消息截断 40 字  
2. 默认权限模式：`default`  
3. `shutdownCpaOnQuit` 默认：`false`  
4. 包管理器：实现时选 pnpm  
5. 新仓库路径：由用户在实现前指定（建议 `D:\gitrep\claude-desktop`）

---

## 11. 参考

- 本地 CPA：`D:\gitrep\CC\CPA`（`cli-proxy-api.exe`、`config.yaml`、`claude-cpa.ps1`）
- Claude Agent SDK 文档：https://code.claude.com/docs/en/agent-sdk/overview.md
- Headless CLI：https://code.claude.com/docs/en/headless.md
- 头脑风暴视觉稿：`.superpowers/brainstorm/298-1785640386/content/`
