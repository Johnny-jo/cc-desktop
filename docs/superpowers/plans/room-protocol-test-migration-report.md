# Room protocol v2 测试迁移报告

日期：2026-09-05（Asia/Shanghai）。

## 结果与范围

已迁移 19 处主动任务 fixture，并更新协议版本 fixture。保留原有 98 个测试，新增 1 个 v1 帧拒绝测试。首次迁移后剩余的 2 条停止审计断言，已按用户补充确认的新规格完成更新。本轮回归 `room-turn-ask.test.ts` 和 `room-remote-exec.test.ts`，30/30 个测试通过；其余四个文件沿用上一轮通过结果，本轮未重复运行。

本次仅修改以下 6 个测试文件和本报告：

- `apps/desktop/electron/main/room-remote-exec.test.ts`
- `apps/desktop/electron/main/room-borrow-ai.test.ts`
- `apps/desktop/electron/main/room-mod.test.ts`
- `apps/desktop/electron/main/room-turn-ask.test.ts`
- `apps/desktop/electron/main/room-transport.test.ts`
- `packages/shared/src/room-protocol.test.ts`

开始时工作区已有其他修改，其中 `room-mod.test.ts` 和 `room-protocol.test.ts` 已包含活动参与逻辑测试。本次以接手时内容为基线保留这些改动。未修改任何生产代码、`room-multi-agent.test.ts` 或 `styles.css`，未提交、未推送。

补充规格这一轮仅追加修改 `room-turn-ask.test.ts` 和本报告；`room-remote-exec.test.ts` 用于相关回归，未追加修改。

## 发任务 fixture 的统一形式

四个执行测试文件各增加一个局部 `sendToAgent` helper：

1. 从发起方自己的快照中查找 `kind === "human" && occupantUserId === localUserId` 的席位，作为 `send` 的发言席位。
2. 根据测试显式选定的 Agent 席位 ID 取得名称，正文构造为 `@名称 原任务文本`。
3. 传入第六个参数 `RoomMention[]`：`[{ seatId: agent.id, start: 0, end: label.length }]`，其中 `label` 为 `@名称`。`end` 不包含后面的普通空格，正文在该位置为 ASCII 空格 U+0020。
4. 直接调用真实 `RoomService.send`，继续经过提及校验、身份校验和原执行路径；没有从普通文本推断授权，也没有 mock 掉执行入口。

原任务文本、发送方身份、目标 Agent、工作区及模型绑定均保留。普通聊天、引用、撤回和 Mod 生命周期触发不添加提及。

## 逐项场景目的与 fixture 变化

### room-remote-exec.test.ts：2 处

| 原场景目的 | 迁移的任务 fixture | 保留的关键断言 |
| --- | --- | --- |
| 远程席位在客人机器执行，并回传结果 | 客人 human 提及 `远端小助手`，任务仍为 `帮我修 a.ts` | 客人执行一次、宿主不执行、隐藏会话、实时文本与工具事件、结果及派发审计、改动只读投影、两端 exec-log 的 turnId 与状态、结束后清除 running/live |
| 执行节点离线时给出系统提示 | 节点离线后，宿主 human 提及同一 Agent，任务仍为 `在吗` | 发送成功，时间线存在含 `不在线` 的 system 消息 |

其余项目路径同步、重命名和消息撤回测试保留。

### room-borrow-ai.test.ts：3 处

| 原场景目的 | 迁移的任务 fixture | 保留的关键断言 |
| --- | --- | --- |
| 按 workspaceUserId 路由，并遵守 filePolicy=deny | 宿主 human 提及 `借脑`，任务 `改一下` | workspace/executor 轴、拒绝审计、宿主和客人均不启动会话 |
| 文件主人允许时在其机器执行 | 宿主 human 提及 `允许改`，任务 `动手` | permissionMode 为 auto、客人执行一次、助手结果回传 |
| 本机工作区借用另一成员的 AI | 宿主 human 提及 `借脑改自己`，任务 `帮我改本机` | 本机执行一次、skipCpa、guest-sonnet 模型、回环代理 URL、room-borrow token、客人席位未运行 |

管理员踢人权限以及 AI 模型共享、撤销回退场景保留。

### room-mod.test.ts：3 处

| 原场景目的 | 迁移的任务 fixture | 保留的关键断言 |
| --- | --- | --- |
| 挂载 improve MCP，并在卸载后移除 | 宿主 human 提及 `ImpBot`，任务 `can you improve?` | 会话启动、mod-improve 与工具白名单、无 mod-memory、卸载后 syncExtras 不含 improve |
| 给 Agent 注入共享记忆 MCP | 宿主 human 提及 `MemBot`，任务 `remember foo=bar` | replaceExtras、mod-memory、mod-improve、memory_set/kernel_propose 白名单 |
| 禁用扩展时同步移除现有 Agent extras | 宿主 human 提及 `MemBot`，任务 `hi` | 会话启动、扩展不再 active、syncExtras 被调用且移除 mod-memory |

活动包参与、观众普通聊天、私有视图、运行时错误、Mod Agent 工具、引用、共享记忆、调度、hook 改写/丢弃、预算和改进回滚等原场景保留。玩法 `hostApi: 1`、kernel `hostApi: 2` 和 hook 内容中的 `v1`/`v2` 不是群聊协议版本，不修改。

### room-turn-ask.test.ts：11 处

| 原场景目的 | 迁移的任务 fixture | 保留的关键断言 |
| --- | --- | --- |
| 客人任务访问宿主工作区须先审批 | 客人 human → `bot`，`帮我改 a.ts` | 审批前不执行、允许后执行一次、pathJail、路径守卫/skill 提示、resolved 广播 |
| 拒绝任务且留下审计 | 客人 human → `bot`，`删库跑路` | 审批事件、拒绝成功、拒绝或超时审计、无执行 |
| filePolicy=allow 直接执行 | 客人 human → `bot`，`随便改` | 执行一次、不弹审批 |
| 宿主任务访问客人工作区须先审批 | 宿主 human → `远端 bot`，`读一下 b.ts` | 客人本机审批、允许前两端不执行、客人执行一次、客人 pathJail |
| 本机上下文占用低于阈值 | 客人 human → `bot`，`干点活` | 审批、两端 ratio=0.4、不压缩 |
| 本机上下文超阈值自动压缩 | 客人 human → `bot`，`继续` | ratio 输入 0.8、压缩一次、autoContinue=false、徽标清零、压缩审计 |
| 远端上下文超阈值自动压缩 | 宿主 human → `远端 bot`，`跑一轮` | 客人审批、ratio 输入 0.9、客人压缩一次、宿主徽标清零与审计 |
| 远端上下文低于阈值 | 宿主 human → `远端 bot`，`跑一轮` | 客人审批、宿主快照 ratio=0.5 |
| 本机 stopSeat 中止输出且留记录 | 客人 human → `bot`，`跑`；客人显式命名为 `任务发起人` | 审批、running、stop 成功、abort(sess-run)、running=false；请求审计精确关联 taskId 和真实操作者，运行终态前为 stopping、结束后为 cancelled |
| 远程 stopSeat 中止节点会话且留记录 | 宿主 human → `远端 bot`，`干活` | 客人审批、启动一次、stop 成功、abort(sess-remote)；请求审计精确关联 taskId 和真实操作者，发出请求及节点收到 abort 后仍为 stopping，终态回报后为 cancelled |
| 本机 thinking/text 增量流式与清理 | 客人 human → `bot`，`想想再答` | 审批、running、精确 thinking/text 内容、结束后移除 liveExec |

14 个 `pathJailViolation` 用例及其全部断言保留。

### room-transport.test.ts：2 个版本字段

`ignores unknown frame types after join` 的目的，是验证两个未知帧类型和一个伪造 roomId 帧均被忽略并记入 abuse，且连接仍可使用。

将 `bogus.frame` 和 `state.snapsh0t` fixture 的 `v: 1` 改为 `v: ROOM_PROTOCOL_VERSION`，使它们进入 unknown-type 分支。保留原来 `items` 不变、成员数为 2、`abusedBefore + 3` 和后续 `hello` 可取得 `mod.offer` 的断言。未修改加密、握手、重连、审批和其他 abuse 用例。

### packages/shared/src/room-protocol.test.ts：版本正例及 v1 负例

- `makeRoomFrame` 原来同时要求 current 和 1；保留 current 断言，将固定版本断言明确为 2。
- 原 `parseRoomFrame accepts mod frames with v: 1` 正例改为接受 current，构造的 v 和解析后的 v 断言均使用 `ROOM_PROTOCOL_VERSION`；继续逐个校验类型、非空结果和 roomId。
- 新增 `parseRoomFrame rejects mod frames with v: 1`：逐个对 9 种已知 Mod 帧将 current 帧版本覆盖为 1，严格断言解析结果为 null。
- 保留原 CDR1 邀请拒绝用例，以及 Mod hostApi/kernelApi、活动参与、借用 AI、state.live、哈希和校验码断言。

## 验证证据

所有测试均使用指定直接命令运行，未使用 pnpm 封装、skip、only 或放宽等待时限。

工作目录 `D:/gitRep/ccDesktop/apps/desktop`：

```text
node node_modules/vitest/vitest.mjs run electron/main/room-remote-exec.test.ts electron/main/room-borrow-ai.test.ts electron/main/room-mod.test.ts electron/main/room-turn-ask.test.ts electron/main/room-transport.test.ts --silent
```

工作目录 `D:/gitRep/ccDesktop/packages/shared`：

```text
node ../../apps/desktop/node_modules/vitest/vitest.mjs run src/room-protocol.test.ts --silent
```

| 文件 | 迁移前失败 / 总数 | 最近一次验证通过 / 总数 |
| --- | --- | --- |
| room-remote-exec.test.ts | 2 / 5 | 5 / 5 |
| room-borrow-ai.test.ts | 3 / 5 | 5 / 5 |
| room-mod.test.ts | 3 / 36 | 36 / 36 |
| room-turn-ask.test.ts | 11 / 25 | 25 / 25 |
| room-transport.test.ts | 1 / 14 | 14 / 14 |
| room-protocol.test.ts | 2 / 13 | 14 / 14 |

基线运行开始于 23:36:45–23:36:46：desktop 20 失败、65 通过，shared 2 失败、11 通过。迁移后运行开始于 23:40:27：desktop 退出码 1，83 通过、2 失败；shared 退出码 0，14 通过。

因主控同时修改生产实现，交接前于 23:46:42 再次执行上述两个完整命令，结果一致：desktop 83 通过、同样 2 条停止审计断言失败，shared 14 通过。

第一轮针对接手时保存的六份文件内容做了逐项比对：扣除明确列出的 helper/import、19 处调用替换、协议版本迁移和新增 v1 负例后，全部与原文件内容一致（仅归一化换行用于比较）。后续仅按用户明确的新规格更新下面两条停止审计断言，并加强任务状态、操作者与唯一审计的校验。原审批、执行、abort 和清理断言保留，没有删测试或放宽等待时限。指定测试文件的 `git diff --check` 退出码为 0。

## 停止审计新规格（已落实）

首次迁移后的两条失败均来自 `room-turn-ask.test.ts` 对 `停止了「bot」的输出` / `停止了「远端 bot」的输出` 的旧文案断言。用户补充明确：远端请求发出后先显示 stopping，收到终态才显示 cancelled；请求阶段不能声称已停止。任务审计应由 `task.control` 记录真实操作者，`applySeatStop` 不重复归给原发起人。

修改前核对了两个 fixture：均使用 `pendingStart` 返回尚未 resolve 的执行 Promise，`abort` 是不负责结束 Promise 的 spy，`resolve()` 在停止断言之后才调用。因此停止时两者都有活动任务，不适用“执行 Promise 已结束、没有活动任务”的 legacy 分支。测试也新增停止前 task.status=running 的断言，防止 fixture 意外变成已经完成的任务。

两条用例现在都从停止前快照取得目标任务的完整 taskId 和操作者对应的成员名称，严格要求停止请求新增的 system 审计只有一条，且满足：

```text
taskId: 实际活动任务的完整 ID
text: 操作者名称 + " 请求中断任务 " + taskId.slice(0, 8)
```

本机用例由客人发起、宿主停止。`joinGuest` 增加可选 name 参数，仅该用例将客人命名为 `任务发起人`；显式验证操作者与发起人的 userId、name 均不同，以检出误归属和重复审计。保留 stop 成功、abort(sess-run) 和 seat.running=false 的原断言，新增 task.status=stopping；resolve 执行 Promise 后再等待 cancelled。

远程用例保留宿主发起并停止、客人机器执行的关系。发出 stop 请求后立即验证 stopping；等客人 abort(sess-remote) 已调用但执行 Promise 尚未 resolve 时，再验证仍为 stopping。resolve 后等待终态回到宿主，验证 cancelled。原远程绑定、审批、启动一次和 abort 断言保留。

没有更改生产代码或无活动任务分支的审计行为。

## 补充规格后的最终回归

工作目录 `D:/gitRep/ccDesktop/apps/desktop`：

```text
node node_modules/vitest/vitest.mjs run electron/main/room-turn-ask.test.ts electron/main/room-remote-exec.test.ts --silent
```

- 23:51:44 修改前复现：28 通过、同样 2 条旧审计文案断言失败，退出码 1。
- 23:53:55 修改后验证：2 个文件全部通过，`room-turn-ask.test.ts` 25/25、`room-remote-exec.test.ts` 5/5，共 30/30，退出码 0。

本轮没有新增或删除测试用例，两个剩余问题已按确认后的规格完成测试迁移。
