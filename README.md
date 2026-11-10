# CC Desktop

一个面向 Windows 的非官方 Claude Code 桌面客户端。它把 Claude Agent SDK、真实的 Claude Code CLI、代码工作区和应用自有的 Provider 账号与模型接入整合到同一个 Electron 应用中。

> **非官方项目**：本项目与 Anthropic、OpenAI 或 CLIProxyAPI 没有隶属、赞助或授权关系，也不提供任何模型账号。

当前主线版本：`0.3.5`

## 为什么做 CC Desktop

Claude Code 的能力很强，但纯终端工作流不适合所有场景：会话历史不易浏览，文件改动难以追踪，模型切换和多人协作也缺少统一界面。CC Desktop 试图保留 Claude Code 的 Agent 能力，同时提供可视化的桌面工作区：

- 会话、对话和文件变更分栏展示
- 直接查看、编辑、搜索和回滚项目文件
- 桌面界面与原生 Claude Code TUI 之间快速切换
- 管理各家 API Key 与 OAuth 账号，直接同步上游模型目录
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

### Provider 账号与模型接入

- 支持 Claude、OpenAI、DeepSeek、Kimi、xAI、Gemini 和 OpenAI 兼容 API
- Claude、ChatGPT/Codex 和 Google OAuth 由应用管理授权、取消、加密保存和刷新；Claude 支持粘贴完整回调或 `code#state`
- Google OAuth 需要用户自有 Google Desktop 客户端和已启用 Generative Language API 的 Cloud 项目，使用项目 API 配额
- 从上游模型目录同步模型，模型标识带 Provider 前缀，避免多个账号的同名模型混用凭证
- 内置本机环回服务将 Claude Agent SDK 的 Messages 请求转换为对应上游协议，支持文本、图片、工具调用和流式响应；不启动 CPA
- 桌面选择与 Claude Code TUI 的 `/model` 选择互相同步
- 展示模型目录公开的上下文窗口及用户覆盖值；没有通用上游用量接口时不显示虚构的计费额度
- Provider 仪表盘记录本地推理请求实际返回的 token 和结果，展示近 24 小时、7 天、30 天用量与成功率曲线，并支持按账号筛选；数据在本地 SQLite 保存，重启后保留
- 成功率不包含用户取消；缓存与非缓存输入分开统计，失败/取消的未上报用量不估算。统计启用前的历史不会补造

账号凭证不会被提交到仓库或复制进发布包。旧 CPA 配置保留在本机供用户自行迁移，新版运行时不读取其中的账号。OpenAI/Claude 的订阅授权使用第一方原生客户端兼容流程；当前尚未注册 CC Desktop 自有 OAuth 身份，真实账号授权与权限仍需登录验证。

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
- 在「设置 → 操控」分别开启 Chrome、Edge 或 Windows 桌面应用，保存后可在会话中使用。浏览器的「管理」支持选择日常浏览器或独立配置。桌面接管期间四周会出现呼吸柔光，黑色虚拟鼠标指示操作位置，按 Esc 可退出本次接管。
- 操作以管理员身份运行的窗口时，普通权限的 CC Desktop 会按需请求 Windows UAC。核对窗口授权框中的程序路径和标题后确认，AgentOS 会对该窗口重新观察并执行点击。释放控制或按 Esc 后，本次窗口授权结束。
- 受控网页右上角显示「AgentOS 正在控制中」，虚拟光标会移动到 Agent 的点击位置。在任一受控标签页点击「取消控制」可中断当前浏览器操作，并停止此连接后续的操作。页面保留，可继续手动使用。
- Mod Kernel 提供共享记忆、群词典、入站守卫、心跳等房间扩展
- 中文、English、跟随系统
- 浅色、深色、跟随系统主题
- 会话快速定位、滚动到底部和上下文用量

## 应用结构

```text
apps/desktop/
├── electron/main/       # Electron 主进程：SDK、CLI、Provider、SQLite、房间和 IPC
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
- Node.js `>=22.13.0`，推荐使用仓库 `.nvmrc` 中的版本
- pnpm `9.15.0`
- Claude Code：开发时可使用本机 SDK/`claude.exe`；发布包需准备对应二进制
- 当前配套版本：Claude Code `2.1.318` / Agent SDK `0.3.318`，固定记录在 `scripts/claude-release.json`

## 开发启动

```bash
git clone <this-repo>
cd claude-desktop
pnpm install
pnpm prepare:vendor
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

首次启动后，在引导页或「设置 → Provider 管理」添加 API Key 或 OAuth 账号。连接成功后模型会进入聊天选择器，再打开项目开始对话。无需配置独立代理地址或网关口令。

单独更新项目内的 Claude 可执行文件：

```powershell
pnpm install --frozen-lockfile
pnpm prepare:vendor:claude
pnpm verify:vendor:claude
```

准备脚本只取当前 SDK 对应的 Windows 包，打包前核对 SDK/CLI 版本和二进制 SHA256，
避免 pnpm 缓存中的旧版本被再次打入安装包。升级版本时同步修改 SDK 精确依赖、
`scripts/claude-release.json` 和锁文件，随后重启桌面主进程。

## PDF 本地 OCR 与图片缓存

DeepSeek 的 PDF 兼容链路先提取原文字层，再对扫描页、损坏文字层或带图片的短文字页
执行 PP-OCRv5 mobile 本地 CPU 识别。结果保留页码、OCR 来源和低置信度提示。
模型和字典随应用打包，按需加载，解析子进程空闲 60 秒释放；无需 Python 或 GPU。
单 PDF 限制 10 MiB、200 页、提取后 30 万字符，整份处理最长 5 分钟。
Claude 直连保留原生文档内容，DeepSeek 走上述文本/OCR 兼容链路。其他协议适配器目前会对未支持的文档块明确报错；图片与截图工具结果已支持。OCR 不等同于表格结构或图表理解。

- 日间照片流缓存：`<userData>/photo-flow/`，JPG 与 `manifest.json`，上限 48 张 / 20 MiB。
- 粘贴截图：`<temp>/cc-desktop-clipboard/`。
- 群聊附件：`<userData>/room-attachments/`；单聊选择文件保留原路径引用。
- OCR 渲染页面仅在内存中处理，不新增磁盘图片缓存。

Windows 当前开发版 `userData` 为 `%APPDATA%/@claude-desktop/desktop`。
修改 OCR/主进程代码后需要重启 `pnpm dev`。验证命令：

```powershell
pnpm --filter @claude-desktop/desktop build
pnpm --filter @claude-desktop/desktop dist:dir
node scripts/verify-pdf-runtime.mjs
node scripts/verify-pdf-model.mjs
```

最后一条使用当前已配置的 CPA / DeepSeek，仅发送合成扫描 PDF。

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

先执行 `pnpm download:cpa` 下载固定版本的后端和管理页；默认从 `tools/cpa/8.0.43` 准备。打包前会拒绝低于 v8 的程序或缺少 v8 管理页的目录。若使用其他 v8 发行目录，可指定：

```powershell
$env:CLAUDE_DESKTOP_CPA_DIST = 'D:\path\to\CLIProxyAPI'
pnpm package:win:cpa
```

只想跳过某个可选二进制时，可以使用 `SKIP_CPA=1` 或 `SKIP_CLAUDE=1`。跳过 Claude 会使 CLI 模式不可用；跳过 CPA 会使 CPA 模型路由不可用。注意：这两个变量仍会先清空整个 `vendor/`，只更新 CPA 时请用 `package:win:cpa`，不要用 `SKIP_CLAUDE=1`。

换 CPA 二进制前请先退出 CC Desktop，并停掉正在跑的 `cli-proxy-api.exe`，否则 Windows 会锁住 exe，拷贝失败。

准备脚本**只复制** `cli-proxy-api.exe`、仓库里的 `config.template.yaml` 和配套 `static/management.html`，拒绝复制本机 `config.yaml`、凭据、Token。首次启动生成 v8 配置；已有配置只修复管理页开关和空管理密钥，不覆盖非空密钥或供应商配置。管理页随应用同步，关闭独立自动更新。请在目标机器上完成实际登录和配置，不要把本地 `vendor/`、用户数据或发布目录提交到 Git。

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
