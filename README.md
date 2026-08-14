# CC Desktop

一个非官方的 Electron 桌面客户端，把 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`@anthropic-ai/claude-agent-sdk`）包装成好用的图形界面，并可挂本机 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA）做模型路由。

**不是 Anthropic / OpenAI 官方产品，未获官方授权或背书。**

## 解决什么问题

Claude Code 本身是个终端 CLI：强，但没有图形界面——看历史对话、管理文件改动、多任务并行、多人共用一个会话都不直观。CC Desktop 把这些搬到桌面：

- 会话太多，终端里翻不动 → 侧栏会话列表 + 分页加载
- 改了哪些文件、能不能回滚 → 变更栏按文件折叠、单步/全部回滚、消息级 rewind
- 想在 CLI 和 GUI 之间切换 → 一键 CLI 模式（真正的 `claude` TUI，不是仿的）
- 局域网里几个人想共用 / 围观一个 Agent → 协作房间（邀请码、席位、接管、小游戏）
- 想用第三方模型 → 本机 CPA 网关统一成 OpenAI 兼容接口

## 功能

- **对话**：流式回复、工具卡片、权限弹窗（Ask/Allow once/Session/Deny）、`/` 斜杠命令、`@` 文件路径补全、拖拽附件
- **变更栏**：Edit/Write/Bash 写操作按文件折叠，可查看 diff、单步回滚或全部回滚
- **消息级 rewind**：回滚代码 + 对话到任意一条用户消息
- **编辑器**：文件树、多标签 CodeMirror 编辑（js/vue/java/py/go/html/md/sql/xml/yml…）、编码切换（UTF-8/GBK…）、项目内搜索（Ctrl+Shift+F）
- **上下文管理**：用量条、接近上限自动压缩、手动 `/compact`
- **会话管理**：主进程累积落盘（渲染崩溃不丢对话）、长对话分页加载
- **模型**：CPA 同步模型列表、下拉切换、TUI `/model` 与桌面双向同步
- **多语言**：中文 / English / 跟随系统（Settings 里切换）
- **其他**：MCP 服务器管理、自定义 Agents、Skills、热更新、深浅主题

## 两种模式

| 桌面模式（默认） | CLI 模式（`Ctrl+Shift+L`） |
|---|---|
| 三栏 UI：会话 / 对话 / 变更 | 卸掉重 UI，只留真 `claude --resume` TUI |
| 文件树 + 多标签编辑器 | 左侧会话栏、右侧变更栏仍可开 |
| 权限弹窗、@ 补全 | 原生 TUI 快捷键、斜杠命令 |
| 占用随会话变重 | 内存显著回落，主进程继续追踪 |

CLI 模式进的是**真正的 Claude Code 终端界面**（PTY + xterm），斜杠命令、权限流都是原生的；进 CLI 会放开桌面 SDK 流，两边不抢同一条会话。

## 安装

### 源码启动（开发）

环境：Windows 10/11、Node.js 20+、pnpm 9.15。

```bash
git clone <this-repo>
cd claude-desktop
pnpm install
pnpm dev
```

### 打包成安装包（Windows）

```bash
pnpm prepare:vendor    # 拷本机 claude.exe + CPA 到 vendor/（不进 git）
pnpm package:win       # 构建 + NSIS
```

产物在 `apps/desktop/release/`：便携版 `win-unpacked/`、安装包 `CC-Desktop-Setup-<ver>-x64.exe`。

## 使用

### 首次配置

1. 首次启动弹出三步向导：欢迎 → 网关 Token → 确认并启动
2. 网关 Token 是本地 CPA 的 api-key / 管理页密码，**只存主进程**
3. 默认端口 `8317`；已有 CPA 登录态（`~/.cli-proxy-api`）可直接复用
4. cli模式 需要额外执行"pnpm prepare:vendor" 命令

### 必须做的事

1. **打开项目文件夹**（侧栏顶部）——不选项目就没有文件树 / 变更栏 / @ 补全
2. **同步模型列表**——新安装默认不带模型：Settings →「从 CPA 同步模型」，或手填列表
3. **选默认模型**——切换后下一轮生效

### CPA 网关（推荐 OpenAI 兼容接入）

CPA 把不同厂商模型统一成 OpenAI 兼容接口。推荐在 CPA 里用 **OpenAI 兼容** provider + API Key，CC Desktop 只认一种协议。CPA 只应绑 `127.0.0.1`，不要暴露到公网。

### 协作房间

局域网多人共用一个 Agent 会话：

1. 创建：侧栏「房间 → 创建房间」，填名称、端口（默认 18765）、可选密码
2. 邀请：房主点「邀请」，复制 `CDR1.` 邀请码给对方
3. 加入：对方「加入房间」粘贴邀请码（防火墙放行该端口）
4. 席位：人或 Agent，成员可加自己的席位，可接管 Agent
5. 房主退出即解散；客人断线自动重连

### 更新

打包时用 `CLAUDE_DESKTOP_UPDATE_URL` 或 Settings「更新源」指定；**留空 = 不检查更新**。不要把更新源指向不可信的公网地址。更新只替换程序文件，不动 CPA 配置 / 设置 / 会话。

## 开发命令

```bash
pnpm install      # 安装依赖
pnpm dev          # Electron + Vite
pnpm test         # 全仓测试
pnpm typecheck    # 类型检查
pnpm package:win  # 打包
```

## 仓库结构

```
.
├── apps/desktop/          # Electron 主进程 + React 渲染进程
├── packages/shared/       # 跨进程类型与 IPC 契约
├── docs/                  # 规格与实现计划
├── scripts/               # prepare-vendor、latest.yml
├── LICENSE                # Apache License 2.0
└── NOTICE.md              # 第三方归属
```

`vendor/`、`release/`、用户配置不要提交。

## 许可与声明

本项目源码以 **[Apache License 2.0](./LICENSE)** 发布——可自由使用、修改、分发（包括商用），需保留著作权与许可声明。作者保留本项目源码的著作权。

**第三方归属**（详见 [NOTICE.md](./NOTICE.md)）：

- **Anthropic** — Claude / Claude Code / Agent SDK / `claude.exe`，按其自身条款
- **OpenAI** — Codex 类桌面交互仅为观感参考，无其专有源码
- **CLIProxyAPI（CPA）** — MIT 许可，见上游仓库
- **Electron、React、CodeMirror、xterm.js、node-pty** 等 — 各包 LICENSE

**免责**：本项目与 Anthropic / OpenAI 无任何隶属、赞助或授权关系；不提供任何模型账号，使用者需自行遵守各服务商条款；`vendor/` 下的第三方二进制默认不进 git，再分发安装包前请自行确认其许可。若权利人认为某部分内容构成侵权，请开 Issue，我们会删除或替换。按「现状」提供，无任何担保。

## 贡献

欢迎 Issue / PR。提交即表示同意以 [Apache License 2.0](./LICENSE) 许可你的补丁。
