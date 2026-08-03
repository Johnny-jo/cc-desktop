# UI 重设计（Codex 深灰）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 按已批准规格把桌面端 UI 改成统一深色设计系统：固定三栏（240 / 1fr / 320）、Changes 可收起、聊天内容居中 860px、Composer 固定、Session 标题不溢出。

**架构：** 纯前端重构。设计令牌（CSS 变量）+ 栅格布局；只改 renderer 组件与 `styles.css`，不动 IPC / store 数据形状。Changes 收起状态放 `App` 本地 state，经 TopBar 右侧按钮切换。

**技术栈：** React · TypeScript · 纯 CSS（无 UI 库） · electron-vite · Vitest

**规格：** `docs/superpowers/specs/2026-08-03-ui-redesign-design.md`

**实现根目录：** `D:\gitrep\claude-desktop`

---

## 文件结构

```
apps/desktop/src/
  styles.css                    # 重写：令牌 + 全部组件样式
  App.tsx                       # changesOpen state；传 onToggleChanges 给 TopBar；条件渲染 Changes 栏
  components/
    TopBar.tsx                  # 新增 props: changesOpen, onToggleChanges；右侧加折叠按钮
    SessionList.tsx             # 修溢出结构（title/meta 加 min-width:0）
    ChatPanel.tsx               # 包 .chat-inner 限宽容器
    ChangesPanel.tsx            # 不再自带折叠；空态卡片化
    Composer.tsx                # 类名微调以匹配新样式
```

---

## 任务 1：设计令牌 + 全局骨架（styles.css 基座）

**文件：**
- 修改：`apps/desktop/src/styles.css`

- [ ] **步骤 1：替换 `:root` 与全局 reset**

```css
:root {
  color-scheme: dark;
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: #0a0e14;
  color: #d8dee6;

  --bg-app: #0a0e14;
  --bg-elevated: #11161d;
  --bg-panel: #0d1218;
  --bg-hover: #161c24;
  --border: #1d2733;
  --border-strong: #2a3542;
  --text: #d8dee6;
  --text-muted: #7d8ba0;
  --accent: #3b82f6;
  --accent-soft: rgba(59, 130, 246, 0.12);
  --ok: #22c55e;
  --warn: #eab308;
  --danger: #ef4444;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --shadow-1: 0 1px 0 rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.18);
  --shadow-2: 0 8px 24px rgba(0, 0, 0, 0.28);
  --focus-ring: 0 0 0 2px var(--accent-soft);

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg-app); color: var(--text); }
button, input, select, textarea { font: inherit; color: inherit; }

/* Scrollbars */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: #232c38; border-radius: 5px; border: 2px solid var(--bg-app);
}
::-webkit-scrollbar-thumb:hover { background: #2f3947; }
```

- [ ] **步骤 2：按钮 / 输入控件基类**

```css
.btn {
  background: #1c2634; border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 5px 12px; cursor: pointer;
  font-size: 12px; line-height: 1.4;
  transition: background 120ms ease, border-color 120ms ease;
}
.btn:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
.btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 3px 9px; font-size: 11px; }
.btn-primary { background: #1d4ed8; border-color: #2563eb; }
.btn-primary:hover:not(:disabled) { background: #2563eb; }
.btn-danger { background: #7f1d1d; border-color: #991b1b; }
.btn-ghost { background: transparent; border-color: transparent; }
.btn-ghost:hover:not(:disabled) { background: var(--bg-hover); }

.input, .select {
  background: #0b1016; border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 5px 8px; font-size: 12px;
}
.input:focus-visible, .select:focus-visible { outline: none; box-shadow: var(--focus-ring); border-color: var(--accent); }
```

- [ ] **步骤 3：运行 typecheck + test + build 确认基座不炸**

运行：
```bash
pnpm --filter @claude-desktop/desktop typecheck
pnpm --filter @claude-desktop/desktop test
pnpm --filter @claude-desktop/desktop build
```
预期：全 PASS（样式改动不影响逻辑）

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/styles.css
git commit -m "feat(desktop): ui tokens and global control base styles

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 任务 2：应用栅格与三栏固定（布局不漂移）

**文件：**
- 修改：`apps/desktop/src/styles.css`
- 修改：`apps/desktop/src/App.tsx`

- [ ] **步骤 1：App 加 changesOpen 状态并条件渲染 Changes 栏**

```tsx
import React, { useEffect, useState } from "react";
import { TopBar } from "./components/TopBar";
import { SessionList } from "./components/SessionList";
import { ChatPanel } from "./components/ChatPanel";
import { ChangesPanel } from "./components/ChangesPanel";
import { PermissionModal } from "./components/PermissionModal";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { ErrorBanner } from "./components/ErrorBanner";
import { bootstrapStore } from "./state/store";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);

  useEffect(() => {
    void bootstrapStore();
  }, []);

  return (
    <div className="app">
      <TopBar
        onOpenSettings={() => setSettingsOpen(true)}
        changesOpen={changesOpen}
        onToggleChanges={() => setChangesOpen((v) => !v)}
      />
      <ErrorBanner />
      <div className={changesOpen ? "main" : "main main-no-changes"}>
        <div className="panel panel-sessions">
          <SessionList />
        </div>
        <div className="panel panel-chat">
          <ChatPanel />
        </div>
        {changesOpen ? (
          <div className="panel panel-changes">
            <ChangesPanel />
          </div>
        ) : null}
      </div>
      <PermissionModal />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
```

- [ ] **步骤 2：栅格 CSS**

```css
.app { display: grid; grid-template-rows: 48px auto 1fr; height: 100vh; min-height: 0; }

.main {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 320px;
  min-height: 0;
}
.main-no-changes { grid-template-columns: 240px minmax(0, 1fr); }

.panel { border-right: 1px solid var(--border); min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-panel); }
.panel:last-child { border-right: none; }
.panel-chat { background: var(--bg-app); }
```

- [ ] **步骤 3：typecheck/test/build**

预期全 PASS

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): fixed 3-column grid with collapsible changes layout

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 任务 3：TopBar 控件化 + Changes 折叠按钮

**文件：**
- 修改：`apps/desktop/src/components/TopBar.tsx`
- 修改：`apps/desktop/src/styles.css`

- [ ] **步骤 1：TopBar 接受折叠 props，右侧加按钮**

```tsx
import React from "react";
import type { PermissionMode } from "@claude-desktop/shared";
import { StatusDot } from "./StatusDot";
import {
  openProject,
  setModel,
  setPermissionMode,
  startCpa,
  useAppStore,
} from "../state/store";

const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];

export type TopBarProps = {
  onOpenSettings: () => void;
  changesOpen: boolean;
  onToggleChanges: () => void;
};

export function TopBar({ onOpenSettings, changesOpen, onToggleChanges }: TopBarProps) {
  const projectPath = useAppStore((s) => s.projectPath);
  const cpaStatus = useAppStore((s) => s.cpaStatus);
  const settings = useAppStore((s) => s.settings);

  const models = settings?.models?.length
    ? settings.models
    : settings?.defaultModel
      ? [settings.defaultModel]
      : [];

  const onBrowse = async () => {
    try { await openProject(); } catch { /* lastError in store */ }
  };

  return (
    <div className="topbar">
      <span className="brand">Claude Desktop</span>

      <button type="button" className="btn btn-ghost" onClick={() => void onBrowse()} title="Open project folder">
        Open folder
      </button>

      <span className="topbar-path" title={projectPath ?? ""}>
        {projectPath ?? "No project"}
      </span>

      <button type="button" className="btn btn-ghost" onClick={() => void startCpa()} title="Start / ensure CPA">
        <StatusDot status={cpaStatus} />
      </button>

      <label className="topbar-field">
        Model
        <select
          className="select"
          value={settings?.defaultModel ?? ""}
          disabled={!settings}
          onChange={(e) => void setModel(e.target.value)}
        >
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </label>

      <label className="topbar-field">
        Permission
        <select
          className="select"
          value={settings?.permissionMode ?? "default"}
          disabled={!settings}
          onChange={(e) => void setPermissionMode(e.target.value as PermissionMode)}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </label>

      <div className="topbar-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onToggleChanges}
          title={changesOpen ? "Hide changes panel" : "Show changes panel"}
          aria-pressed={changesOpen}
        >
          {changesOpen ? "Changes ⟩" : "Changes ⟨"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onOpenSettings} title="Settings">
          Settings
        </button>
      </div>
    </div>
  );
}
```

- [ ] **步骤 2：TopBar CSS（紧凑、控件统一、右对齐）**

```css
.topbar {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 0 var(--space-3); border-bottom: 1px solid var(--border);
  background: var(--bg-elevated); font-size: 12px; min-width: 0; overflow: hidden;
}
.brand { font-weight: 600; white-space: nowrap; }
.topbar-path { color: var(--text-muted); min-width: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.topbar-field { display: flex; align-items: center; gap: 6px; color: var(--text-muted); white-space: nowrap; }
.topbar-field .select { max-width: 160px; }
.topbar-actions { margin-left: auto; display: flex; gap: var(--space-1); }
```

- [ ] **步骤 3：typecheck/test/build**

预期全 PASS

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/components/TopBar.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): topbar controls and changes panel toggle

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 任务 4：SessionList 溢出修复与项样式

**文件：**
- 修改：`apps/desktop/src/components/SessionList.tsx`
- 修改：`apps/desktop/src/styles.css`

- [ ] **步骤 1：SessionList 结构与 tooltip**

```tsx
import React from "react";
import { newChat, selectSession, useAppStore } from "../state/store";

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return ""; }
}

export function SessionList() {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);

  return (
    <div className="session-list">
      <div className="session-list-header">
        <span>Sessions</span>
        <button type="button" className="btn btn-sm" onClick={() => newChat()}>
          New
        </button>
      </div>
      <ul className="session-list-ul">
        {sessions.length === 0 ? (
          <li className="session-empty">No sessions yet</li>
        ) : (
          sessions.map((s) => (
            <li key={s.id} className="session-list-item">
              <button
                type="button"
                className={s.id === activeSessionId ? "session-item active" : "session-item"}
                onClick={() => void selectSession(s.id)}
                title={s.title}
              >
                <span className="session-title">{s.title}</span>
                <span className="session-meta">
                  <span className={`session-status status-${s.status}`}>{s.status}</span>
                  <span className="session-time">{formatTime(s.updatedAt)}</span>
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
```

- [ ] **步骤 2：Session CSS（定界 + 截断 + active 指示）**

```css
.session-list { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.session-list-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--space-3) var(--space-3) var(--space-2);
  font-size: 12px; font-weight: 600;
}
.session-list-ul { list-style: none; margin: 0; padding: 0 var(--space-2) var(--space-2); overflow: auto; flex: 1; min-height: 0; }
.session-list-item { min-width: 0; }
.session-empty { color: var(--text-muted); font-size: 12px; padding: var(--space-3); text-align: center; }

.session-item {
  width: 100%; min-width: 0; text-align: left;
  background: transparent; border: 1px solid transparent;
  border-radius: var(--radius-md); padding: var(--space-2) var(--space-3);
  cursor: pointer; display: flex; flex-direction: column; gap: 4px;
  transition: background 120ms ease, border-color 120ms ease;
}
.session-item:hover { background: var(--bg-hover); }
.session-item.active { background: #141b25; border-color: var(--border-strong); }

.session-title {
  min-width: 0; font-size: 12px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.session-meta { display: flex; justify-content: space-between; gap: var(--space-2); min-width: 0; font-size: 10px; color: var(--text-muted); }
.session-status.status-running { color: var(--warn); }
.session-status.status-error { color: var(--danger); }
.session-status.status-idle { color: var(--ok); }
.session-time { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

- [ ] **步骤 3：typecheck/test/build**

预期全 PASS

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/components/SessionList.tsx apps/desktop/src/styles.css
git commit -m "fix(desktop): session title truncation and item layout

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 任务 5：Chat 居中限宽 + Composer 固定 + 卡片化

**文件：**
- 修改：`apps/desktop/src/components/ChatPanel.tsx`
- 修改：`apps/desktop/src/styles.css`

- [ ] **步骤 1：ChatPanel 包限宽容器**

```tsx
import React from "react";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { useAppStore } from "../state/store";

export function ChatPanel() {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const itemsBySession = useAppStore((s) => s.itemsBySession);
  const sessions = useAppStore((s) => s.sessions);
  const running = useAppStore((s) => s.running);

  const items = activeSessionId ? (itemsBySession[activeSessionId] ?? []) : [];
  const active = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div className="chat-inner chat-header-inner">
          <span className="chat-title">{active ? active.title : "New chat"}</span>
          {running ? <span className="badge running">running</span> : null}
        </div>
      </div>
      <div className="chat-body">
        <div className="chat-inner">
          <MessageList items={items} />
        </div>
      </div>
      <div className="chat-composer">
        <div className="chat-inner">
          <Composer />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **步骤 2：Chat / Composer CSS**

```css
.chat-panel { display: grid; grid-template-rows: 44px minmax(0, 1fr) auto; min-height: 0; height: 100%; }
.chat-inner { width: 100%; max-width: 860px; margin: 0 auto; padding: 0 var(--space-4); min-width: 0; }
.chat-header { display: flex; align-items: stretch; border-bottom: 1px solid var(--border); background: var(--bg-elevated); }
.chat-header-inner { display: flex; align-items: center; gap: var(--space-2); font-size: 13px; font-weight: 600; }
.chat-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-body { overflow: auto; min-height: 0; }
.chat-composer { border-top: 1px solid var(--border); background: var(--bg-elevated); }

.badge { font-size: 10px; font-weight: 500; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-muted); }
.badge.running { color: var(--warn); border-color: #854d0e; }

.message-list { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4) 0; min-height: 0; }
.message-list.empty { align-items: center; justify-content: center; min-height: 200px; color: var(--text-muted); }

.message-row { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: var(--space-2); font-size: 13px; line-height: 1.5; }
.message-role { color: var(--text-muted); font-size: 11px; text-transform: uppercase; padding-top: 2px; }
.message-body { white-space: pre-wrap; word-break: break-word; min-width: 0; }
.role-user .message-body { color: #dbeafe; }
.role-system .message-body { color: var(--danger); }
.cursor { display: inline-block; margin-left: 1px; animation: blink 1s step-end infinite; color: var(--accent); }
@keyframes blink { 50% { opacity: 0; } }

.tool-row { grid-template-columns: minmax(0, 1fr); }
.tool-card {
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3); background: #10161e;
  font-size: 12px; box-shadow: var(--shadow-1);
}
.tool-card-header { display: flex; justify-content: space-between; gap: var(--space-2); margin-bottom: 4px; }
.tool-name { font-weight: 600; }
.tool-status.status-running { color: var(--warn); }
.tool-status.status-done { color: var(--ok); }
.tool-status.status-error { color: var(--danger); }
.tool-summary { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-preview { margin: 6px 0 0; padding: 6px 8px; background: #0b1016; border-radius: var(--radius-sm); font-size: 11px; overflow: auto; max-height: 140px; white-space: pre-wrap; }

.composer { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) 0; }
.composer-input {
  width: 100%; resize: vertical; min-height: 68px;
  background: #0b1016; border: 1px solid var(--border);
  border-radius: var(--radius-md); padding: var(--space-2) var(--space-3);
}
.composer-input:focus-visible { outline: none; box-shadow: var(--focus-ring); border-color: var(--accent); }
.composer-input:disabled { opacity: 0.6; }
.composer-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
```

- [ ] **步骤 3：typecheck/test/build**

预期全 PASS

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/components/ChatPanel.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): centered chat with fixed composer and cards

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 任务 6：Changes 面板与 Diff 样式（收起布局下不抖动）

**文件：**
- 修改：`apps/desktop/src/styles.css`

- [ ] **步骤 1：Changes / Diff CSS（覆盖现有段）**

```css
.changes-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.changes-panel .panel-title {
  padding: var(--space-3) var(--space-3) var(--space-2);
  font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--border);
}
.changes-panel .muted { padding: var(--space-3); color: var(--text-muted); }
.changes-list { list-style: none; margin: 0; padding: var(--space-2); font-size: 12px; display: flex; flex-direction: column; gap: 6px; overflow: auto; max-height: 40%; }
.change-item {
  width: 100%; min-width: 0; text-align: left; background: transparent;
  border: 1px solid transparent; border-radius: var(--radius-md);
  padding: 6px 8px; cursor: pointer; display: flex; align-items: center; gap: var(--space-2);
}
.change-item:hover { background: var(--bg-hover); }
.change-item.active { background: #141b25; border-color: var(--border-strong); }
.change-status { font-family: ui-monospace, monospace; font-weight: 600; }
.change-status.status-A { color: var(--ok); }
.change-status.status-M { color: var(--warn); }
.change-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }

.diff-view { flex: 1; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--border); }
.diff-header { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); font-size: 12px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); }
.diff-path { font-family: ui-monospace, monospace; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.diff-meta { color: var(--text-muted); font-size: 11px; }
.diff-content { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: var(--space-2) 0; font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.45; background: #0b1016; }
.diff-line { padding: 0 var(--space-3); white-space: pre-wrap; word-break: break-all; }
.diff-add { color: #86efac; background: rgba(34, 197, 94, 0.08); }
.diff-del { color: #fca5a5; background: rgba(239, 68, 68, 0.08); }
.diff-ctx { color: var(--text-muted); }
.diff-hunk { color: var(--accent); background: rgba(59, 130, 246, 0.08); }
```

- [ ] **步骤 2：typecheck/test/build**

预期全 PASS

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/styles.css
git commit -m "feat(desktop): changes panel and diff styles

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 任务 7：设置抽屉 / 权限弹窗 / 错误 banner 对齐令牌

**文件：**
- 修改：`apps/desktop/src/styles.css`

- [ ] **步骤 1：更新这些组件样式段（替换旧值）**

```css
.error-banner { display: flex; align-items: center; gap: var(--space-2); padding: 6px var(--space-3); background: #3f1212; border-bottom: 1px solid #7f1d1d; color: #fecaca; font-size: 12px; }
.error-banner-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.settings-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 40; display: flex; justify-content: flex-end; }
.settings-drawer { width: min(440px, 100vw); height: 100%; background: var(--bg-elevated); border-left: 1px solid var(--border); display: flex; flex-direction: column; box-shadow: var(--shadow-2); }
.settings-header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); }
.settings-header h2 { margin: 0; font-size: 14px; font-weight: 600; }
.settings-body { flex: 1; overflow: auto; padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.settings-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
.settings-field .input { width: 100%; }
.settings-check { display: flex; align-items: center; gap: var(--space-2); font-size: 12px; color: var(--text-muted); }
.settings-error { margin: 0; color: var(--danger); font-size: 12px; }
.settings-ok { margin: 0; color: var(--ok); font-size: 12px; }
.settings-footer { padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border); display: flex; justify-content: flex-end; }

.modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--bg-elevated); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); min-width: 420px; max-width: 560px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: var(--shadow-2); }
.modal-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border); }
.modal-title { font-weight: 600; font-size: 13px; }
.modal-body { padding: var(--space-3) var(--space-4); overflow: auto; min-height: 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border); }
```

- [ ] **步骤 2：typecheck/test/build**

预期全 PASS

- [ ] **步骤 3：Commit**

```bash
git add apps/desktop/src/styles.css
git commit -m "feat(desktop): align settings drawer, modal, error banner to tokens

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 任务 8：整体验证与清理

**文件：**
- 按需微调（仅修问题）

- [ ] **步骤 1：全量检查**

```bash
pnpm typecheck
pnpm test
pnpm build
```
预期：全 PASS

- [ ] **步骤 2：手工 / 截图验收**

启动 `pnpm dev`，确认：
- 长 session 标题截断 + tooltip
- 拉伸窗口列宽稳定（240 / flex / 320；收起 changes 时聊天变宽但不跳）
- Composer 始终贴底
- Changes 折叠按钮在 TopBar 右侧
- 聊天内容居中 ≤860px

- [ ] **步骤 3：若发现样式残留（旧变量名 / 重复规则），清理并复测**

- [ ] **步骤 4：最终 Commit**

```bash
git add -A
git commit -m "chore(desktop): ui redesign polish and cleanup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验收对照

| 规格需求 | 任务 |
|----------|------|
| 设计令牌 | 1 |
| 三栏固定 / 不漂移 | 2 |
| Changes 可收起（TopBar 右侧） | 2, 3 |
| Session 标题不溢出 | 4 |
| 聊天居中 860 / Composer 固定 | 5 |
| 卡片化 / 统一控件 | 1, 3, 5, 6, 7 |
| 全量验证 | 8 |
