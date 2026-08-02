# Claude Desktop（Codex 感 UI）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建 Windows 优先的 Electron 桌面 App：React 三栏 UI（会话 / 聊天+工具 / Diff）驱动 `@anthropic-ai/claude-agent-sdk`，并轻量集成本机 CPA（CLIProxyAPI）做模型切换。

**架构：** 主进程持有 SessionManager、PermissionBroker、DiffTracker、CpaSupervisor、SettingsStore；渲染进程只做 UI。SDK 在主进程跑 agent 循环；CPA 作为可选本地子进程，通过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 注入。IPC 只传结构化事件，永不传 token。

**技术栈：** Electron · React · TypeScript · Vite · Vitest · `@anthropic-ai/claude-agent-sdk` · pnpm

**规格：** `docs/superpowers/specs/2026-08-02-claude-desktop-codex-ui-design.md`（当前在 `D:\gitrep\ceshi`；实现时复制到新仓库）

**实现根目录（默认）：** `D:\gitrep\claude-desktop`（若用户改路径，全文替换）

---

## 文件结构（将创建）

```
claude-desktop/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  README.md
  packages/
    shared/
      package.json
      tsconfig.json
      src/
        index.ts
        ipc.ts                 # IPC channel 名与 payload 类型
        models.ts              # Session, FileChange, Permission, CpaStatus 等
        diff.ts                # pure: buildUnifiedHunk, aggregateChanges
        permission-rules.ts    # pure: match/allow rules
  apps/
    desktop/
      package.json
      electron.vite.config.ts  # 或 vite + electron-builder 等价配置
      tsconfig.json
      tsconfig.node.json
      index.html
      electron/
        main/
          index.ts             # app ready, 窗口, 组装服务
          ipc-handlers.ts      # 注册所有 ipcMain.handle / on
          session-manager.ts
          permission-broker.ts
          diff-tracker.ts
          cpa-supervisor.ts
          settings-store.ts
          normalize-sdk-event.ts
        preload/
          index.ts             # contextBridge API
      src/
        main.tsx
        App.tsx
        styles.css
        lib/
          desktop-api.ts       # 类型化 window.desktop
        state/
          store.ts             # 轻量 React state（useSyncExternalStore 或 zustand）
        components/
          TopBar.tsx
          SessionList.tsx
          ChatPanel.tsx
          MessageList.tsx
          ToolCard.tsx
          Composer.tsx
          PermissionModal.tsx
          ChangesPanel.tsx
          DiffView.tsx
          StatusDot.tsx
      e2e/                     # 可选手工脚本说明，MVP 不强制 playwright
  docs/
    superpowers/
      specs/
        2026-08-02-claude-desktop-codex-ui-design.md
      plans/
        2026-08-02-claude-desktop-codex-ui.md
```

**测试文件：**

```
packages/shared/src/diff.test.ts
packages/shared/src/permission-rules.test.ts
apps/desktop/electron/main/diff-tracker.test.ts
apps/desktop/electron/main/permission-broker.test.ts
apps/desktop/electron/main/cpa-supervisor.test.ts
apps/desktop/electron/main/normalize-sdk-event.test.ts
apps/desktop/electron/main/settings-store.test.ts
```

---

### 任务 1：初始化 monorepo 与 shared 类型包

**文件：**
- 创建：`D:\gitrep\claude-desktop\package.json`
- 创建：`D:\gitrep\claude-desktop\pnpm-workspace.yaml`
- 创建：`D:\gitrep\claude-desktop\tsconfig.base.json`
- 创建：`D:\gitrep\claude-desktop\.gitignore`
- 创建：`D:\gitrep\claude-desktop\README.md`
- 创建：`D:\gitrep\claude-desktop\packages\shared\package.json`
- 创建：`D:\gitrep\claude-desktop\packages\shared\tsconfig.json`
- 创建：`D:\gitrep\claude-desktop\packages\shared\src\models.ts`
- 创建：`D:\gitrep\claude-desktop\packages\shared\src\ipc.ts`
- 创建：`D:\gitrep\claude-desktop\packages\shared\src\index.ts`
- 复制规格与本计划到 `docs/superpowers/...`

- [ ] **步骤 1：创建目录并 git init**

```bash
mkdir -p /d/gitrep/claude-desktop
cd /d/gitrep/claude-desktop
git init
```

- [ ] **步骤 2：写根 package.json 与 workspace**

`package.json`：

```json
{
  "name": "claude-desktop",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "dev": "pnpm --filter @claude-desktop/desktop dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`pnpm-workspace.yaml`：

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`.gitignore`：

```
node_modules
dist
out
*.log
.DS_Store
.env
.env.*
coverage
release
*.local
.superpowers
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **步骤 3：创建 shared 包骨架**

`packages/shared/package.json`：

```json
{
  "name": "@claude-desktop/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.8.2",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **步骤 4：定义领域模型 `models.ts`**

```ts
export type PermissionMode = "default" | "acceptEdits" | "plan";

export type CpaStatus =
  | { state: "unknown" }
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; port: number; managedByApp: boolean }
  | { state: "error"; message: string };

export type FileChangeStatus = "A" | "M";

export type FileChange = {
  path: string;
  status: FileChangeStatus;
  /** unified diff text for display */
  hunks: string;
  updatedAt: number;
  /** event-level entries newest last */
  events: Array<{
    tool: "Edit" | "Write";
    at: number;
    hunk: string;
  }>;
};

export type ChatRole = "user" | "assistant" | "system";

export type ToolCardState = {
  id: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
  resultPreview?: string;
};

export type ChatItem =
  | { kind: "text"; id: string; role: ChatRole; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; tool: ToolCardState };

export type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  status: "idle" | "running" | "error";
};

export type PermissionRequest = {
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  inputPreview: unknown;
};

export type PermissionDecision =
  | { behavior: "allow"; scope: "once" | "session" }
  | { behavior: "deny"; message?: string };

export type AppSettings = {
  cpaExePath: string;
  cpaConfigPath: string;
  cpaPort: number;
  /** token never sent to renderer in getPublicSettings */
  defaultModel: string;
  models: string[];
  permissionMode: PermissionMode;
  shutdownCpaOnQuit: boolean;
  lastProjectPath?: string;
};

export type PublicSettings = Omit<AppSettings, never> & {
  hasToken: boolean;
};

export type SdkNormalizedEvent =
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "text_done"; sessionId: string; text: string }
  | { type: "tool_start"; sessionId: string; tool: ToolCardState }
  | { type: "tool_end"; sessionId: string; tool: ToolCardState }
  | { type: "user_message"; sessionId: string; text: string }
  | { type: "result"; sessionId: string; ok: boolean; costUsd?: number; error?: string }
  | { type: "raw"; sessionId: string; payload: unknown };
```

- [ ] **步骤 5：定义 IPC 契约 `ipc.ts`**

```ts
import type {
  AppSettings,
  CpaStatus,
  FileChange,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PublicSettings,
  SdkNormalizedEvent,
  SessionSummary,
} from "./models";

export const IPC = {
  projectOpen: "project:open",
  sessionStart: "session:start",
  sessionContinue: "session:continue",
  sessionAbort: "session:abort",
  sessionList: "session:list",
  sessionSelect: "session:select",
  permissionRespond: "permission:respond",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  cpaStart: "cpa:start",
  cpaStatus: "cpa:status",
  modelSet: "model:set",
  // main → renderer (webContents.send)
  sessionEvent: "session:event",
  permissionRequest: "permission:request",
  diffUpdated: "diff:updated",
  cpaStatusEvent: "cpa:status-event",
  sessionUpdated: "session:updated",
  appError: "app:error",
} as const;

export type IpcInvokeMap = {
  [IPC.projectOpen]: { args: [{ path: string }]; result: { path: string } };
  [IPC.sessionStart]: {
    args: [{ prompt: string; cwd?: string }];
    result: { sessionId: string };
  };
  [IPC.sessionContinue]: {
    args: [{ sessionId: string; prompt: string }];
    result: { sessionId: string };
  };
  [IPC.sessionAbort]: { args: [{ sessionId: string }]; result: { ok: boolean } };
  [IPC.sessionList]: { args: []; result: SessionSummary[] };
  [IPC.sessionSelect]: {
    args: [{ sessionId: string }];
    result: { sessionId: string; items: unknown[]; changes: FileChange[] };
  };
  [IPC.permissionRespond]: {
    args: [{ requestId: string; decision: PermissionDecision }];
    result: { ok: boolean };
  };
  [IPC.settingsGet]: { args: []; result: PublicSettings };
  [IPC.settingsSet]: {
    args: [Partial<AppSettings> & { token?: string }];
    result: PublicSettings;
  };
  [IPC.cpaStart]: { args: []; result: CpaStatus };
  [IPC.cpaStatus]: { args: []; result: CpaStatus };
  [IPC.modelSet]: { args: [{ model: string }]; result: { model: string } };
};

export type IpcEventMap = {
  [IPC.sessionEvent]: SdkNormalizedEvent;
  [IPC.permissionRequest]: PermissionRequest;
  [IPC.diffUpdated]: { sessionId: string; changes: FileChange[] };
  [IPC.cpaStatusEvent]: CpaStatus;
  [IPC.sessionUpdated]: SessionSummary;
  [IPC.appError]: { message: string; detail?: string };
  // also permission mode can piggyback via settings
  permissionMode?: PermissionMode;
};
```

`src/index.ts`：

```ts
export * from "./models";
export * from "./ipc";
```

- [ ] **步骤 6：安装依赖并 typecheck shared**

```bash
cd /d/gitrep/claude-desktop
pnpm install
pnpm --filter @claude-desktop/shared typecheck
```

预期：通过（或仅缺 vitest 配置时先只 tsc）

- [ ] **步骤 7：Commit**

```bash
git add -A
git commit -m "chore: init monorepo and shared IPC/models

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 2：纯函数 Diff 工具（TDD）

**文件：**
- 创建：`packages/shared/src/diff.ts`
- 创建：`packages/shared/src/diff.test.ts`
- 修改：`packages/shared/src/index.ts`
- 创建：`packages/shared/vitest.config.ts`

- [ ] **步骤 1：写 vitest 配置**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **步骤 2：编写失败的测试**

```ts
import { describe, expect, it } from "vitest";
import { buildEditHunk, buildWriteHunk, upsertFileChange } from "./diff";
import type { FileChange } from "./models";

describe("buildEditHunk", () => {
  it("builds a unified-ish hunk for old/new strings", () => {
    const hunk = buildEditHunk({
      path: "src/a.ts",
      oldString: "const x = 1;\n",
      newString: "const x = 2;\n",
    });
    expect(hunk).toContain("--- a/src/a.ts");
    expect(hunk).toContain("+++ b/src/a.ts");
    expect(hunk).toContain("-const x = 1;");
    expect(hunk).toContain("+const x = 2;");
  });
});

describe("buildWriteHunk", () => {
  it("marks added file when no previous content", () => {
    const hunk = buildWriteHunk({
      path: "src/new.ts",
      previousContent: null,
      nextContent: "export const a = 1;\n",
    });
    expect(hunk).toContain("new file");
    expect(hunk).toContain("+export const a = 1;");
  });

  it("diffs against previous content when present", () => {
    const hunk = buildWriteHunk({
      path: "src/a.ts",
      previousContent: "a\n",
      nextContent: "b\n",
    });
    expect(hunk).toContain("-a");
    expect(hunk).toContain("+b");
  });
});

describe("upsertFileChange", () => {
  it("aggregates multiple edits on same path", () => {
    const t0 = 1000;
    let map = new Map<string, FileChange>();
    map = upsertFileChange(map, {
      path: "src/a.ts",
      tool: "Edit",
      hunk: "h1",
      at: t0,
      status: "M",
    });
    map = upsertFileChange(map, {
      path: "src/a.ts",
      tool: "Edit",
      hunk: "h2",
      at: t0 + 1,
      status: "M",
    });
    const item = map.get("src/a.ts")!;
    expect(item.events).toHaveLength(2);
    expect(item.hunks).toContain("h2");
    expect(item.status).toBe("M");
  });
});
```

- [ ] **步骤 3：运行测试确认失败**

```bash
pnpm --filter @claude-desktop/shared test
```

预期：FAIL，`buildEditHunk` 未定义

- [ ] **步骤 4：实现 `diff.ts`**

```ts
import type { FileChange, FileChangeStatus } from "./models";

function lineDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  // MVP: naive line walk — good enough for short Edit chunks
  const max = Math.max(oldLines.length, newLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      if (o !== undefined) out.push(` ${o}`);
    } else {
      if (o !== undefined) out.push(`-${o}`);
      if (n !== undefined) out.push(`+${n}`);
    }
  }
  return out.join("\n");
}

export function buildEditHunk(input: {
  path: string;
  oldString: string;
  newString: string;
}): string {
  const body = lineDiff(input.oldString, input.newString);
  return [
    `--- a/${input.path}`,
    `+++ b/${input.path}`,
    "@@",
    body,
  ].join("\n");
}

export function buildWriteHunk(input: {
  path: string;
  previousContent: string | null;
  nextContent: string;
}): string {
  if (input.previousContent == null) {
    const added = input.nextContent
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n");
    return [
      `--- /dev/null`,
      `+++ b/${input.path}`,
      "@@ new file",
      added,
    ].join("\n");
  }
  const body = lineDiff(input.previousContent, input.nextContent);
  return [`--- a/${input.path}`, `+++ b/${input.path}`, "@@", body].join("\n");
}

export function upsertFileChange(
  map: Map<string, FileChange>,
  event: {
    path: string;
    tool: "Edit" | "Write";
    hunk: string;
    at: number;
    status: FileChangeStatus;
  },
): Map<string, FileChange> {
  const next = new Map(map);
  const prev = next.get(event.path);
  if (!prev) {
    next.set(event.path, {
      path: event.path,
      status: event.status,
      hunks: event.hunk,
      updatedAt: event.at,
      events: [{ tool: event.tool, at: event.at, hunk: event.hunk }],
    });
    return next;
  }
  const events = [...prev.events, { tool: event.tool, at: event.at, hunk: event.hunk }];
  // MVP aggregate display: last event hunk + count header
  const hunks = [
    `# ${events.length} change(s) in session (showing latest)`,
    event.hunk,
  ].join("\n");
  next.set(event.path, {
    path: event.path,
    status: prev.status === "A" || event.status === "A" ? "A" : "M",
    hunks,
    updatedAt: event.at,
    events,
  });
  return next;
}

export function changesToArray(map: Map<string, FileChange>): FileChange[] {
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
```

- [ ] **步骤 5：导出并跑通测试**

`index.ts` 增加：`export * from "./diff";`

```bash
pnpm --filter @claude-desktop/shared test
```

预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add packages/shared
git commit -m "feat(shared): pure diff helpers with tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 3：权限规则纯函数（TDD）

**文件：**
- 创建：`packages/shared/src/permission-rules.ts`
- 创建：`packages/shared/src/permission-rules.test.ts`
- 修改：`packages/shared/src/index.ts`

- [ ] **步骤 1：写失败测试**

```ts
import { describe, expect, it } from "vitest";
import {
  isDestructiveBash,
  matchSessionRule,
  type SessionAllowRule,
} from "./permission-rules";

describe("isDestructiveBash", () => {
  it("flags rm -rf", () => {
    expect(isDestructiveBash("rm -rf /tmp/foo")).toBe(true);
  });
  it("allows harmless command", () => {
    expect(isDestructiveBash("ls -la")).toBe(false);
  });
});

describe("matchSessionRule", () => {
  const rules: SessionAllowRule[] = [
    { toolName: "Edit", pathPrefix: "src/" },
    { toolName: "Bash", commandPrefix: "git status" },
  ];

  it("matches Edit under path prefix", () => {
    expect(
      matchSessionRule(rules, {
        toolName: "Edit",
        path: "src/a.ts",
      }),
    ).toBe(true);
  });

  it("rejects Edit outside prefix", () => {
    expect(
      matchSessionRule(rules, {
        toolName: "Edit",
        path: "docs/a.md",
      }),
    ).toBe(false);
  });
});
```

- [ ] **步骤 2：运行确认失败**

```bash
pnpm --filter @claude-desktop/shared test
```

预期：FAIL 模块不存在

- [ ] **步骤 3：实现**

```ts
export type SessionAllowRule = {
  toolName: string;
  pathPrefix?: string;
  commandPrefix?: string;
};

const DESTRUCTIVE =
  /\b(rm\s+-rf|rm\s+-fr|del\s+\/s|format\s+|mkfs\.|Remove-Item\s+-Recurse\s+-Force)\b/i;

export function isDestructiveBash(command: string): boolean {
  return DESTRUCTIVE.test(command);
}

export function matchSessionRule(
  rules: SessionAllowRule[],
  input: { toolName: string; path?: string; command?: string },
): boolean {
  return rules.some((r) => {
    if (r.toolName !== input.toolName) return false;
    if (r.pathPrefix != null) {
      if (!input.path || !input.path.replace(/\\/g, "/").startsWith(r.pathPrefix.replace(/\\/g, "/"))) {
        return false;
      }
    }
    if (r.commandPrefix != null) {
      if (!input.command || !input.command.startsWith(r.commandPrefix)) return false;
    }
    return true;
  });
}

export function ruleFromToolInput(
  toolName: string,
  input: Record<string, unknown>,
): SessionAllowRule {
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    const path = String(input.file_path ?? input.path ?? "");
    const normalized = path.replace(/\\/g, "/");
    const dir = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/") + 1)
      : "";
    return { toolName, pathPrefix: dir || normalized };
  }
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    return { toolName, commandPrefix: command.slice(0, 40) };
  }
  return { toolName };
}
```

- [ ] **步骤 4：导出、测试、commit**

```bash
pnpm --filter @claude-desktop/shared test
git add packages/shared
git commit -m "feat(shared): permission rule matchers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 4：Electron + React 应用骨架

**文件：**
- 创建：`apps/desktop/package.json`
- 创建：`apps/desktop` 下 electron-vite 或等价脚手架文件
- 创建：`electron/main/index.ts`、`preload/index.ts`、`src/main.tsx`、`src/App.tsx`、`src/styles.css`、`index.html`

- [ ] **步骤 1：创建 desktop 包并安装依赖**

`apps/desktop/package.json`（示例，按你选用的 electron-vite 模板微调）：

```json
{
  "name": "@claude-desktop/desktop",
  "version": "0.0.1",
  "private": true,
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@claude-desktop/shared": "workspace:*",
    "@anthropic-ai/claude-agent-sdk": "latest",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "electron": "^34.0.0",
    "electron-vite": "^3.0.0",
    "typescript": "^5.8.2",
    "vite": "^6.0.0",
    "vitest": "^3.0.5"
  }
}
```

```bash
cd /d/gitrep/claude-desktop
pnpm install
```

- [ ] **步骤 2：最小 main 进程窗口**

`electron/main/index.ts`：

```ts
import { app, BrowserWindow } from "electron";
import path from "node:path";

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
```

- [ ] **步骤 3：preload 暴露空 API 壳**

```ts
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@claude-desktop/shared";

const desktop = {
  openProject: (path: string) => ipcRenderer.invoke(IPC.projectOpen, { path }),
  // more methods added in later tasks
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const allowed = new Set(Object.values(IPC));
    if (!allowed.has(channel as never)) return () => {};
    const handler = (_: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);

export type DesktopApi = typeof desktop;
```

- [ ] **步骤 4：React 三栏空壳 UI**

`App.tsx` 渲染：TopBar 占位、左 Sessions、中 Chat、右 Changes。使用 `styles.css` grid：

```css
:root {
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: #0f1419;
  color: #e7ecf3;
}
* { box-sizing: border-box; }
body { margin: 0; }
.app {
  display: grid;
  grid-template-rows: 40px 1fr;
  height: 100vh;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  border-bottom: 1px solid #243041;
  background: #121820;
  font-size: 12px;
}
.main {
  display: grid;
  grid-template-columns: 220px 1fr 360px;
  min-height: 0;
}
.panel {
  border-right: 1px solid #243041;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}
.panel:last-child { border-right: none; }
```

- [ ] **步骤 5：跑 dev 确认窗口出现**

```bash
pnpm dev
```

预期：Electron 窗口打开，三栏布局可见。

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop package.json pnpm-lock.yaml
git commit -m "feat(desktop): electron+react shell with three-pane layout

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 5：SettingsStore（含 token 安全存储）

**文件：**
- 创建：`apps/desktop/electron/main/settings-store.ts`
- 创建：`apps/desktop/electron/main/settings-store.test.ts`

- [ ] **步骤 1：写测试（mock electron safeStorage / app.getPath）**

用 vitest + 注入式 `fs` 根目录，避免真依赖 Electron：

```ts
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "./settings-store";

describe("SettingsStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-settings-"));
  });

  it("persists public settings and keeps token out of public view", () => {
    const store = new SettingsStore({
      userDataDir: dir,
      encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s) => Buffer.from(s, "base64").toString("utf8"),
    });
    store.update({ defaultModel: "kimi-for-coding", token: "secret-token" });
    const pub = store.getPublic();
    expect(pub.defaultModel).toBe("kimi-for-coding");
    expect(pub.hasToken).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("secret-token");
    expect(store.getToken()).toBe("secret-token");
  });
});
```

- [ ] **步骤 2：跑测试失败 → 实现 → 通过**

实现要点：
- 设置文件：`{userData}/settings.json` 只存非密钥字段 + `tokenEnc`
- 默认值：

```ts
const DEFAULTS = {
  cpaExePath: "D:\\\\gitrep\\\\CC\\\\CPA\\\\cli-proxy-api.exe",
  cpaConfigPath: "D:\\\\gitrep\\\\CC\\\\CPA\\\\config.yaml",
  cpaPort: 8317,
  defaultModel: "kimi-for-coding",
  models: ["kimi-for-coding", "k3", "grok-4.5"],
  permissionMode: "default" as const,
  shutdownCpaOnQuit: false,
};
```

- 生产环境 encrypt/decrypt 用 `safeStorage.encryptString` / `decryptString`；不可用时 fallback 拒绝存 token 并记日志

- [ ] **步骤 3：Commit**

```bash
git commit -am "feat(desktop): settings store with encrypted token

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 6：CpaSupervisor

**文件：**
- 创建：`apps/desktop/electron/main/cpa-supervisor.ts`
- 创建：`apps/desktop/electron/main/cpa-supervisor.test.ts`

- [ ] **步骤 1：测试端口探测与 env 构建（mock net + spawn）**

```ts
import { describe, expect, it, vi } from "vitest";
import { CpaSupervisor } from "./cpa-supervisor";

describe("CpaSupervisor", () => {
  it("buildEnv sets anthropic proxy vars", () => {
    const cpa = new CpaSupervisor({
      getSettings: () => ({
        cpaExePath: "x",
        cpaConfigPath: "y",
        cpaPort: 8317,
        defaultModel: "kimi-for-coding",
        models: [],
        permissionMode: "default",
        shutdownCpaOnQuit: false,
      }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });
    const env = cpa.buildProcessEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok");
    expect(env.ANTHROPIC_MODEL).toBe("kimi-for-coding");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  it("ensureReady is ready when port open", async () => {
    const cpa = new CpaSupervisor({
      getSettings: () => ({
        cpaExePath: "x",
        cpaConfigPath: "y",
        cpaPort: 8317,
        defaultModel: "kimi-for-coding",
        models: [],
        permissionMode: "default",
        shutdownCpaOnQuit: false,
      }),
      getToken: () => "tok",
      probePort: async () => true,
      spawnProcess: vi.fn(),
    });
    const status = await cpa.ensureReady();
    expect(status.state).toBe("ready");
    expect(status.state === "ready" && status.managedByApp).toBe(false);
  });
});
```

- [ ] **步骤 2：实现**

关键方法：
- `probePort(port)`：`net.connect` 超时 300ms
- `ensureReady()`：通则 ready；不通则 spawn `exe --config conf`，轮询最多 ~10s
- `buildProcessEnv(model?)`
- `getStatus()` / `stopIfManaged()`
- 状态变化 callback → 主进程 `webContents.send(IPC.cpaStatusEvent)`

- [ ] **步骤 3：测试通过并 commit**

```bash
pnpm --filter @claude-desktop/desktop test
git commit -am "feat(desktop): CPA supervisor for local proxy lifecycle

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 7：PermissionBroker

**文件：**
- 创建：`apps/desktop/electron/main/permission-broker.ts`
- 创建：`apps/desktop/electron/main/permission-broker.test.ts`

- [ ] **步骤 1：测试**

覆盖：
1. `acceptEdits` 下 Edit 自动 allow
2. destructive Bash 即使 acceptEdits 也进入 pending
3. session rule 命中后 allow
4. `respond` 后 pending promise resolve
5. timeout → deny

```ts
it("auto-allows Edit in acceptEdits mode", async () => {
  const broker = new PermissionBroker({
    getMode: () => "acceptEdits",
    requestFromUi: vi.fn(),
    timeoutMs: 1000,
  });
  const res = await broker.canUseTool("Edit", { file_path: "src/a.ts" }, "sess1");
  expect(res.behavior).toBe("allow");
});
```

- [ ] **步骤 2：实现**

```ts
// 伪结构
class PermissionBroker {
  private rules = new Map<string, SessionAllowRule[]>();
  private pending = new Map<string, { resolve: (d: PermissionDecision) => void }>();

  async canUseTool(toolName: string, input: Record<string, unknown>, sessionId: string) {
    const mode = this.getMode();
    if (mode === "plan" && (toolName === "Edit" || toolName === "Write" || toolName === "Bash")) {
      return { behavior: "deny" as const, message: "Plan mode: writes disabled" };
    }
    if (toolName === "Bash" && isDestructiveBash(String(input.command ?? ""))) {
      return await this.askUi(...);
    }
    if (mode === "acceptEdits" && (toolName === "Edit" || toolName === "Write")) {
      return { behavior: "allow" as const, updatedInput: input };
    }
    if (matchSessionRule(this.rules.get(sessionId) ?? [], extract(toolName, input))) {
      return { behavior: "allow" as const, updatedInput: input };
    }
    return await this.askUi(...);
  }

  respond(requestId: string, decision: PermissionDecision) { /* resolve pending; if session scope, push rule */ }
}
```

- [ ] **步骤 3：Commit**

```bash
git commit -am "feat(desktop): permission broker with session rules

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 8：DiffTracker

**文件：**
- 创建：`apps/desktop/electron/main/diff-tracker.ts`
- 创建：`apps/desktop/electron/main/diff-tracker.test.ts`

- [ ] **步骤 1：测试从工具 input 更新变更集**

```ts
it("records Edit as modified file change", () => {
  const tracker = new DiffTracker();
  tracker.onToolUse("s1", "Edit", {
    file_path: "src/a.ts",
    old_string: "a\n",
    new_string: "b\n",
  });
  const changes = tracker.list("s1");
  expect(changes).toHaveLength(1);
  expect(changes[0].status).toBe("M");
  expect(changes[0].hunks).toContain("+b");
});
```

Write 无 previous 时 status `A`（可用可选 `readFile` 依赖注入尝试读盘，失败则 A）。

- [ ] **步骤 2：实现并 commit**

```bash
git commit -am "feat(desktop): session diff tracker for Edit/Write

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 9：normalizeSdkEvent + SessionManager（可 mock SDK）

**文件：**
- 创建：`apps/desktop/electron/main/normalize-sdk-event.ts`
- 创建：`apps/desktop/electron/main/normalize-sdk-event.test.ts`
- 创建：`apps/desktop/electron/main/session-manager.ts`
- 创建：`apps/desktop/electron/main/session-manager.test.ts`

- [ ] **步骤 1：规范化事件测试**

输入 mock SDK 消息（按文档形状精简）：

```ts
{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } }
```

输出：`{ type: "text_delta", text: "Hi", sessionId }`

工具：

```ts
{ type: "assistant", message: { content: [{ type: "tool_use", id: "1", name: "Read", input: { file_path: "a" } }] } }
```

→ `tool_start`

- [ ] **步骤 2：SessionManager 用注入的 `queryFn`**

```ts
type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncGenerator<unknown>;

class SessionManager {
  constructor(deps: {
    queryFn: QueryFn;
    permissionBroker: PermissionBroker;
    diffTracker: DiffTracker;
    cpa: CpaSupervisor;
    settings: SettingsStore;
    emit: (event: SdkNormalizedEvent) => void;
    emitSession: (s: SessionSummary) => void;
    emitDiff: (sessionId: string, changes: FileChange[]) => void;
  }) {}

  async start(prompt: string, cwd: string): Promise<string> { /* ... */ }
  async continue(sessionId: string, prompt: string): Promise<void> { /* ... */ }
  abort(sessionId: string): void { /* AbortController */ }
  list(): SessionSummary[] { /* ... */ }
}
```

`start` 逻辑：
1. `await cpa.ensureReady()`（失败则 emit error，仍允许？规格：禁止新 turn 或明确报错 → **抛错/返回 error 事件**）
2. 建本地 `sessionId` 占位；真正 id 以 SDK result 为准，开始时可用 uuid，result 到达后 remap 或更新
3. `for await (const msg of queryFn({ prompt, options }))`：
   - normalize 后 emit
   - 若 tool_use Edit/Write → diffTracker + emitDiff
4. options 含：

```ts
{
  cwd,
  resume: existingId, // continue 时
  includePartialMessages: true,
  permissionMode: settings.get().permissionMode,
  canUseTool: (name, input) => permissionBroker.canUseTool(name, input, sessionId),
  env: cpa.buildProcessEnv(settings.get().defaultModel),
  allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
}
```

注意：以实际 SDK API 为准；实现时打开 `@anthropic-ai/claude-agent-sdk` 类型定义核对 `query` 签名与 `canUseTool` 返回值形状，必要时微调本计划字段名。

- [ ] **步骤 3：单元测试 mock async generator 推送 2 个事件，断言 emit 调用**

- [ ] **步骤 4：Commit**

```bash
git commit -am "feat(desktop): session manager over agent SDK query loop

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 10：组装 IPC handlers 与 preload 完整 API

**文件：**
- 创建：`apps/desktop/electron/main/ipc-handlers.ts`
- 修改：`electron/main/index.ts`
- 修改：`electron/preload/index.ts`
- 创建：`src/lib/desktop-api.ts`

- [x] **步骤 1：在 main 里实例化服务并 `registerIpcHandlers`**

```ts
export function registerIpcHandlers(ctx: {
  window: () => BrowserWindow | null;
  sessions: SessionManager;
  permissions: PermissionBroker;
  settings: SettingsStore;
  cpa: CpaSupervisor;
  diffs: DiffTracker;
}) {
  ipcMain.handle(IPC.projectOpen, async (_e, { path }) => {
    // fs.access read
    ctx.settings.update({ lastProjectPath: path });
    return { path };
  });
  ipcMain.handle(IPC.sessionStart, async (_e, { prompt, cwd }) => {
    const project = cwd ?? ctx.settings.get().lastProjectPath;
    if (!project) throw new Error("No project open");
    const sessionId = await ctx.sessions.start(prompt, project);
    return { sessionId };
  });
  // ... sessionContinue, abort, list, select
  ipcMain.handle(IPC.permissionRespond, async (_e, { requestId, decision }) => {
    ctx.permissions.respond(requestId, decision);
    return { ok: true };
  });
  ipcMain.handle(IPC.settingsGet, async () => ctx.settings.getPublic());
  ipcMain.handle(IPC.settingsSet, async (_e, patch) => {
    ctx.settings.update(patch);
    return ctx.settings.getPublic();
  });
  ipcMain.handle(IPC.cpaStart, async () => ctx.cpa.ensureReady());
  ipcMain.handle(IPC.cpaStatus, async () => ctx.cpa.getStatus());
  ipcMain.handle(IPC.modelSet, async (_e, { model }) => {
    ctx.settings.update({ defaultModel: model });
    return { model };
  });
}
```

PermissionBroker 的 `requestFromUi`：

```ts
requestFromUi: (req) => {
  ctx.window()?.webContents.send(IPC.permissionRequest, req);
}
```

Session emit → `send(IPC.sessionEvent, event)` 等。

- [x] **步骤 2：扩展 preload 方法与 `window.desktop` 类型**

```ts
// src/lib/desktop-api.ts
import type { DesktopApi } from "../../electron/preload/index";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export function getDesktop() {
  if (!window.desktop) throw new Error("desktop API missing");
  return window.desktop;
}
```

- [x] **步骤 3：app quit 时 `cpa.stopIfManaged()`**

- [x] **步骤 4：手动 smoke：`pnpm dev`，DevTools 调 `window.desktop` 看 invoke 不炸**

- [x] **步骤 5：Commit**

```bash
git commit -am "feat(desktop): wire IPC handlers and preload API

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 11：渲染进程状态与聊天 UI

**文件：**
- 创建：`src/state/store.ts`
- 创建/完善：`ChatPanel.tsx`、`MessageList.tsx`、`ToolCard.tsx`、`Composer.tsx`、`SessionList.tsx`、`TopBar.tsx`

- [ ] **步骤 1：实现轻量 store**

状态字段：
- `projectPath`
- `sessions: SessionSummary[]`
- `activeSessionId`
- `itemsBySession: Record<string, ChatItem[]>`
- `changesBySession: Record<string, FileChange[]>`
- `permissionRequest: PermissionRequest | null`
- `cpaStatus`
- `settings: PublicSettings | null`
- `running: boolean`

订阅 `desktop.on(IPC.sessionEvent, ...)` 更新 items（text_delta 追加到最后一条 streaming assistant；tool_start/end 插入/更新 ToolCard）。

- [ ] **步骤 2：Composer 提交**

```ts
async function onSend(text: string) {
  if (!text.trim()) return;
  if (activeSessionId) {
    await desktop.continueSession(activeSessionId, text);
  } else {
    await desktop.startSession(text);
  }
}
```

- [ ] **步骤 3：SessionList 点击 → `sessionSelect` 加载 items/changes**

- [ ] **步骤 4：TopBar 显示项目路径、CPA StatusDot、模型 select、权限模式 select**

- [ ] **步骤 5：手工验证 UI 在 mock 下可操作（可在 SessionManager 暂用假 queryFn 推假流）**

- [ ] **步骤 6：Commit**

```bash
git commit -am "feat(desktop): chat UI state, sessions, composer, top bar

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 12：PermissionModal + Changes/Diff 面板

**文件：**
- 创建：`src/components/PermissionModal.tsx`
- 创建：`src/components/ChangesPanel.tsx`
- 创建：`src/components/DiffView.tsx`

- [ ] **步骤 1：PermissionModal**

显示 toolName、summary、JSON 预览（截断）。三按钮：
- Allow once → `{ behavior: "allow", scope: "once" }`
- Allow for session → `scope: "session"`
- Deny → `{ behavior: "deny", message: "User denied" }`

- [ ] **步骤 2：ChangesPanel**

文件列表；选中 path 后 `DiffView` 用 `<pre>` 渲染 hunks，简单着色：行首 `+` 绿、`-` 红。

- [ ] **步骤 3：订阅 `diff:updated` 刷新**

- [ ] **步骤 4：Commit**

```bash
git commit -am "feat(desktop): permission modal and changes/diff panel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 13：接通真实 Agent SDK + CPA 端到端

**文件：**
- 修改：`session-manager.ts` 默认 `queryFn` 为真实 `query`
- 修改：`settings` 默认路径
- 更新：`README.md` 运行说明

- [ ] **步骤 1：安装并核对 SDK API**

```bash
pnpm --filter @claude-desktop/desktop add @anthropic-ai/claude-agent-sdk
```

阅读 `node_modules/@anthropic-ai/claude-agent-sdk` 的导出与类型，校正：
- `query` import 路径
- `canUseTool` 返回类型字段名
- `env` / `executable` 相关 options 是否存在；若 SDK 用进程环境继承，则在调用 `query` 前 `process.env` 赋值并在 finally 恢复，或使用 SDK 文档推荐的 env 传递方式

- [ ] **步骤 2：真实跑通清单（手工）**

1. 启动本机 CPA 或让 App 拉起（`D:\gitrep\CC\CPA`）
2. 设置里写入 token（与 `claude-cpa` 相同）
3. 打开一个小测试目录
4. Prompt：`列出当前目录下的文件名` → 应出现工具卡片与文本
5. Prompt：`在 scratch.txt 写入 hello` → 权限弹窗 → Allow → Changes 出现文件
6. 切换模型后再发一问
7. 拒绝一次 Bash 请求，确认 agent 收到 deny

- [ ] **步骤 3：修 bug 直到上述清单通过**

- [ ] **步骤 4：Commit**

```bash
git commit -am "feat(desktop): integrate real claude agent SDK and CPA env

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 14：设置页极简版 + 打开文件夹对话框 + 错误提示

**文件：**
- 创建：`src/components/SettingsDrawer.tsx`
- 修改：`TopBar.tsx`、`ipc-handlers.ts`（`dialog.showOpenDialog`）

- [ ] **步骤 1：项目打开用系统对话框**

```ts
ipcMain.handle(IPC.projectOpen, async () => {
  const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (res.canceled || !res.filePaths[0]) throw new Error("canceled");
  // ...
});
```

- [ ] **步骤 2：SettingsDrawer 字段**

CPA exe、config、port、token（password input）、models CSV、shutdownCpaOnQuit、默认模型

- [ ] **步骤 3：全局 `app:error` toast/banner**

- [ ] **步骤 4：Commit**

```bash
git commit -am "feat(desktop): settings drawer, open folder dialog, error banner

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### 任务 15：README、规格同步、基础打包配置

**文件：**
- 修改：`README.md`
- 复制/确认：`docs/superpowers/specs/...`、`plans/...`
- 创建：`apps/desktop/electron-builder.yml`（或 package.json build 字段）

- [ ] **步骤 1：README 内容必须包含**

- 前置：Node 20+、pnpm、已装 `claude` CLI、可选 CPA
- `pnpm install` / `pnpm dev` / `pnpm test`
- 首次设置：token、CPA 路径、host 建议 127.0.0.1
- 安全说明：token 仅主进程；自托管代理

- [ ] **步骤 2：electron-builder 能打 Windows 目录包即可（安装器可后补）**

```bash
pnpm --filter @claude-desktop/desktop build
```

- [ ] **步骤 3：全量测试**

```bash
pnpm test
pnpm typecheck
```

预期：全部 PASS

- [ ] **步骤 4：最终 commit**

```bash
git add -A
git commit -m "docs: README and packaging skeleton for claude-desktop MVP

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 规格覆盖检查

| 规格需求 | 任务 |
|----------|------|
| 打开本地项目 | 10, 14 |
| 流式对话 + 工具卡片 | 9, 11, 13 |
| 权限 Allow once/session/Deny | 3, 7, 12, 13 |
| acceptEdits / plan | 7, 11 |
| Changes + Diff（Edit/Write） | 2, 8, 12 |
| 会话列表 / resume | 9, 10, 11 |
| CPA 启停 + 模型切换 + 状态灯 | 6, 10, 11, 13 |
| token 安全存储 | 5, 14 |
| 错误处理 | 9, 14 |
| 不做终端/深 CPA/Git UI | 全计划未包含（YAGNI） |

## 类型名一致性

- `FileChange`、`PermissionDecision`、`CpaStatus`、`SdkNormalizedEvent`、`SessionSummary`、`PublicSettings` 均定义于 `@claude-desktop/shared`，主进程与渲染进程共用。
- IPC channel 常量仅来自 `IPC` 对象。

## 风险提示（实现时）

1. **Agent SDK API 细节以安装版本类型为准**，任务 9/13 允许小幅字段对齐。
2. Windows 路径与 spawn CPA 要用绝对路径；`probePort` 勿误判。
3. 切勿在 renderer 日志打印 token。
4. 真实 E2E 依赖本机 `claude` + CPA；CI 只跑纯函数与 mock 测试。

---

## 执行交接

计划已保存到：

`D:\gitrep\ceshi\docs\superpowers\plans\2026-08-02-claude-desktop-codex-ui.md`

实现代码默认落在新目录 **`D:\gitrep\claude-desktop`**（与标书仓库分离）。开始任务 1 前请确认该路径，或给出你想用的路径。
