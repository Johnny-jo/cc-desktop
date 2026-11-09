---
name: cc-desktop-mod
description: 为 CC Desktop 群聊制作 Mod（hostApi 2 群聊扩展 / hostApi 1 玩法模组）。当用户想写一个群聊扩展、拦截/改写群聊消息、做共享记忆或定时任务、做投票/狼人杀一类的玩法包，或调试现有 Mod 时使用。
---

# CC Desktop Mod 制作

CC Desktop 的群聊支持两类 Mod，**先确定做哪一类**：

| 类型 | manifest | 代码文件 | 入口 | 数量限制 |
|---|---|---|---|---|
| 群聊扩展 | `"hostApi": 2` | `mod.js` | `export function activate(ctx)` | 一群可多个 |
| 玩法模组 | `"hostApi": 1` | `host.js` | `export function createGame()` | 一群最多一个 |

权威文档：`docs/mods/hostapi-2.md`（扩展）；官方示例：`apps/desktop/resources/mods/` 下的 `shared-memory` / `chat-guard` / `chat-glossary` / `room-pulse`（扩展），`vote` / `werewolf`（玩法）。**优先复制示例目录改 id/name，不要从零写。**

## 快速开始

两条路任选：

1. **应用内脚手架**：设置 → 群聊设置 → 如何制作 Mod → 输入 id/名称 →「生成模板并打开文件夹」。生成的是 hostApi 2 骨架，位于内核缓存目录，改完直接在「Mod 管理」里启用。
2. **手工**：复制 `apps/desktop/resources/mods/chat-guard/` 这类示例到自己的目录，改 `manifest.json` 的 `id` / `name`。

## hostApi 2 群聊扩展（推荐，最常用）

目录只有**两个文件**：`manifest.json` + `mod.js`。禁止 `host.js` / `ui.js` / `createGame`。

### manifest.json

```json
{
  "id": "my-mod",
  "name": "我的 Mod",
  "version": "0.1.0",
  "hostApi": 2,
  "inject": [],
  "provides": [],
  "permissions": [],
  "hooks": ["room.chat.in"]
}
```

- `permissions` 只允许 `storage:room`（群共享 KV）和 `schedule:room`（定时任务）；写别的值直接拒载。
- `hooks` 目前只允许 `room.chat.in`。
- `inject` 填要消费的 provide 名（如 `"memory"`）；`provides` 填对外提供的能力名。
- `budget` 可选：`{ "hookPerMin": 30, "schedulePerMin": 6 }`，默认 120/20，整房上限 300/40。

### mod.js

```js
export function activate(ctx) {
  ctx.hooks.on("room.chat.in", (env) => {
    if (env.text === "stop") return { action: "drop", reason: "blocked" };
    return { action: "replace", value: { ...env, text: env.text.trim() } };
    // 或不返回 / { action: "continue" } = 原样透传
  });
}
```

能力全从 `ctx` 拿：

- `ctx.hooks.on("room.chat.in", fn)`：拦截入站消息。返回 `continue` / `replace` / `drop`。**50ms 超时或抛错 = 放过原文**。hook 内禁止再投聊天或调玩法 intent。
- `ctx.storage.namespace("xxx")`：需声明 `storage:room`。`.get/.set/.list/.search`。**namespace 不按包隔离**，所有持该权限的包共享。
- `ctx.schedule.every(ms, fn)`：需声明 `schedule:room`。间隔 ≥1s，每包最多 4 个任务；fn 返回 `{ text, toAgent }` 可发系统消息。
- `ctx.provide(name, api)`：必须**同步**调用，name 要在 `provides` 里，api 的值必须全是函数。activate 返回后实际 provide 集合必须与 manifest 一致，否则包 `failed`。
- `ctx.room` / `ctx.log` / `ctx.onDispose` 内建可用。

### 沙箱红线（踩了直接拒载或 failed）

禁止 `require` / `import` / `Function` / `eval` / `process` / `setTimeout` / `setInterval`（含 `globalThis['setTimeout']` 这类别名）。字符串和注释里出现这些词没事。

## hostApi 1 玩法模组

`manifest.json` 额外需要 `seats: { min, max, roles }` 和 `agent: true|false`。`host.js` 导出 `createGame()`，返回这组函数（参考 `resources/mods/vote/host.js`）：

```js
export function createGame() {
  return {
    initialState,      // () => state
    reduce,            // (state, intent) => state（纯函数，可序列化）
    getPublicView,     // (state) => 公共视图
    getSeatView,       // (state, seatId) => 席位视图
    getActions,        // (state, seatId) => 可用动作
    getPrompt,         // (state, seatId) => 给 Agent 的提示词
    shouldPromptAgent, // (state, seatId) => boolean
  };
}
```

state 必须可 JSON 序列化；`reduce` 保持纯函数。启用后一房只能有一个玩法，在玩法面板里开始当局。

## 调试与迭代

1. **启用**：进群聊 → 群聊设置 → 勾选扩展（玩法模组单选）。或在 设置 → 群聊设置 → Mod 管理 操作。客人不下载不执行 `mod.js`，只看投影。
2. **看状态**：群聊设置的扩展列表会显示 `pending` / `failed` 及原因；`failed` 通常是 provide 集合与 manifest 不一致或 activate 抛错。
3. **改代码不重装**：群聊设置 → 扩展改善，粘贴新 `mod.js` 提提案。只能改实现，`inject` / `provides` / `permissions` / `hooks` 永远以当前 manifest 为准。自主权 L0 房主审批、L1 provide 不变则自动应用、L2 直接应用；可回滚一版。房内 Agent 也有 `kernel_propose` 等 MCP 工具走同一管线。
4. **共享记忆**：`provides: ["memory"]` 成功后，房内 Agent 席位自动获得 `memory_get/set/list/search` MCP 工具；房主可在群聊设置里直接增删条目。

## 常见坑

- `provide` 放进回调/Promise 里 → activate 同步返回前没挂上 → 包 failed。
- hook 里写复杂逻辑超过 50ms → 消息原样通过，看起来"没生效"。
- 想持久化但忘了声明 `storage:room` → `ctx.storage` 是 undefined。
- `inject: ["memory"]` 但没人 provide memory → 包停在 `pending`，不是 bug。
- 文件名写错（`mod.js` 写成 `host.js`）→ 直接拒载。
