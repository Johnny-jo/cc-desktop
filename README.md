# CC Desktop

一个面向 Windows 的非官方 Claude Code 桌面客户端。它把 Claude Agent SDK、真实的 Claude Code CLI、代码工作区和本机 CLIProxyAPI（CPA）模型网关整合到同一个 Electron 应用中。

> **非官方项目**：本项目与 Anthropic、OpenAI 或 CLIProxyAPI 没有隶属、赞助或授权关系，也不提供任何模型账号。

当前主线版本：`0.3.5`

## 为什么做 CC Desktop

Claude Code 的能力很强，但纯终端工作流不适合所有场景：会话历史不易浏览，文件改动难以追踪，模型切换和多人协作也缺少统一界面。CC Desktop 试图保留 Claude Code 的 Agent 能力，同时提供可视化的桌面工作区：

- 会话、对话和文件变更分栏展示
- 直接查看、编辑、搜索和回滚项目文件
- 桌面界面与原生 Claude Code TUI 之间快速切换
- 从 CPA 同步模型及其真实可用的推理强度
- 在局域网或中继网络中共享 Agent 会话
- 在不丢失历史的前提下限制长会话内存和磁盘增长

## 核心功能

### 桌面对话

- 流式文本和 thinking 展示
- 工具调用卡片与权限流程（允许一次、允许本会话、拒绝等）
- `/` 斜杠命令、`@` 项目路径补全、拖拽附件
- 消息级 rewind：回退代码改动和对话上下文
- 上下文用量显示、接近上限时自动压缩，也可手动执行 `/compact`
- 底部模型选择器：模型和推理强度可在一次操作中切换

### 会话与数据持久化

- 会话由主进程累积落盘，渲染进程重启不会直接丢失对话
- Electron 43+/Node 24 环境优先使用 `node:sqlite` 保存房间、会话、转录和变更数据
- 旧版 JSON 归档可以迁移；SQLite 不可用时保留兼容回退路径
- 长转录采用分页和分块读取，避免打开历史会话时一次性加载全部内容
- 空闲会话会释放 SDK 查询；活跃 SDK 查询数量有上限，重新打开时按需恢复上下文

### 代码工作区

- 项目文件树、多标签 CodeMirror 编辑器
- 常见语言高亮（JavaScript、TypeScript、Vue、Java、Python、Go、HTML、Markdown、SQL、YAML 等）
- UTF-8、GBK 等常见编码读取与保存
- 项目内搜索（`Ctrl+Shift+F`）
- Git 感知的文件变更追踪、逐文件 diff、单项或全部回滚
- 编辑器缓冲区缓存，切换会话或标签页时减少重复读取

### CLI 模式

按 `Ctrl+Shift+L` 可以切换到 CLI 模式。这里运行的是实际的 `claude` TUI，通过 PTY + xterm.js 承载，不是模拟出来的终端界面；`--resume`、斜杠命令、权限交互和原生快捷键仍由 Claude Code 处理。切入 CLI 后，桌面 SDK 流会暂停，避免同一会话被两条执行链同时占用。

### CPA 模型与配额

- 连接本机 CPA 的 OpenAI 兼容端点（默认 `127.0.0.1:8317`）
- 从 CPA `/v1/models` 自动同步模型目录
- 读取模型目录公开的 `reasoning_efforts`、`reasoning_levels` 等字段，按模型显示真实可用的 `low`、`medium`、`high`、`max` 等推理强度；不会根据模型名称写死选项
- 桌面选择与 Claude Code TUI 的 `/model` 选择互相同步
- 配额条显示 CPA 观察到的窗口数据，并可通过订阅凭据主动刷新 Codex、Claude、Kimi、Grok 与 Antigravity 配额；没有真实上游信号时不虚构剩余额度

CPA 的真实账号、API Key 和配置文件不会被提交到仓库，也不会由打包脚本复制进发布包。

### 协作房间

协作房间可以让多人共同查看或操作一个 Agent 会话：

- 创建、加入、邀请和重连；默认端口 `18765`
- 房主/成员/Agent 席位绑定与 presence 状态
- 借用 AI、远程执行、消息流和 thinking 状态同步
- AskUserQuestion 选择弹窗、权限审批、工作区路径保护和 Bash 限制
- 房间消息、成员和变更归档；可打开独立房间窗口
- 局域网直连，也支持自建 relay 或 cloudflared/tunnel 路径
- Electron 与 Node 之间使用 AES-256-GCM 加密房间帧

房间能力适合可信网络和可信成员。中继服务器、邀请链接和工作区权限仍需由部署者自行保护。

### 扩展与界面

- MCP 服务器、Agents、Skills 和可安装 Mod 包
- Mod Kernel 提供共享记忆、群词典、入站守卫、心跳等房间扩展
- 中文、English、跟随系统
- 浅色、深色、跟随系统主题
- 会话快速定位、滚动到底部、上下文用量和 CPA 配额提示

## 应用结构

```text
apps/desktop/
├── electron/main/       # Electron 主进程：SDK、CLI、CPA、SQLite、房间和 IPC
└── src/                  # React 渲染进程：会话、对话、编辑器、设置和房间 UI
packages/shared/         # 跨进程类型、IPC 契约、模型、房间协议和加密
scripts/                 # vendor 准备、发布辅助脚本
docs/                    # 项目规格、实现记录和问题记录
vendor/                  # 本地准备的第三方二进制（不提交）
apps/desktop/release/    # 本地构建产物（不提交）
```

主进程负责敏感配置、模型请求、终端进程、文件系统和数据库；渲染进程通过显式 IPC 契约访问这些能力，避免把凭据和高权限操作直接暴露给页面。

## 环境要求

- Windows 10/11（当前安装包目标为 Windows x64）
- Node.js `>=22.12.0`，推荐使用仓库 `.nvmrc` 中的版本
- pnpm `9.15.0`
- Claude Code：开发时可使用本机 SDK/`claude.exe`；发布包需准备对应二进制
- CPA：需要使用模型路由功能时安装并运行本机 CLIProxyAPI

## 开发启动

```bash
git clone <this-repo>
cd claude-desktop
pnpm install
pnpm dev
```

常用命令：

```bash
pnpm dev
pnpm build
pnpm test
pnpm typecheck
pnpm --filter @claude-desktop/desktop dist:dir
```

首次启动后，在设置或引导页配置 CPA 地址和网关 Token；默认端口是 `8317`。然后打开一个项目文件夹，并从设置中执行“从 CPA 同步模型”。不使用 CPA 时仍可使用本地 Claude Code 能力，但第三方模型目录和 CPA 配额不可用。

## Windows 打包

打包前需要把本机的 Claude CLI 和 CPA 二进制准备到临时 `vendor/` 目录。三条命令用途不同：

| 命令 | 做什么 | 什么时候用 |
|---|---|---|
| `pnpm package:win` | 全量刷新 `claude.exe` + CPA exe，再打 NSIS | 两个二进制都要更新 |
| `pnpm package:win:cpa` | **只换 CPA exe**（保留已有 `claude.exe`），再打包 | 升级 CPA 版本，不动用户配置 |
| `pnpm package:win:app` | 不碰 `vendor/`，只打应用代码 | CPA / Claude 二进制都不用变 |

```bash
pnpm package:win
# 或只更新 CPA 二进制后打包：
pnpm package:win:cpa
```

发布产物位于 `apps/desktop/release/`，包括 `win-unpacked/` 和 NSIS 安装包。

`pnpm --filter @claude-desktop/desktop package:win` 等价于 `package:win:app`：**不会**刷新 CPA。旧的 `vendor/win-x64/cpa/cli-proxy-api.exe` 会原样打进安装包。

默认脚本从 `D:\gitrep\CC\CPA` 查找 CPA。若 CPA 位于其他目录，可指定：

```powershell
$env:CLAUDE_DESKTOP_CPA_DIST = 'D:\path\to\CLIProxyAPI'
pnpm package:win:cpa
```

只想跳过某个可选二进制时，可以使用 `SKIP_CPA=1` 或 `SKIP_CLAUDE=1`。跳过 Claude 会使 CLI 模式不可用；跳过 CPA 会使 CPA 模型路由不可用。注意：这两个变量仍会先清空整个 `vendor/`，只更新 CPA 时请用 `package:win:cpa`，不要用 `SKIP_CLAUDE=1`。

换 CPA 二进制前请先退出 CC Desktop，并停掉正在跑的 `cli-proxy-api.exe`，否则 Windows 会锁住 exe，拷贝失败。

准备脚本**只复制** `cli-proxy-api.exe` 和仓库里的 `config.template.yaml`，会主动拒绝复制本机 `config.yaml`、凭据、Token。安装/升级也不会改用户数据目录里的 `cpa/config.yaml`（首次启动才从模板生成一份）。请在目标机器上完成实际登录和配置，不要把本地 `vendor/`、用户数据或发布目录提交到 Git。

热更新默认关闭（安装包里不带 `app-update.yml`）。用户可在设置里填写更新源；若希望安装包开箱即检查更新，打包时设置：

```powershell
$env:CLAUDE_DESKTOP_UPDATE_URL = 'https://your-feed.example.com/'
pnpm package:win:cpa
```

这会把解析后的地址写入安装包的 `resources/app-update.yml`。未设置时启动不会再报 `ENOENT app-update.yml`。

## 数据位置与安全边界

Electron 用户数据目录中会保存：

- `cc-desktop.sqlite3`：会话、房间、转录和变更归档
- `cpa/config.yaml`：本机 CPA 配置（如由应用管理）
- `rooms/`、扩展缓存和其他运行时缓存

CPA 默认只绑定回环地址；如果自行改成局域网或公网监听，必须额外配置防火墙、认证和访问控制。网关 Token 在主进程中保存，并优先使用 Electron `safeStorage` 加密。项目尚未经过独立安全审计，请只连接自己信任的模型端点和 relay。

## 当前限制

- 本项目仍处于快速迭代阶段，UI、IPC 和归档格式可能发生变化
- CPA 只有在返回模型能力、上游配额响应头或受支持的订阅配额接口时，才能同步对应推理强度或配额；自定义兼容端点缺少这些字段时会显示为空或使用模型默认值
- 旧版 JSON 数据迁移是兼容路径，升级前仍建议备份用户数据目录
- 协作房间的 relay、NAT 穿透和多窗口场景依赖网络环境，建议先在局域网验证

## 许可与第三方声明

本项目源码以 **[Apache License 2.0](LICENSE)** 发布。第三方组件及归属见 [NOTICE.md](NOTICE.md)，包括 Claude Code / Agent SDK、CLIProxyAPI、Electron、React、CodeMirror、xterm.js 和 node-pty 等；它们分别受各自许可和服务条款约束。

本项目不分发模型账号，不保证任何第三方服务持续可用。使用 Claude、CPA、上游模型、relay 或打包二进制时，请自行确认许可、隐私和服务商条款。

## 贡献

欢迎提交 Issue 和 Pull Request。提交代码前请至少运行：

```bash
pnpm typecheck
pnpm test
```

提交补丁即表示你同意按 [Apache License 2.0](LICENSE) 授予相应许可。
