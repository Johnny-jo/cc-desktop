# CC Desktop

非官方 Electron 桌面客户端：用三栏界面驱动 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`@anthropic-ai/claude-agent-sdk`），并可在本机挂 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA）做模型路由。

**不是 Anthropic / OpenAI 官方产品，未获官方授权或背书。**

> **许可：** 源码公开，欢迎阅读、学习、非商业研究与个人自用；**禁止商用**。第三方库与 `claude.exe` / CPA 等二进制仍按**各自许可**，见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。

---

## 声明（使用前请读完）

### 开源，但不是「随便怎么用」

| 可以 | 不可以 |
|---|---|
| 阅读、克隆、学习实现 | 出售、收费分发、作为商业 SaaS/内部生产工具盈利 |
| 个人电脑上非商业使用 | 去除本许可或 NOTICE 后再发布 |
| 非商业地改、叉、发 PR | 把本项目说成官方 Claude / Codex 客户端 |
| 引用并保留本许可与 NOTICE | 把本仓库 LICENSE 套到 Anthropic / CPA 的二进制上 |

完整条款见根目录 [LICENSE](./LICENSE)（[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)）。

「源码公开」≠ OSI 意义上无限制的 Open Source（那种允许商用）。这里是：**源码可查 + 明确禁止商业利用**。

### 引用了什么、什么是我们写的

本仓库**主张权利的范围只有：本项目自己写的 TypeScript / React / Electron 客户端代码和文档。**

明确**引用 / 依赖、但不属于本项目原创**的包括：

- **Anthropic** — Claude、Claude Code、Claude Agent SDK、打包时可能附带的 `claude.exe`
- **OpenAI** — Codex 一类桌面交互的**观感参考**（布局与深色风格），无其专有源码
- **CLIProxyAPI（CPA）** — 本机网关 `cli-proxy-api.exe`，**MIT 许可**，由你自己准备或按上游许可分发
- **Electron、React、CodeMirror、xterm.js、node-pty** 等 — 见 `package.json`，各包 LICENSE 在 `node_modules`

详细对照表：[NOTICE.md](./NOTICE.md)。

### 关于「版权 / 侵权」——能讲清楚的边界

请不要把下面几条理解成「本项目已保证不侵权」或「你怎么用都没法律风险」。那不是事实，我们也给不了这种保证。

1. **本客户端源码**按维护者陈述为独立编写，用于学习研究如何把 Agent SDK、本机网关和桌面 UI 接到一起。
2. **第三方代码与二进制**仍归原作者。本仓库不重新授权 Claude Code CLI、不重新授权 CPA、不赠予任何商标。
3. **`vendor/` 默认不进 git。** 不要把 `claude.exe`、CPA 真配置、token、`.env` 推到 GitHub。安装包若含第三方 exe，分发那些 exe 要单独满足上游许可，与本仓库「禁止商用」是两件事，可能更严。
4. 使用模型 API、Claude 账号、CPA 网关时，遵守**服务商自己的条款和计费**。本项目不提供账号、不组织共享账号。
5. 若权利人认为某段 UI、文案或资源有问题，请开 Issue，我们删除或替换。

---

## 安装

### 环境

- Windows 10/11（当前主要支持 Windows）
- Node.js 20+，pnpm 9.15
- 本机 CPA：`cli-proxy-api.exe`（见下文「CPA 网关」）

### 从源码跑（开发）

```bash
git clone <this-repo>
cd claude-desktop
pnpm install
pnpm dev
```

### 打包成安装包（Windows）

```bash
# 1) 把本机 claude.exe + CPA 拷进 vendor/（不进 git）
pnpm prepare:vendor
# 可选：指定 CPA 目录
#   set CLAUDE_DESKTOP_CPA_DIST=C:\path\to\CPA

# 2) 构建 + electron-builder（dir + NSIS）
pnpm package:win
```

产物在 `apps/desktop/release/`：

- 便携版：`win-unpacked/`
- 安装包：`CC-Desktop-Setup-<version>-x64.exe`

**再分发安装包前，请自行确认其中的 Claude CLI / CPA 二进制是否允许你那样分发**（不在本仓库 LICENSE 覆盖范围内）。

---

## 启动与首次配置

1. **打开应用**。首次会弹出三步向导：欢迎 → 网关 Token → 确认并启动。
2. **网关 Token**：本地 CPA 的 api-key / 管理页密码。本机加密保存，**只留在主进程**，不进渲染进程。
3. **CPA 路径**：默认自动解析内嵌路径；也可以自己指定 `cli-proxy-api.exe` 和 `config.yaml`。
4. **端口**：默认 `8317`。
5. 完成后可勾选「立即启动 CPA」。

如果之前已经装过 CPA 并登录过上游模型，`~/.cli-proxy-api` 里的凭证可直接复用。

---

## 使用

### 必须做的事

1. **打开项目文件夹**  
   侧栏顶部「Open folder」选一个目录作为 Agent 的工作区（cwd）。不选项目也能聊天，但文件树 / 变更栏 / @ 文件补全都不会工作。

2. **同步模型列表**  
   新安装默认**不带**任何模型。Settings →「从 CPA 同步模型」从 `http://127.0.0.1:<port>/v1/models` 拉取。也可以手填「模型列表（逗号分隔）」。

3. **选默认模型**  
   Settings →「默认模型」。切换后**下一轮**生效（进行中的回复不会热切换）。

### CPA 网关（推荐 OpenAI 兼容接入）

CPA 把不同厂商的模型统一成 OpenAI 兼容接口。推荐在 CPA 里配置上游时走 **OpenAI 兼容** 的 provider + API Key，这样 CC Desktop 只认一种协议。

主进程每轮往 Claude Code 子进程注入：

- `ANTHROPIC_BASE_URL=http://127.0.0.1:<cpaPort>`
- `ANTHROPIC_AUTH_TOKEN=<网关 Token>`
- `ANTHROPIC_MODEL=<当前默认模型>`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

**安全：** CPA 只应绑 `127.0.0.1`；不要把网关暴露到公网；不要在日志里打印 Authorization。

### 对话与变更

- 发消息、流式回复、工具卡片、权限弹窗（Allow once / session / deny）
- 文件树 / 多标签编辑（CodeMirror）/ @ 文件路径补全
- 变更栏：按文件折叠的 Edit/Write/Bash 写操作，可单步回滚或全部回滚
- 消息级 rewind：鼠标悬停用户气泡，回滚代码 + 对话到那一条

### CLI 模式

标题栏切换 CLI 模式（或 `Ctrl+Shift+L`）：

- 左侧会话栏、右侧变更栏仍可打开
- 中间是真正的 `claude --resume` TUI（PTY + xterm），不是仿的输入框
- TUI 里 `/model` 与桌面下拉通过 `~/.claude/settings.json` 双向同步
- 进 CLI 会放开桌面 SDK 流，避免和 TUI 抢同一条会话

### 协作房间

局域网内多人共用一个 Agent 会话：

1. **创建房间**：侧栏「房间 → 创建房间」，填名称、端口（默认 18765）、可选密码。
2. **邀请**：房主点「邀请」，复制 `CDR1.` 开头的邀请码发给对方。
3. **加入**：对方在「房间 → 加入房间」粘贴邀请码。防火墙需放行该 TCP 端口。
4. **席位**：每个席位可以是人或 Agent；成员也能加自己的席位；可「接管」Agent 席位。
5. **游戏**：掷骰子、石头剪刀布。
6. **房主退出即解散房间**；客人断线最多重连 3 次。

房间记录落盘在 `userData/rooms/`，房主退出会通知成员。

### 多语言

Settings →「语言 / Language」：跟随系统 / 中文 / English。保存后主要界面切换。

### 更新

- 打包时可通过 `CLAUDE_DESKTOP_UPDATE_URL` 指定更新源；Settings 里也可填「更新源」。
- **不要把更新源指向不可信的公网地址。** 留空则不检查更新。
- 更新只替换程序文件，不覆盖 CPA 配置 / 设置 / 会话。

---

## 仓库结构

```
.
├── apps/desktop/          # Electron 主进程 + React 渲染进程
├── packages/shared/       # 跨进程类型与 IPC 契约
├── docs/                  # 规格与实现计划
├── scripts/               # prepare-vendor、图标、latest.yml
├── LICENSE                # 本项目源码许可（禁止商用）
└── NOTICE.md              # 第三方归属（必读）
```

`vendor/`、`release/`、`.tmp/`、用户配置**不要提交**。

---

## 开发命令

```bash
pnpm install      # 安装依赖
pnpm dev          # Electron + Vite
pnpm test         # 全仓测试
pnpm typecheck    # 全仓类型检查
pnpm build        # 构建
pnpm package:win  # 打包（含 prepare:vendor）
```

---

## 文档

- 设计规格：`docs/superpowers/specs/`
- 实现计划：`docs/superpowers/plans/`
- 与 Claude Code 的功能差：`docs/feature-gap-vs-claude-code.md`

---

## 贡献

欢迎非商业前提的 Issue / PR（修 bug、文档、学习向功能）。提交即表示你同意以同样的 [LICENSE](./LICENSE) 许可你的补丁，且补丁为你有权提交的原创或兼容许可作品。
