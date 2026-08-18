# Mod 机制（房间玩法工坊）设计

**日期：** 2026-08-14（2026-08-15 审查修订）
**状态：** 审查修订稿，待用户审查
**范围：** 房间玩法运行时（`host.js` 权威逻辑）、入房前一键同步下载、状态同步、Agent 参与接口。v1 **不做** mod 自定义 UI。公开市场、细权限、脚手架为后续阶段。

---

## 0. 本次审查修了什么

对照现有 `RoomService` / `room-protocol` / CLI 轻冻结规格后，原稿有以下硬伤，已在正文中改掉：

| 问题 | 原写法 | 修订 |
|---|---|---|
| 权威逻辑位置自相矛盾 | 4.2 写「房主侧 Worker」又写「沙盒只在渲染进程」 | 权威逻辑在**主进程 UtilityProcess**；v1 无 iframe，人类只用宿主通用壳 |
| 无视已有握手 | 当从零设计 | 接上现成的 `requireMods` / `modChecksum` / 邀请码字段；注释里的「M3 用真实文件哈希」就是本期 |
| 「成员零配置」与现握手冲突 | 先入房再推包 / 校验码直接踢人且无下载 | **入房前**告知缺包；主按钮「同步下载并加入」一键拉包验哈希再 join。未装上不可加入 |
| 信息隐藏只写了 Agent | 人类仍收全量 `state.snapshot` | 人类与 Agent 都走「公开视图 + 本席位私有视图」 |
| 「只有 ui.js 也合法」 | 与权威模型打架 | **房间共享玩法必须有 host.js**；v1 带 `ui.js` 直接拒绝启用 |
| Plugin 当「行为段」 | 变相两套 mod 格式 | 分层：房间 Mod 是本规格；官方 Plugin 是包内可选 sidecar，只喂给 Agent 席位 |
| 结对编程 / 自定义面板 | 原稿含 ui.js + iframe | **v1 不做 mod UI**：无 `ui.js`、无 iframe、不改 Changes / Editor。人类只靠宿主通用壳看视图、点 `getActions` |
| Agent 每步都灌视图 | 会炸 context | 只在 `shouldPromptAgent` 为真时注入 |
| 操作日志 replay 未约束随机数 | 现成骰子用 `Math.random()` | host API 提供种子 RNG，host.js 禁止自带随机源 |
| 崩溃隔离「实现期再定」 | 占位 | 权威进程崩溃 ≠ 房间解散；标记玩法失效，可从快照恢复 |

---

## 1. 背景与动机

CC Desktop 已有协作房间：局域网多人共用 Agent 会话，支持邀请码、席位、接管、内置骰子/猜拳。房间协议 v1 已经为模组留了挂钩：

- `RoomSnapshot.requireMods` / `modChecksum`
- 邀请码字段 `m`（`modChecksum`）
- 加入握手：`requireMods && checksum 不一致 → 拒绝`（**本期改掉拒绝时机，见 8.2**）
- `shortChecksum` 注释写明「M3 用真实文件哈希」

目前房间「玩法」仍写死在宿主（`game.dice` / `game.rps` 两个专用帧）。第三方无法创造新的房间体验。

Claude Code Plugin（打包 Slash Commands / Subagents / Skills / Hooks / MCP）证明了「可分发能力包」可行，但只覆盖 Agent 行为，不覆盖界面与多人规则。

本设计以「Steam 创意工坊 × 多人游戏」为心智模型：**房间是一局，mod 是玩法包**。房主启用一个 mod，全房间的规则、界面、Agent 角色随之改变。

典型场景（v1 必须能表达）：

- 狼人杀：信息隐藏 + Agent 当法官/玩家
- 投票 / 计时器 / 计分板
- 教学：Agent 出题，学员只读 + 答题

明确推后的场景（不要用它们倒逼 v1 API）：

- 改变更栏 / 编辑器的「结对编程皮肤」（宿主 UI 定制，见 §3）
- 公开工坊浏览与评分
- 编程竞赛里 Agent 任意读盘交卷（需要文件系统权限，见 §3）

## 2. 设计目标

1. **机制唯一**：只有一种房间 Mod——`manifest.json` + `host.js`（v1 无 `ui.js`）。加载、权限、同步、打包只有一套。
2. **写法分层**：声明式不是第二种 mod，而是 SDK 糖。简单包调状态机糖，复杂包写 `reduce`，升级不换格式。
3. **房间原生**：同步、席位、Agent 参与是一等公民。
4. **Agent 是原生玩家**：三接口 + 回合门闩；规则面前人机平等。
5. **缺包不可入房，一键同步**：加入启用了 mod 的房间前，先告知缺包；主按钮「同步下载并加入」一次完成拉包、验哈希、进房。未装上（或校验和对不上）不能加入。
6. **接上现有房间，不另起炉灶**：通用 `mod.*` 帧扩展协议 v1；内置骰子/猜拳暂时保留，不阻塞。

## 3. 非目标（本期不做）

- 公开市场 / 在线浏览与评分（先本地目录 + 入房前按校验和拉包）
- **mod 自定义 UI**（无 `ui.js`、无 iframe、不改 Changes / Editor / 主题）
- 宿主 UI 任意定制（主题系统已有）
- mod 访问任意文件系统 / 任意网络
- 细粒度版本兼容矩阵（只做 `hostApi` 整数 + semver）
- 帧同步 / 客户端确定性模拟
- 防恶意房主（局域网熟人信任模型，明文声明）
- 把内置骰子/猜拳改写成第一个官方 mod（可后续做；v1 它们仍走专用帧）
- 可视化 mod 生成器

## 4. 核心决策

### 4.1 统一运行时，拒绝真·混合

| 方案 | 结论 |
|---|---|
| 纯声明式 JSON UI | 天花板真实：原语永远不够 |
| 真·混合（两套引擎） | **否决**。生态分裂 |
| **统一运行时 + 分层 SDK（采纳）** | 机制唯一；糖只是编译到同一 `createGame` 接口 |

### 4.2 进程：权威在主进程 UtilityProcess；v1 无自定义 UI

这是审查后最重要的更正。

```
┌─ 房主主进程 ─────────────────────────────────────┐
│  RoomService（WebSocket、席位、聊天、权限）        │
│       │ IPC                                         │
│  ModHost（UtilityProcess，无 Node 模块任意 require）│
│       │  跑 host.js：reduce / 视图 / Agent 门闩     │
└───────┼─────────────────────────────────────────────┘
        │ 公开补丁 + 按席位私有视图
┌───────▼─────────────────────────────────────────────┐
│  各端渲染进程                                        │
│  宿主通用壳：阶段/公开视图 + 本席位私有视图          │
│  + 由 getActions 生成的按钮/表单（无 iframe）        │
└─────────────────────────────────────────────────────┘
```

**为什么权威不能放渲染 Worker**

- CLI 轻冻结规格明确：`cliMode` 时 **不渲染 `RoomStage`**。权威若在渲染层，进 CLI 房间玩法直接死。
- 渲染崩溃 / 刷新不应丢当局状态（与 transcript 主进程权威同一理由）。
- Node Worker 默认能 `require('fs')`，不是沙盒。权威侧用 **Electron UtilityProcess**：只通过 MessagePort 暴露白名单 API，崩溃隔离，房间通信层不受影响。

**v1 人类界面 = 宿主通用壳，不是 mod 画的**

- 渲染 `getPublicView`（JSON：阶段、计分、存活名单等）+ 本席位 `getSeatView`。
- 操作来自 `getActions`：宿主按 JSON Schema 生成按钮/简单表单，提交即 `mod.intent`。
- **不**加载 `ui.js`，**不**开 iframe，**不**改 Changes / Editor。
- 每房间最多 **1 个**活跃玩法 mod。
- 画板级自定义绘制推到「mod UI」后续阶段；v1 不承诺高频本地预测。

性能：真正贵的是同步粒度。v1 只有低频率意图（投票、刀人、提交答案），合批 API 不做。

### 4.3 同步模型：权威房主 + 意图日志 + 双视图

| 模型 | 结论 |
|---|---|
| **权威服务器** | 权威方就是房主主进程，与现房间生命周期一致 |
| CRDT | 文档型可在某个 mod **内部**自选；宿主不提供 |
| **意图日志** | 追加 `Intent`，用于恢复与日后回放；日常同步发**视图补丁**，不要求每端重放 |
| 帧同步 | 排除 |

日常数据流：

```
成员通用壳 ── Intent（getActions 点选）──> 房主 RoomService
                            │ 鉴权（谁、哪个席位、是否轮到）
                            ▼
                         ModHost.reduce(state, intent, ctx)
                            │ 合法：新 state + 追加日志 + 可选快照
                            ▼
              广播 mod.patch（公开视图）
              单播 mod.priv（该成员的席位私有视图）
              若 shouldPromptAgent(seat)：注入该 Agent 会话
```

**日常不同步全量 state，也不默认重放全日志。** 日志在房主落盘，用于崩溃恢复、日后回放。成员入房/重连只收：当前公开视图 + 自己的私有视图 + `seq`。

并发：RoomService 对同一房间的 intent **单队列串行**喂给 ModHost。`room-protocol` 已有 `seq`，补丁带 `seq`，旧补丁丢弃。

### 4.4 随机数与确定性

`reduce` 必须在给定 `ctx` 下确定性（崩溃恢复要重放一段日志）。

- `ctx.rng()` 由宿主提供，种子写入该局元数据。
- `ctx.now()` 取意图进入权威队列的时间，不取 Worker 墙钟。
- host.js 使用 `Math.random` / `Date.now` / 网络 = 包校验失败或运行时拒绝。

现有骰子仍用宿主自己的 `Math.random`，不走 ModHost，不受这条约束。

## 5. 信息隐藏（人类与 Agent 同一套）

当前房间每次变动都 `broadcast(state.snapshot)`，**全员看见全部席位与时间线**。玩法 mod 不能复用这条通道传隐藏信息。

host.js 必须实现：

```javascript
getPublicView(state)          // 全员可见
getSeatView(state, seatId)    // 本席位私有（身份、夜晚信息、手牌）
```

投递规则：

| 接收方 | 收到 |
|---|---|
| 人类成员 | `public` + **自己占用/接管的席位**的 `seatView` |
| 观战（无席位） | 仅 `public` |
| Agent 席位 | `getAgentView`（默认 = seatView 的叙事包装，可覆盖） |
| 房主本人 | **不**自动拿全知视图。房主要当法官，必须占一个「法官」席位 |

接管：人类接管 Agent 席位后，该人类改收该席位 `seatView`；被接管的 Agent 本回合不再 `shouldPromptAgent`。归还后恢复。

**禁止**把完整 `state` 放进 `RoomSnapshot` 或聊天时间线。时间线仍只用于人话/系统消息；玩法状态是另一条数据面。

## 6. Agent 参与接口

```javascript
getAgentView(state, seatId) → {
  narrative: string,
  facts: object,      // 不得包含该席位不该知道的字段
  history: unknown[]  // 窗口由作者截断
}

getActions(state, seatId) → {
  [name]: { params: JSONSchema, hint?: string }
}

getPrompt(state, seatId) → string

shouldPromptAgent(state, seatId) → boolean
```

循环：

```
reduce 之后
  → 对每个 Agent 席位：若 shouldPromptAgent
      → 生成 view + prompt + 当前 actions
      → 注入该席位已有 session（不新建隐形会话）
      → Agent 调 room_mod_act
      → 转成 Intent，走同一条权威队列
      → 非法：工具返回错误（含当前合法 actions），Agent 自行重试
```

要点：

1. **门闩**：禁止「每次补丁都灌一轮」。狼人杀只在「轮到该狼发言/刀人」时为真。
2. **工具不动态挂第三方 MCP**。宿主提供**一个**内置工具 `room_mod_act`（参数：`action` + `payload`）。当前合法 actions 放进 tool description / 首次注入消息。避免 `strictMcpConfig` 下插件 MCP 膨胀，也避免每阶段热重载 MCP。
3. **官方 Plugin sidecar**（可选）：包内 `plugin/` 按 Claude Code plugin 格式，启用该房间时注入对应 Agent 席位的 `options.plugins`。它只增强 Agent 能力（技能、斜杠命令），**不**充当第二种房间同步机制。
4. **多 Agent**：每个 Agent 席位沿用现有 `RoomSeat.sessionId` 独立会话。UI 提示 Token 会按席位倍增。
5. **上下文**：作者截断 `history`；已有自动压缩兜底。注入用一条 user 消息，不要把整个 public+private 视图追加成聊天时间线永久记录（会话 transcript 仍会留下——压缩时优先丢掉旧的 `room_mod` 注入块，实现期用固定前缀标记）。

## 7. 包结构

```
my-mod/
├── manifest.json
├── host.js          # 必须
└── plugin/          # 可选；官方 Claude Code plugin（Agent sidecar）
```

v1 **禁止**带 `ui.js`：有则拒绝启用（避免半成品自定义 UI 混进当局）。

`manifest.json`（字段钉死，避免实现期再猜）：

```json
{
  "id": "werewolf",
  "name": "狼人杀",
  "version": "1.0.0",
  "hostApi": 1,
  "permissions": [],
  "seats": {
    "min": 4,
    "max": 12,
    "roles": ["seer", "wolf", "villager", "judge"]
  },
  "agent": true
}
```

- `id` + `version` 参与校验和。
- `hostApi` 整数：宿主只跑 `=== 当前支持版本` 的包；不理解则拒绝启用。
- `permissions` v1 只允许空数组。非空 = 拒绝加载。为以后 `net` / `fs` 留位，避免静默提权。
- `seats.roles` 是**玩法角色**，不是 `RoomSeat.kind`。开局由 `reduce` 的第一条系统 intent（`mod.start`）分配，写在 state 里，经 `getSeatView` 透露。
- 校验和：对 `manifest.json` + `host.js` 做真实文件哈希（实现 `shortChecksum` 注释里的 M3），写入房间 `modChecksum` 与邀请码。可选 `plugin/` 不进房间校验和（它只影响房主侧 Agent 席位）。

**非法组合**

| 包内容 | 待遇 |
|---|---|
| 有 host.js | 房间玩法 mod |
| 带 `ui.js` | v1 **拒绝启用** |
| 只有 plugin/ | 走设置里的普通 plugin 安装，不走房间 Mod |

## 8. 与现有房间的接合

### 8.1 协议

`ROOM_PROTOCOL_VERSION` 仍为 **1**（旧客户端不认识的 `type` 会被 `parseRoomFrame` 收下——它只校验 `v` / `roomId` / `type` 存在）。新增 type，不升 `v`，避免旧客户端在 `join` 时被「协议版本不兼容」误伤。

已有 `hello` 帧改为**入房前窥探**：连上 WS 先 `hello`，未 `join` 不算进房、不占席位、不进成员列表。

新增 / 明确用途的帧：

| type | 方向 | 作用 |
|---|---|---|
| `hello` | 客人 → 房主 | 窥探，不加入 |
| `mod.offer` | 房主 → 该连接 | `{ id, name, version, checksum, size }`（hello 的回复；无 mod 则 checksum 空） |
| `mod.fetch` | 客人 → 房主 | `{ checksum }` 请求包（仍未 join） |
| `mod.bundle` | 房主 → 该连接 | 分片：`{ checksum, offset, chunk }`（单包上限 512KB） |
| `join` | 客人 → 房主 | 现有；**房间有 mod 时必须带匹配的 `modChecksum`** |
| `mod.intent` | 成员 → 房主 | `{ seatId, name, payload }` |
| `mod.patch` | 房主 → 全员 | `{ seq, publicView }` |
| `mod.priv` | 房主 → 单人 | `{ seq, seatId, seatView }` |
| `mod.fail` | 房主 → 全员 | 玩法进程崩溃/校验失败，房间仍在 |

不把每个玩法做成新的 `game.xxx` 帧。骰子/猜拳维持原样。

### 8.2 入房：告知缺包 + 一键同步下载并加入

拍板：

- **缺包先告知，未下载不能加入。**
- **主路径是一键同步**：缺包或本地哈希与房间不一致时，只有一个主按钮「同步下载并加入」——拉包、验哈希、写入 cache、再 `join`，用户不再先点下载再点加入。

保留现有服务端校验（房间有 `modChecksum` 时，`join.modChecksum` 对不上 → 拒绝并关连接）。

客户端流程：

1. 粘贴邀请码。邀请码已有 `modChecksum`；解码后若带该字段，加入对话框立刻写「此房间需要模组（校验 `xxxxxxxx`）」。
2. 先连 WS，发 `hello`（不 `join`）。房主回 `mod.offer`（id / 显示名 / version / checksum / size）。无 mod 则空 offer，主按钮就是普通「加入」。
3. 客人在 `userData/mod-cache/<checksum>/` 查本地包，对话框按结果换主按钮：
   - **已有且哈希一致**：「将使用本地模组「狼人杀」v1.0.0」→ 主按钮「加入」。
   - **没有或哈希不对**：「缺少模组「狼人杀」v1.0.0（约 n KB）。将从房主同步后再加入。」→ 主按钮「同步下载并加入」。没有单独的「只下载不加入」次按钮（YAGNI）。
4. 点「同步下载并加入」：
   1. 按钮进入进度态（`已下载 x / size`，不可重复点）。
   2. 发 `mod.fetch` → 收分片 → 本地验哈希 → 写入 `mod-cache/<checksum>/`。
   3. 成功后**同一动作内**发 `join`（带 checksum + 密码），进房。
   4. 失败（断线、哈希不对、超 512KB、房主取消）→ 报错，停在对话框，**不曾进房**。可再点重试。
5. 关闭对话框 → 断开 WS，**不曾进房**。下载中途关闭 = 中止 fetch，丢弃不完整分片。

「同步」的含义钉死：对齐**当前这间房、当前这个 checksum** 的包，不是订阅市场更新。房主换包（新 checksum）后再加入 / 再重连，会再次走一键同步。

客人重连（cache 丢失或房主已换 checksum）：重连对话框同样走 hello → 一键同步下载并加入，不静默失败。

服务端规则（相对今天的收紧，不是放宽）：

- 房间 **启用了 mod**（`r.modChecksum` 非空）⇒ 视为必须持包。`join` 缺校验码或对不上 → 现成错误「模组校验码不一致」，关连接。不再提供「先加进来再旁观」的口子。
- 房间 **未启用 mod** ⇒ 不检校验码，与现在一致。
- `requireMods` 字段保留：有 mod 时由宿主强制为 `true`；无 mod 时为 `false`。创建房间 UI 不再单独暴露该开关，避免和「未下载不可加入」打架。
- 旧客户端不会 `hello` / 不会下载：它们若带着过期或空 checksum `join`，会被现逻辑拒绝——这是期望行为。

房主本地启用 mod 时立刻算真实哈希写入 `r.modChecksum`（今天创建房间时该字段是空串），并写入邀请码。

### 8.3 数据面

| 数据 | 谁持有 | 落盘 |
|---|---|---|
| 聊天时间线 `items` | RoomService，已有，上限 400 | RoomArchive 现有路径 |
| 玩法 `state` + `log` | 仅房主 ModHost | `userData/rooms/<id>.mod.json`：快照 + 其后 intent；**不**进 `state.snapshot` |
| 席位 / 成员 | RoomService | 现有 |

客人重连：本地 cache 命中且 checksum 仍一致则直接 `join`；cache 丢失或房主已换包则必须再走 hello →「同步下载并加入」。

房主进程重启：现逻辑会把 open 房间标成 ended。v1 **不**做「重启后续摊」——与当前房间行为一致。当局 log 仍落盘，供以后做恢复时用。

### 8.4 生命周期

- **启用**：仅房主，且当局未 `mod.start` 过（或上一局已 `mod.end`）。热换包 = 先结束当局。
- **开局**：房主点「开始」→ 系统 intent `mod.start`（携带当时席位列表）。人数不满足 `seats.min/max` 则拒绝。
- **加人**：当局进行中新人只收当前视图；是否允许中途入局由 host.js 决定（默认新席位不进已开局 state）。
- **结束**：`mod.end` 或房主停用 → 广播最后 publicView，卸通用壳上的玩法区，清 `modChecksum`。此后新加入不再索包。
- **崩溃**：UtilityProcess exit → `mod.fail`，房间 WebSocket 不动。房主可「从快照重启玩法」或停用。

### 8.5 CLI 模式

权威在主进程，进 CLI 不影响 reduce / Agent 注入。客人进 CLI 只是看不见通用玩法壳；回来再收最新 patch。与轻冻结「不渲染 RoomStage」兼容。

### 8.6 Rewind

房间玩法 rewind **不**绑定消息级 rewind。v1 只提供：

- 房主「重置当局」（回到 `mod.start` 后的 state）
- 崩溃恢复（最近快照 + 后续 intent 重放）

不在聊天气泡上做「回到这一轮」。

## 9. 宿主 API（v1 白名单，hostApi = 1）

host.js 入口：

```javascript
export function createGame() {
  return {
    initialState(),
    reduce(state, intent, ctx),
    getPublicView(state),
    getSeatView(state, seatId),
    getAgentView(state, seatId),     // 可省略，默认包装 seatView
    getActions(state, seatId),
    getPrompt(state, seatId),
    shouldPromptAgent(state, seatId) // 可省略，默认 false
  };
}
```

`ctx`：`{ rng, now, seats, actor }`。`seats` 是 RoomSeat 的只读投影（id / kind / name / occupant / takenOverBy），**不含** `sessionId` 以外的主进程秘密。

**人类操作**：宿主读 `getActions` 的 JSON Schema，生成按钮或简单字段（enum / string / number / boolean）。点选即 `mod.intent`。v1 不提供 `ui.js` / `mount` / `submitThrottled`。

分层糖（打包进 host.js，不是第二种格式）：

```javascript
import { defineMachine } from "cc-mod-sdk";
export default defineMachine({ phases, onAction });
```

v1 不实现可视化生成器；给狼人杀、投票两个示例包当模板。

`publicView` / `seatView` 建议形状（宿主通用壳按这些键渲染，缺了就降级为 JSON 折叠）：

```javascript
{
  title: string,          // 「夜晚 · 第 2 轮」
  phase: string,
  lines: string[],        // 名单、计分、公告
  badges?: { label, tone }[]
}
```

## 10. 安全与信任（v1 够用即可）

- 信任房主：客人下载并缓存房主发来的 `host.js`（自己机器 v1 **不执行** host.js，只为进房验哈希与日后再开 UI 阶段留档）。不防恶意房主。加入对话框与房间顶栏必须展示「模组：id@version · checksum 前 8 位」。
- host.js **只在房主** UtilityProcess 里跑。客人即使缓存了包，v1 也不 spawn ModHost。
- 无 iframe、无客人侧脚本执行，v1 攻击面只剩：恶意 JSON 视图撑爆渲染、恶意超大 bundle。因此 bundle ≤ 512KB，view / intent JSON 建议上限 64KB、深度 8。
- `permissions` 非空即拒。
- 下载发生在 `join` 之前，未进成员列表；滥用 fetch 只耗房主上行，可按连接限速（实现期：同一连接同时只允许一个 fetch）。

## 11. 后续阶段（本文不展开）

1. 本地「我的包」目录管理 UI、导出 zip。
2. **mod 自定义 UI**（`ui.js` + iframe + 房间预留视口）。
3. `permissions` 开放 `net` / 只读项目目录。
4. 示例包迁入内置骰子/猜拳。
5. 房主重启后续摊。
6. 公开工坊。
7. 玩法时间轴 UI（按 intent 步进）。

## 12. 已明确排除

- 帧同步 / 客户端全量重放作为日常同步
- 防恶意房主
- **v1 mod 自定义 UI**（`ui.js` / iframe / 改 Changes / Editor / 主题）
- 未下载仍可进房旁观
- 公开市场
- 多玩法 mod 同时当局

## Key Decisions

- **权威逻辑在房主主进程 UtilityProcess**：CLI 轻冻结不渲染 `RoomStage`，渲染崩溃不得丢当局；客人 v1 不执行 `host.js`。
- **v1 无 `ui.js` / iframe**：人类只用宿主通用壳（`getPublicView` + `getSeatView` + `getActions` 生成按钮/表单）。
- **入房前一键同步**：`hello` 窥探 → `mod.offer` → 缺包则「同步下载并加入」；未装上不可 `join`。
- **日常同步发视图补丁**：不广播全量 `state`；人类与 Agent 都走公开视图 + 本席位私有视图。
- **Agent 门闩 + 单一内置工具 `room_mod_act`**：只在 `shouldPromptAgent` 为真时注入；不热挂第三方 MCP。
- **协议仍为 v1**：新增 `mod.*` 帧，不升 `ROOM_PROTOCOL_VERSION`，避免旧客户端被误伤。
- **校验和是真实文件哈希**：对 `manifest.json` + `host.js` 哈希，实现 `shortChecksum` 注释里的 M3。

## PR Plan

### PR 1: Add mod protocol frames and file checksum

- **Description:** Extend room protocol v1 with `mod.offer` / `mod.fetch` / `mod.bundle` / `mod.intent` / `mod.patch` / `mod.priv` / `mod.fail` payload types. Add a real SHA-256 file checksum for `manifest.json` + `host.js` (M3). Keep `ROOM_PROTOCOL_VERSION = 1`. Do not change RoomService behavior yet.
- **Files/components affected:** packages/shared/src/room-protocol.ts, packages/shared/src/room-protocol.test.ts
- **Dependencies:** None

### PR 2: Add mod package loader, cache, and ModHost runtime

- **Description:** Validate `manifest.json` + required `host.js` (reject `ui.js`, non-empty `permissions`, missing fields, unsupported `hostApi`). Hash the package and cache under `userData/mod-cache/<checksum>/`. Spawn host.js in an Electron UtilityProcess with whitelist ctx (`rng`, `now`, `seats`, `actor`). Persist `state` + intent log to `userData/rooms/<id>.mod.json`. Crash of the utility process must not tear down the room WebSocket; surface `mod.fail` to the caller. Include unit tests with fixture packs.
- **Files/components affected:** apps/desktop/electron/main/mod-package.ts, apps/desktop/electron/main/mod-package.test.ts, apps/desktop/electron/main/mod-host.ts, apps/desktop/electron/main/mod-host.test.ts, apps/desktop/electron/main/mod-host-worker.ts, apps/desktop/electron/main/runtime-paths.ts
- **Dependencies:** PR 1

### PR 3: Wire RoomService handshake, play loop, and Agent tool

- **Description:** Treat `hello` as a pre-join peek that replies with `mod.offer` and does not occupy a seat. Serve `mod.fetch`/`mod.bundle` (≤512KB, one fetch per connection). When a room has a mod, force `requireMods=true`, write the real checksum into `modChecksum` and the invite, and reject `join` on missing/mismatch. Serialise `mod.intent` into ModHost.reduce; broadcast `mod.patch` and unicast `mod.priv`. Host lifecycle: enable, `mod.start` / `mod.end`, reset-to-start, crash → `mod.fail`. Inject Agent turns only when `shouldPromptAgent` is true, via a single built-in `room_mod_act` tool on the existing seat session. Do not put full play state into `RoomSnapshot` or the chat timeline.
- **Files/components affected:** apps/desktop/electron/main/room-service.ts, apps/desktop/electron/main/ipc-handlers.ts, apps/desktop/electron/main/session-manager.ts, apps/desktop/electron/preload/index.ts, packages/shared/src/ipc.ts
- **Dependencies:** PR 2

### PR 4: Add official werewolf and vote example mods

- **Description:** Ship two host.js example packs (werewolf, vote) as templates under `apps/desktop/resources/mods/`. Each must implement `createGame` with public/seat views, actions, and agent latch. No `ui.js`. Used as fixtures and as host-selectable local packs.
- **Files/components affected:** apps/desktop/resources/mods/werewolf/manifest.json, apps/desktop/resources/mods/werewolf/host.js, apps/desktop/resources/mods/vote/manifest.json, apps/desktop/resources/mods/vote/host.js
- **Dependencies:** PR 2

### PR 5: Add sync-download join UI and host generic play shell

- **Description:** Join dialog: after invite paste, peek via hello; show local-hit vs missing pack; primary button is 「加入」 or 「同步下载并加入」. Download progress, then join in the same action; close aborts and never joins. Create-room UI: pick a local/bundled pack (no requireMods toggle). Room stage generic shell renders public + own seat view and `getActions` buttons/simple forms. Host controls: start / end / reset / recover-from-snapshot. Top bar and join dialog show `id@version · checksum[:8]`. Hide play chrome in CLI mode (already unmounts RoomStage).
- **Files/components affected:** apps/desktop/src/components/RoomSidebar.tsx, apps/desktop/src/components/RoomStage.tsx, apps/desktop/src/components/ModPlayPanel.tsx, apps/desktop/src/state/room-store.ts, apps/desktop/src/i18n/zh.ts, apps/desktop/src/i18n/en.ts, apps/desktop/src/styles.css
- **Dependencies:** PR 3, PR 4

