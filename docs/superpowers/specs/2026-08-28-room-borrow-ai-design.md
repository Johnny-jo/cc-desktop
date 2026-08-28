# 群聊借用 AI + 工作目录拆轴

| 项 | 内容 |
|---|---|
| 日期 | 2026-08-28 |
| 状态 | 已批准，按方案 A 落地 |
| 前序 | `docs/room-remote-exec-design.md`（执行节点下沉） |

## 问题

席位 `executorUserId` 把「谁的模型」和「谁的文件」绑死在一台机器上。Agent 是派发任务的工人，不是可借用的脑子。无法：A 借 B 的模型改 A 自己的项目；也无法在不改席位绑机的情况下换工作目录。

## 决策

- **方案 A**：Agent 循环跑在**文件主人**机器上（`cwd` = 对方当前打开的项目）；模型请求经群聊通道转到 **AI 主人** 的 CPA。Key 不出 AI 主人机器。
- 路径来源：对方**当前打开的项目**（已有 `projectPath` 广播，切项目下一轮跟着走）。
- 管理员：房主提权；管理员可改 Agent 席位 + 踢人（不能踢房主/其他管理员；不能改名、解散、提权、改别人的策略）。

## 数据模型

`RoomSeat`（Agent）：

- `aiUserId`：用谁的 CPA / 模型目录。缺省 = 创建者。
- `workspaceUserId`：在谁当前项目里跑。缺省 = 创建者。
- `executorUserId`：废弃别名，读写时等于 `workspaceUserId`，兼容老快照。
- `model`：选自 `aiUserId` 的模型列表。

`RoomMember`：

- `role`：`host` / `admin` / `member`
- `filePolicy`：`allow` | `ask` | `deny`，缺省 `ask`。管「别人的席位以我为 workspace」时的工具权限。
- `aiShare`：`off` | `pending` | `on`，缺省 `off`。房间级是否把本机模型借给席位。
- `aiModels?`：最近一次上报的模型 id 列表。
- `aiAskBy?`：谁在请求借用（`pending` 时）。

自己指向自己：不走 `aiShare`，`filePolicy` 不拦。

## 同意与席位设定

- 选别人作 AI 来源且对方 `off`：发请求，对方 `pending`，群内横幅同意/拒绝。
- 同意后 `on`，对方机器上报 `aiModels`，席位模型下拉用这份目录。
- 收回共享：所有 `aiUserId` 指向此人的席位回退为 `workspaceUserId`。
- 工作目录下拉 = 成员当前 `projectPath`，不填任意路径。
- 仅房主/管理员改两轴；成员新建席位锁成自己/自己。

## 执行

房主 `runAgentSeat` 按 `workspaceUserId` 决定本机跑还是 `exec.run` 派发（沿用远程执行一期/二期）。

节点上：

1. `filePolicy === deny`（且请求人不是自己）→ 立刻 `exec.result ok:false`。
2. `allow` → 本轮 `permissionMode: "auto"`（破坏性 Bash 仍走现有硬确认）。
3. `ask` / `skip` → 现有 permissionBroker。
4. `aiUserId === 本机` → 本机 CPA（现状）。
5. `aiUserId !== 本机` → 本机起 `127.0.0.1` HTTP 代理，SDK `ANTHROPIC_BASE_URL` 指过去；请求经 `ai.http` 帧转到 AI 主人，由其 CPA 应答。本机 CPA 不必 ready。

## 新帧

`seat.update`、`member.role`、`member.kick`、`ai.share`、`ai.ask`、`ai.models`、`ai.http`。

`ai.http` 分片（base64），默认帧上限 256KB；路径/方法只在第一片。

## 不做

- 不暴露对方整盘、不填任意绝对路径。
- 不把 AI 主人的真实 token 发给文件主人。
- 不做每条消息的临时目标选择器（改席位设定即可）。
- 管理员不能提权、改名、解散、改别人 `filePolicy`/`aiShare`。
