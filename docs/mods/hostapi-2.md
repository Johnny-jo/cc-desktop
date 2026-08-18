# hostApi 2 房间扩展（作者说明）

`hostApi: 1` 是玩法包（`host.js` + `createGame`），一房间最多一个。  
`hostApi: 2` 是组合扩展（`mod.js` + `activate(ctx)`），一房间可多个。

玩法入口不能启用扩展包，扩展入口也不能启用玩法包。客人进房**不下载、不执行** `mod.js`，只看投影（房间设置里的扩展列表、改写/丢弃后的聊天）。

## 包结构

```
my-ext/
  manifest.json
  mod.js
```

不要放 `host.js`、`ui.js`，不要写 `createGame`。

官方模板：

- `apps/desktop/resources/mods/shared-memory/` — `provides: ["memory"]`
- `apps/desktop/resources/mods/chat-guard/` — `hooks: ["room.chat.in"]`
- `apps/desktop/resources/mods/chat-glossary/` — `inject: ["memory"]` + 入站替换
- `apps/desktop/resources/mods/room-pulse/` — `schedule:room`，每 60s 静默跳一次；房间标题旁绿点表示在跑，不写时间线

`inject` 拿到的是**宿主 stub**（记忆打房间 KV），不是提供方 `provide()` 里的闭包。没挂上对应 provide 时该包 `pending`，房间不崩。

复制其中一个目录改 `id` / `name` 即可。

```json
{
  "id": "shared-memory",
  "name": "群共享记忆",
  "version": "1.0.0",
  "hostApi": 2,
  "inject": [],
  "provides": ["memory"],
  "permissions": ["storage:room"],
  "hooks": []
}
```

| 字段 | 规则 |
|---|---|
| `id` | 房间内唯一 |
| `version` | 非空字符串（只存，不做兼容矩阵） |
| `hostApi` | 必须是字面量 `2` |
| `inject` | 要消费的 provide 名 |
| `provides` | 对外能力名；可空（纯 hook 包） |
| `permissions` | `storage:room`、`schedule:room`；未知值拒载 |
| `hooks` | 目前只允许 `room.chat.in`。禁止 `setTimeout` / `setInterval` |
| `budget` | 可选。`hookPerMin`（默认 120）、`schedulePerMin`（默认 20）。整房还有 300/40 的上限。超限跳过该包本窗口内的后续调用，房间不拆。 |
| `name` | 可选；缺省用 `id` |

`seats` / `agent` 若出现会被忽略。

## ctx

只能通过 `ctx` 拿能力。禁止 `require` / `import` / `from '…'` / `Function` / `eval` / `process` / `setTimeout` / `setInterval`（含别名与 `globalThis['setTimeout']`）。字符串和注释里提到这些名字不会被拒。扫描是护栏；`mod.js` 在 vm 里还会关掉字符串代码生成。

内建：`room`、`log`、`onDispose`、`provide`、`hooks`。  
声明了 `storage:room` 才有 `ctx.storage`。  
`inject` 里的名字才会出现在 ctx 上。未声明的 `get` 会抛错。

`provide(name, api)` 必须在 `activate` **同步返回前**调用，且 `name` 要写在 `provides` 里；`api` 的值必须都是函数。只登记方法名，函数不会离开沙箱。`activate` 返回后，实际 `provide` 的名字集合必须与 manifest `provides` 一致，否则该包 `failed`，声明了却没挂上的下游走 `pending`。

`hooks.on("room.chat.in", fn)` 必须先在 manifest 里声明该 hook。

## 权限：`storage:room` 是房间全局

任何持 `storage:room` 的扩展都能 `ctx.storage.namespace("memory")` 读到同一份共享记忆。v1 **不会**按包 id 隔离 namespace。这是权限的信任含义。房主可在「房间设置」里直接增删这些条目。

## `memory` 工具（编译到本房 Agent 席位）

`provides: ["memory"]` 且 `activate` 里成功 `provide("memory", …)` 后，房主会把进程内 MCP `mod-memory` 挂到该房已有 Agent 席位：

| 工具 | 参数 | 行为 |
|---|---|---|
| `memory_get` | `{ key }` | 读 |
| `memory_set` | `{ key, value }` | 写；超限返回错误文本 |
| `memory_list` | `{ prefix? }` | 列 key |
| `memory_search` | `{ query }` | 搜 key/value |

短名和 `mcp__mod-memory__memory_*` 都会放进 `allowedTools`。卸扩展时立刻从已打开的席位拆掉，不等下一句话。

没有 SDK 符号时**不会**从模型文本里解析记忆指令。

## 聊天 railway

`hooks: ["room.chat.in"]` 后可：

```js
ctx.hooks.on("room.chat.in", (env) => {
  if (env.text === "stop") return { action: "drop", reason: "blocked" };
  return { action: "replace", value: { ...env, text: env.text.trim() } };
});
```

没有 `next`。返回 `continue` / `replace` / `drop`。超时 50ms 或抛错视为放过原文。`drop` 会在时间线加一条 `source: "kernel"` 的系统消息，客人也看得到。

Hook 内禁止再投递 `chat.user` 或调玩法 `mod.intent`。

## 房间调度

`permissions: ["schedule:room"]` 后可：

```js
ctx.schedule.every(60000, () => ({ text: "到点了", toAgent: false }));
// 官方 room-pulse 不返回 text：只占调度缝，UI 用绿点表示活着。
```

间隔最短 1 秒，每包最多 4 个任务。`text` 会写成 `source: "kernel"` 的系统消息；`toAgent: true` 时再送给一个未接管的 Agent 席位。定时器由宿主管，卸载扩展即停。SDK 的 Cron 工具管不到房间总线，所以这是自建的最小缝。

## 预算

```json
{ "budget": { "hookPerMin": 30, "schedulePerMin": 6 } }
```

计数按 60 秒窗口滚动。超包预算或整房预算时，该 hook / 定时任务本窗口内被跳过（聊天按原文继续），打 `[mod-kernel] budget` 日志。不把包打成 failed。

## 有边界自改善（阶段 4）

AI / 房主可以换已启用扩展的 **`mod.js` 实现**，不能换 `inject` / `provides` / `permissions` / `hooks`。提案不收新 manifest，边界永远用当前包的。

流程：提案 → 孤立 `ModKernel.start` 试用 → 按自主权放行。

| 级别 | 行为 |
|---|---|
| L0 | 试用通过也只挂起，房主在设置里批准或拒绝 |
| L1 | 试用通过且 `provide` 集合不变 → 自动替换；provide 有变则仍待批 |
| L2 | 试用通过即替换（仍同 manifest） |

试用失败（禁 import、activate 抛错、pending/failed）一律拒绝。应用前把上一版 `mod.js` 写入房间改善日志，可回滚一版。已应用（或回滚后）的 live 源码按房间落盘；卸包再启用同一 pack 时先试用这份 live，通过则覆盖打包目录里的官方 `mod.js`。试用失败则仍用打包目录，房间不拆。时间线会追加 `source: "kernel"` 的审计条。客人不能提案、不能执行新源码。

房主入口在 **房间设置 → 扩展改善**：选自主权、粘贴 `mod.js`、处理待批、回滚。本阶段不自动找模型改代码。

房间挂了任意 hostApi 2 包后，房内 Agent 席位会额外挂上进程内 MCP `mod-improve`（卸掉最后一个扩展即拆掉）：

| 工具 | 参数 | 行为 |
|---|---|---|
| `kernel_list` | 无 | 已挂扩展与 manifest 边界、状态 |
| `kernel_get_source` | `{ pack_id }` | 当前 live `mod.js` |
| `kernel_propose` | `{ pack_id, mod_js, note? }` | 走同一条试用 / 分级放行管线 |
| `kernel_status` | 无 | 自主权、提案状态（不含源码）、可回滚 pack id |
| `kernel_rollback` | `{ pack_id }` | 回滚上一版 |

Agent **没有** `apply` / `reject`。L0 待批仍由房主在设置里点。客人席位不挂这些工具。

## 房间里怎么用

1. 先创建房间，再点 **房间设置**：玩法模组单选（最多一个），扩展可多选。
2. 玩法启用后，在玩法面板里开始当局。
3. 房主在设置里维护共享记忆条目。
4. 房主可在设置里提交同边界的 `mod.js` 提案（L0 待批 / L1–L2 按上表自动应用），并回滚上一版。
5. 房内 Agent 可用 `kernel_propose` 走同一条管线；不自动找模型改代码。
6. 客人只看扩展列表和聊天结果，不执行 `mod.js`。
