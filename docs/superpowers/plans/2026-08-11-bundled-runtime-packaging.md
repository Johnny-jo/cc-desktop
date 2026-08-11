# 规划：内嵌 Claude Code + CPA，开箱可用打包

> 日期：2026-08-11  
> 目标：用户**不必单独安装** Claude Code CLI 与 CPA；下载后「解压即用」或「安装后即用」。  
> 范围：Windows x64 优先（当前主力平台）。

---

## 1. 现状（问题根因）

| 依赖 | 今天怎么来 | 打包缺口 |
|---|---|---|
| **Electron 应用本身** | `electron-vite build` + `electron-builder --win dir` → `apps/desktop/release/win-unpacked/` | 已能出解压目录，**未**带外部二进制 |
| **Claude Code 本体** | Agent SDK 的 optional 平台包 `@anthropic-ai/claude-agent-sdk-win32-x64` 内含 `claude.exe`（约 **254MB**）。开发时由 SDK 从 `node_modules` 解析 | `electron-builder.yml` 的 `files` 只收 `out/**`，**不保证**平台包进包；也未设 `pathToClaudeCodeExecutable` |
| **CPA** | 设置默认硬编码本机路径 `D:\gitrep\CC\CPA\cli-proxy-api.exe` + `config.yaml`（exe 约 **62MB**） | 完全依赖本机外置安装 |
| **CPA 凭证** | `config.yaml` 的 `auth-dir` → 用户目录 `~/.cli-proxy-api`，`api-keys` 为网关口令 | 可执行文件可内嵌，**上游模型登录态**仍是用户数据，不能（也不应）写死进安装包 |

结论：  
- **「Claude 本体」= 打进包的 `claude.exe`（SDK 自带）**  
- **「CPA」= 打进包的 `cli-proxy-api.exe` + 模板配置**  
- **「无需额外安装」≠ 零配置**：首次仍需在 App 里填 **CPA 口令 / 上游模型凭证**（或沿用已有 `~/.cli-proxy-api`）

---

## 2. 目标形态（推荐）

### 2.1 交付物（两阶段）

| 阶段 | 产物 | 用户体验 |
|---|---|---|
| **MVP（先做）** | **便携包** `Claude-Desktop-portable-win-x64.zip` | 解压 → 双击 `Claude Desktop.exe` → 首次设置向导 |
| **下一阶段** | **NSIS 安装包** `.exe` | 安装到 Program Files，开始菜单快捷方式，卸载干净 |

同一套 `resources/` 布局，两种外壳共用。

### 2.2 安装目录布局（关键）

```
Claude Desktop/
├── Claude Desktop.exe          # Electron 壳
├── resources/
│   ├── app.asar                # 主进程/渲染进程代码
│   └── bin/                    # ★ 外置二进制（禁止进 asar）
│       ├── claude/
│       │   └── claude.exe      # Agent SDK win32-x64 原生 CLI（~254MB）
│       └── cpa/
│           ├── cli-proxy-api.exe
│           └── config.template.yaml   # 模板（host/port/api-keys 占位）
└── ...
```

运行时解析：

```ts
// 打包后
process.resourcesPath + "/bin/claude/claude.exe"
process.resourcesPath + "/bin/cpa/cli-proxy-api.exe"
// 开发时
repo 内 vendor/ 或 node_modules 平台包路径
```

用户可写数据仍在：

```
%APPDATA%/Claude Desktop/     # settings.json（含加密 token）、sessions、snapshots
%USERPROFILE%/.cli-proxy-api/ # CPA 上游模型 auth（与官方 CPA 一致，可复用已有登录）
```

---

## 3. 架构改动（应用侧）

### 3.1 路径解析模块（新建）

`apps/desktop/electron/main/runtime-paths.ts`：

- `isPackaged = app.isPackaged`
- `getClaudeExecutablePath()`
- `getCpaExecutablePath()`
- `getCpaConfigPath()` — **可写副本**在 `userData/cpa/config.yaml`（首次从 template 拷贝）
- 开发模式回退：`node_modules/.../claude.exe` 与 settings / env 覆盖

### 3.2 SessionManager

`buildOptions` 增加：

```ts
pathToClaudeCodeExecutable: getClaudeExecutablePath()
```

避免依赖 PATH 上的全局 `claude`。

### 3.3 CpaSupervisor / Settings 默认值

- 打包态默认 `cpaExePath` / `cpaConfigPath` 指向上述 runtime paths  
- **覆盖策略**：用户在 Settings 里改过路径则尊重用户值；否则用内嵌路径  
- `host` 模板强制 `127.0.0.1`；`port` 默认 `8317`  
- `api-keys`：首次向导生成随机口令写入 userData config，并同步进 App 的加密 token（或让用户粘贴）  
- `auth-dir`：默认 `~/.cli-proxy-api`（复用已有 CPA 登录）；可选「使用应用内 auth-dir」

### 3.4 electron-builder

`electron-builder.yml` 增量：

```yaml
asar: true
asarUnpack:
  # 若 SDK 仍从 asar 内 require 平台包，可 unpack；更稳的是 extraResources 拷贝
extraResources:
  - from: vendor/win-x64/claude
    to: bin/claude
  - from: vendor/win-x64/cpa
    to: bin/cpa

win:
  target:
    - target: dir      # 便携
    # - target: nsis  # 第二阶段
```

### 3.5 构建脚本 `scripts/prepare-vendor.mjs`

打包前一步（`pnpm package:win` 的 pre）：

1. 从 `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` 拷到 `vendor/win-x64/claude/`  
2. 从可配置源拷贝 CPA：  
   - env `CPA_DIST_DIR` 或  
   - 默认 `D:/gitrep/CC/CPA`（本机）或 CI artifact  
3. 生成 `config.template.yaml`（**不要**提交含真实 api-key / secret 的 config）  
4. 校验文件存在 + 体积阈值

### 3.6 首次运行向导（UI，可后置）

最小闭环：

1. 检测 CPA 是否 ready  
2. 若无 token → Settings 引导输入「网关口令」  
3. 若 CPA `/v1/models` 空或失败 → 提示配置上游凭证（打开 auth-dir 说明 / 文档链接）  
4. 不再要求用户手填 exe 路径

---

## 4. 明确「什么被打包 / 什么不打包」

| 项目 | 打包？ | 说明 |
|---|---|---|
| Electron + 应用代码 | ✅ | asar |
| `claude.exe` | ✅ | ~254MB，版本与 SDK 对齐 |
| `cli-proxy-api.exe` | ✅ | ~62MB，版本钉死并记 changelog |
| CPA 模板 config | ✅ | 无密钥 |
| CPA 上游模型 cookie/token（auth-dir） | ❌ | 用户私有；可复用已有 `~/.cli-proxy-api` |
| 全局 `claude` npm CLI 安装 | ❌ 不需要 | 用内嵌 exe |
| 用户 Node 环境 | ❌ 不需要 | Electron 自带 runtime |

体积粗估：Electron 壳 ~150–200MB + claude 254MB + CPA 62MB ≈ **500MB+** 安装/解压目录，可接受（便携 zip 可压到更小）。

---

## 5. 实施任务拆分（建议顺序）

### Phase A — 路径与开发态兼容（1–2 天）

1. `runtime-paths.ts` + 单测（packaged / dev 分支用 mock `app.isPackaged`）  
2. SessionManager 传 `pathToClaudeCodeExecutable`  
3. Settings 默认路径：packaged → resources；dev → 现有逻辑 / vendor  
4. CpaSupervisor 使用解析后的 exe/config，userData 下 materialize config

### Phase B — vendor 与 builder（1 天）

1. `scripts/prepare-vendor.mjs`  
2. `vendor/win-x64/**` 进 `.gitignore`；CI/本机 prepare 生成  
3. `electron-builder.yml` `extraResources`  
4. `package.json` scripts：

```json
"package:win": "pnpm prepare:vendor && electron-vite build && electron-builder --win dir",
"package:win:zip": "pnpm package:win && ... zip win-unpacked"
```

### Phase C — 开箱体验（1–2 天）

1. 首次启动：内嵌 CPA 自动拉起，无需填 exe  
2. 缺 token / 模型时的清晰错误与 Settings 深链  
3. README：便携包用法；「无需安装 Claude Code / CPA」说明  
4. 可选：NSIS（图标、安装目录、卸载删 app 不删 userData）

### Phase D — 硬化（按需）

1. 版本矩阵：SDK 版本 ↔ claude.exe 版本 ↔ CPA 版本锁文件 `vendor/manifest.json`  
2. 启动自检页 `/doctor`：三件套路径、端口占用、claude -v、CPA /health  
3. 代码签名（当前 `signAndEditExecutable: false`）  
4. macOS/Linux 同构（平台包 + 对应 CPA 二进制）

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `claude.exe` 在 asar 内无法 spawn | **必须** `extraResources` 或 `asarUnpack`，spawn 绝对路径 |
| Windows 杀软拦截未签名 exe | 文档说明；后续 EV 签名；SmartScreen 提示 |
| CPA config 含本机绝对路径 | 模板 + userData 渲染，禁止打进真实 config.yaml |
| 上游模型凭证缺失导致「装了仍不能聊」 | 首次向导 + 复用 `~/.cli-proxy-api`；文案区分「运行时已内嵌」vs「模型账号需登录」 |
| 体积大 | 便携 zip；不重复打多平台；可选「精简包不含 CPA」（不推荐默认） |
| SDK 升级后 exe 不匹配 | prepare-vendor 从同版本 optionalDependency 取；CI 校验 version |

---

## 7. 推荐默认决策（请确认）

1. **交付形态**：先 **便携 zip**（解压即用），NSIS 安装包第二阶段  
2. **Claude**：固定内嵌 SDK 自带 `claude.exe`，**不**依赖用户 PATH  
3. **CPA**：内嵌 exe + 模板 config；`auth-dir` 默认复用用户已有 `~/.cli-proxy-api`  
4. **Token**：仍在 App Settings 加密存储，作为 CPA `api-keys` 客户端口令  
5. **平台**：先 **win-x64 only**

---

## 8. 验收标准

- 干净 Windows 机器（无全局 `claude`、无手装 CPA）解压便携包后：  
  - 能启动 UI  
  - 能自动拉起内嵌 CPA（或提示端口占用）  
  - 配置 token + 已有/新建上游凭证后，能完成一轮对话与工具调用  
- Settings 中 exe 路径在打包态自动正确，无需手填 `D:\gitrep\...`  
- 开发态 `pnpm dev` 行为不回归  

---

## 9. 不在本方案内

- 把上游模型（Kimi 等）账号预置进安装包  
- 跨平台一次性全做  
- 自动更新（electron-updater）— 可后续挂便携/安装包渠道  

---

**下一步**：你确认第 7 节默认决策后，按 Phase A → B → C 开工；若希望「先出能双击的 zip，向导后做」，可把 Phase C 的向导压到最小（只修路径 + 模板 config）。
