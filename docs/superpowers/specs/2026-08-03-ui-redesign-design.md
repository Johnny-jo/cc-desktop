# UI 重设计规格（Codex 深灰）

**日期：** 2026-08-03  
**状态：** 已获用户批准  
**范围：** Electron 桌面端 UI（React + CSS）；不改 IPC / store 行为语义

---

## 1. 背景

用户反馈：

1. 左侧 Session 标题可能超限、溢出格子
2. 三栏列宽随内容/窗口漂移
3. 整体 UI 不好看，希望现代化

已确认方向：**Codex 深灰**；Changes 可收起；聊天内容居中限宽 860px；布局固定列宽。

---

## 2. 设计令牌

统一 CSS 变量（`:root`）：

- 背景层级：`--bg-app` / `--bg-elevated` / `--bg-panel` / `--bg-hover`
- 边框：`--border` / `--border-strong`
- 文本：`--text` / `--text-muted`
- 状态色：`--accent` / `--ok` / `--warn` / `--danger`
- 圆角：`--radius-sm(6)` / `--radius-md(8)` / `--radius-lg(10)`
- 阴影：`--shadow-1` / `--shadow-2`
- 间距：`--space-1..6`
- focus-ring：`0 0 0 2px var(--accent-soft)`

滚动条：细、暗色、hover 加深。

---

## 3. 布局

### 3.1 应用网格

```text
.app: grid-template-rows: 48px auto 1fr; height: 100vh
```

### 3.2 三栏

```text
┌ TopBar 48px ─────────────────────────────────────────┐
├──────────┬───────────────────────────┬───────────────┤
│ Sessions │ Chat                      │ Changes       │
│ 240px    │ flex                      │ 0 / 320px     │
│ 固定     │ 内容居中 max-width 860px  │ 可收起        │
└──────────┴───────────────────────────┴───────────────┘
```

- `.main { display:grid; grid-template-columns: 240px 1fr auto; }`
- Changes 收起时 third column 为 0（`auto` + 条件类）
- 不随内容漂移：各栏 `min-width:0; overflow:hidden`

### 3.3 Chat 内部

```text
.chat-panel: grid-template-rows: 44px 1fr auto; height:100%
```

- header 固定 44px
- `.message-list { overflow:auto; min-height:0; }`
- Composer 固定在底部，不随消息跳动
- `.chat-inner { max-width:860px; margin:0 auto; width:100%; padding:0 16px; }`

---

## 4. 组件

### 4.1 TopBar

- 高度 48px，左：brand / Open folder / project path / CPA dot；中：Model / Permission；右：Changes toggle + Settings
- 图标按钮 ghost；下拉与输入统一控件样式

### 4.2 SessionList

- header：Sessions + New（btn-sm）
- item：纵向堆叠标题与 meta；`min-width:0` 防溢出
- title：`overflow:hidden; text-overflow:ellipsis; white-space:nowrap;` + `title` 提示
- meta：status（running/idle/error 色点/文字） + 时间，space-between
- active 态：`--bg-hover` + 左侧 accent 指示条或边框

### 4.3 Chat

- 消息气泡：user / assistant / system 区分；工具卡片卡片化
- Tool card：header（name + status）、summary、可折叠 preview
- Composer：贴底、圆角输入、Send / Stop；disabled 态清晰

### 4.4 Changes 面板

- header：Changes + 计数 + 折叠按钮（右侧 TopBar 同步）
- 列表项：A/M 状态 + 路径（截断）
- Diff 区：header（path + meta）+ content，行级着色；可滚动

### 4.5 Settings drawer / Permission modal / Error banner

- 沿用现有功能，更新为同一令牌：圆角、阴影、间距、focus

---

## 5. 交互与状态

- Changes 收起状态存 `App` 本地 state（`changesOpen`），默认开；TopBar 按钮切换
- 空态：No sessions / No changes 居中 muted
- running：Chat header badge + Composer Stop
- 错误：顶部 banner 可 dismiss

---

## 6. 实现约束

- 不引入第三方 UI 库
- 不改 IPC channel / store 数据形状
- 改动文件：`App.tsx`、`TopBar.tsx`、`SessionList.tsx`、`ChatPanel.tsx`、`ChangesPanel.tsx`、`styles.css`（必要时 `Composer.tsx`、`DiffView.tsx` 微调类名）
- 保留现有类名命名风格（BEM-ish kebab）

---

## 7. 验收

- typecheck / test / build 全绿
- 长 session 标题不溢出，有 tooltip
- 窗口拉伸时三栏列宽稳定；Changes 收起/展开聊天区不抖动
- Composer 始终贴底
- 截图对比：launch、长列表、changes 收起、diff 展开

---

## 8. 非目标

- 多主题 / 亮色
- 会话标题自动命名
- 响应式到小屏（桌面优先）
