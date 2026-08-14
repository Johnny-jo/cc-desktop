# 第三方作品与引用声明 / Third-Party Notices

本仓库**只对本项目自行编写的客户端源码**主张权利。下列名称、产品、协议、二进制与商标**不属于**本项目原创，也不因出现在本仓库或文档中而改属本项目。

This repository only claims rights in **original client source written for this project**. Names, products, protocols, binaries and trademarks listed below are **not** original works of this project.

---

## 1. 官方产品关系（必须先读）

| 名称 | 权利人（据公开信息） | 与本项目的关系 |
|---|---|---|
| Claude / Claude Code / Claude Agent SDK | Anthropic, PBC | 本项目是**非官方**桌面壳，通过公开 npm 包 `@anthropic-ai/claude-agent-sdk` 驱动会话；**不是** Anthropic 出品，未获官方背书 |
| Codex / ChatGPT 桌面交互风格 | OpenAI, Inc. | 本项目 UI **参考了** Codex 一类桌面客户端的三栏布局与深色观感；**没有**复制其专有源码、资源或商标授权 |
| CLIProxyAPI（CPA / `cli-proxy-api`） | Router-For.ME 等（见上游仓库） | **MIT 许可**（`D:/gitrep/CC/CPA/LICENSE`）。本机模型网关；按 MIT 使用、拷贝、修改、分发，需保留其版权与许可声明。**不是**本仓库原创 |
| Electron / Chromium | OpenJS Foundation 等 | 运行时框架 |
| React | Meta Platforms, Inc. | 渲染层 UI 库 |

**本项目不得被表述为：**

- Anthropic、OpenAI 或任何模型供应商的官方客户端
- 对 Claude Code / Codex 的破解、盗版或去授权发行
- 对第三方商标、图标、品牌资产的再授权

使用 Claude、各模型 API、CPA 时，你必须另行遵守对应服务商的服务条款与计费规则。本仓库**不提供**账号、密钥，也**不替代**那些条款。

---

## 2. 本仓库直接依赖（npm，安装时按各包 LICENSE 生效）

下列均为常见开源许可下的独立作品。`pnpm install` 会把它们的原文 LICENSE 装到 `node_modules`。**本项目的「禁止商用」条款不能覆盖、缩小或替换这些依赖自己的许可。**

| 包 | 用途 | 常见许可（以包内 LICENSE 为准） |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 会话 / 工具 / 权限循环 | 见该包 LICENSE（Anthropic） |
| `electron` / `electron-builder` / `electron-vite` / `electron-updater` | 桌面壳与打包、热更新 | MIT 等 |
| `react` / `react-dom` | UI | MIT |
| `react-markdown` / `remark-gfm` | Markdown 渲染 | MIT |
| `@codemirror/*` / `@lezer/highlight` | 文件编辑器 | MIT |
| `@xterm/xterm` / `@xterm/addon-fit` | 终端与 CLI 模式 TUI 承载 | MIT |
| `node-pty` | PTY | MIT |
| `ws` | 协作房间 WebSocket | MIT |
| `iconv-lite` | 文本编码 | MIT |
| `vitest` / `typescript` / `vite` | 开发与测试 | MIT |

完整清单以 `apps/desktop/package.json`、`packages/shared/package.json` 与 lockfile 为准。

---

## 3. 打包时可能附带、但**不是**本仓库源码的二进制

`vendor/` 被 `.gitignore` 忽略，**默认不会进 git**。若你在本地执行 `pnpm prepare:vendor` / `pnpm package:win`，安装包里可能出现：

| 文件 | 来源 | 说明 |
|---|---|---|
| `claude.exe`（Claude Code CLI） | Anthropic Agent SDK 平台包或本机 vendor 拷贝 | **第三方可执行文件**。再分发该 exe 必须单独满足 Anthropic 对其 CLI/SDK 的许可；本仓库 LICENSE **管不到**它 |
| `cli-proxy-api.exe`（CPA） | 本机 CPA 发行目录（如 `CLAUDE_DESKTOP_CPA_DIST`） | **第三方可执行文件**。再分发必须满足 CPA 上游许可 |
| `config.template.yaml` | 本仓库跟踪的占位模板 | 不含真实密钥；真实 `config.yaml` / token **禁止**提交 |

`scripts/prepare-vendor.mjs` 有意禁止拷贝 `config.yaml`、`.env`、凭证文件。

**不要把 `vendor/`、`release/`、用户 token、CPA 真配置推到 GitHub。**

---

## 4. 设计与文档上的「参考」而非「抄袭源码」

- 交互布局（会话列表 / 对话 / 变更栏）参考了公开可见的 Codex 类桌面产品形态。
- 权限文案、斜杠命令、rewind、CLI `--resume` 等行为对齐的是 **Claude Code / Agent SDK 已公开的能力与文档**，实现写在本仓库 TypeScript 中。
- 文档目录 `docs/superpowers/` 是本项目自己的规格与计划，不是官方文档镜像。

若权利人认为某段 UI 文案或资源构成侵权，请开 Issue 或联系维护者，我们会删除或替换对应部分。

---

## 5. 商标

「Claude」「Anthropic」「Codex」「ChatGPT」「OpenAI」等是各自权利人的商标。本文件中的使用仅为指称对应产品，不表示赞助、从属或授权。

---

## 6. 免责声明与风险规避

**以下条款用于降低第三方权利主张风险，不构成「本项目不可能侵权」的法律保证。**

1. **非官方标识。** 本项目名称、图标、界面文案均使用自有中性品牌「CC Desktop」，不使用 Claude / Anthropic / OpenAI / Codex 的商标、logo 或品牌资产作为产品标识。界面中出现的「Claude Code」「Claude」等字样仅用于指称被驱动的外部工具与 API，属于指示性使用，不表示隶属或授权。

2. **自有实现。** 本仓库源码为独立编写的 TypeScript / React / Electron 客户端，不包含 Claude Code、Codex、CPA 的专有源码。权限规则、斜杠命令、rewind、CLI `--resume` 等行为对齐的是 Claude Code / Agent SDK 已公开的能力与文档。

3. **第三方二进制不随源码分发。** `vendor/` 下的 `claude.exe`（Claude Code CLI）与 `cli-proxy-api.exe`（CPA）默认不进 git。若自行打包，再分发这些 exe 必须单独满足其上游许可（CPA 为 MIT；Claude CLI 需核对 Anthropic 当前条款）。本仓库 LICENSE 不覆盖这些二进制。

4. **用户自备凭据。** 本项目不提供 Claude / 模型 API 账号，不组织共享账号。使用任何模型服务时，用户应自行遵守对应服务商的条款、计费与出口管制要求。

5. **侵权处理。** 若任何权利人认为本项目某段代码、UI 文案或资源构成侵权，请通过 GitHub Issue 或项目联系方式提出。核实后我们会及时删除、替换或获得授权。

6. **法律意见提示。** 本文件不是法律意见。若计划将本项目用于商业场景、大规模分发或嵌入产品，请咨询专业律师。
