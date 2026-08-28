# 群聊远程执行（分布式 Agent）设计

| 项 | 内容 |
|---|---|
| 文档性质 | 一期 + 二期均已实现（2026-08-28），本文档留作设计依据 |
| 日期 | 2026-08-28 |
| 触发需求 | 「用户 B 让用户 A 的 Agent 在用户 B 的电脑上做文件修改，能不能做到？」 |
| 结论 | **方案 A「执行节点下沉」已全部落地：席位绑定执行节点 + exec.run/event/result/abort 四帧 + 节点本机执行与权限 + 结果回传 + §5 证据链 + 二期流式进度中继与结构化 diff 中继（各端只读）。** |
| 一期偏差 | 房主台账为内存 + exec-log.jsonl 双写，重启后不做台账回放；恢复对账反转为「节点重连主动上报在跑 turnId，房主无记录则回 abort 收敛」——效果等价，实现更简单 |
| 二期实现注 | 流式进度走 `exec.event phase:"note"`（文本 800ms 节流、尾部截 1500 字覆盖式更新；工具切换立即发），房主侧入 `snapshot.liveExec` 轻量广播（不落盘）；结构化改动走 `exec.result.changesDetail`（本轮事件过滤 + 8 文件 × 3 事件 × 16k 截断 + canRestore 抹除），房主合并进 `snapshot.remoteChanges`；节点经 `SessionRunOpts.onSessionId` 早回调在会话创建时即拿到 id，支撑流式映射与中途 abort |

---

## §1 现状（为什么不能）

当前群聊所有 Agent 席位的会话都在**房主主进程**执行（`room-service.ts runAgentSeat`）：

- cwd 固定为房主的 `lastProjectPath`；
- 客人发消息只是向房主发 `chat.user` 帧，客人机器从不运行 Agent；
- 文件修改落在房主文件系统，权限确认也走房主的 permissionBroker；
- 客人只能看到最终文本（`state.snapshot` 全量广播），看不到过程与 diff。

因此「B 让 A 的 Agent 改 B 电脑上的文件」在当前架构下无解：执行点只有一个（房主），且席位不携带「在哪台机器上跑」的信息。

## §2 需求拆解

1. 席位要声明**执行节点**（哪台机器跑这个 Agent），默认 = 创建者本机；
2. 消息路由：房主收到发给该席位的消息后，把执行**转发**给执行节点，而不是本地跑；
3. 执行节点用**本机项目目录 + 本机权限确认**运行会话（写文件必须本机人点头）；
4. 结果（文本 / diff 摘要）回传房主，进房间时间线，全员可见；
5. 断连、超时、并发要有明确语义。

## §3 候选方案

### 方案 A：执行节点下沉（推荐）

每个成员机器是一个执行节点。席位新增 `executorUserId`（创建时默认为发起者，可改）。

- 房主路由：`ingestUserChat` 判定 `seat.executorUserId !== 房主` → 发 `exec.run` 帧给该成员，不再本地 `runAgentSeat`；
- 节点执行：成员端收到 `exec.run` 后用本机 `SessionManager` 起/续会话（cwd = 本机 `lastProjectPath`），权限确认走本机 UI；
- 结果回传：turn 结束发 `exec.result`（最终文本 + diff 摘要），房主 ingest 为 `kind:"assistant"` 时间线项，照旧广播。

**优点**：语义正确（命令、测试、文件都在目标机器上真实执行）；复用现有 SessionManager 与权限体系；房主仍是唯一状态权威。
**代价**：协议加帧、节点端要新增执行循环、调试链路变长。

### 方案 B：文件级同步（轻量但语义残缺）

Agent 仍在房主跑，把产生的 diff 推到 B 机器落地。

- 优点：不动执行模型，只加「diff 应用」帧。
- 致命伤：只有「文件编辑」能同步，Bash / 测试 / 构建仍发生在房主机器——用户要的是「在 B 的电脑上干活」，不是「把房主的改动抄过去」。不推荐作为主方案，可作为二期 diff 中继的退化形态。

### 方案 C：远程接管审批流

B 发起「请在我的电脑执行」请求，A（或房主）确认后才转发。本质是方案 A 的审批增强，不独立立项，并入 A 的权限设计。

## §4 方案 A 详细设计

### 4.1 数据模型

- `RoomSeat` 增加 `executorUserId?: string | null`（缺省 = 房主，向后兼容：老席位全部房主执行）。
- `RoomMember` 增加 `projectPath?: string | null`（2026-08-28 已落地）：成员当前打开的项目路径。建房/入房（join 帧 payload）时携带本机 `lastProjectPath`，之后每次打开/切换项目由 `reportLocalProject` 上报——房主改自己的成员记录并广播快照，客人发 `node.info` 给房主更新。各端建席位「运行位置」下拉据此显示 `B 的电脑（D:\proj\xxx）` / `（未开项目）`，选无项目节点时给出失败预警。
- 创建/编辑席位 UI 增加「在哪台机器上运行」下拉（成员列表），客人创建席位默认自己。

### 4.2 新增帧（沿用 RoomFrame 信封与尺寸限制）

| 帧 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `exec.run` | 房主→节点 | `{ turnId, seatId, text, sessionId? }` | 请求节点执行一轮；`sessionId` 为节点侧续会话标识（节点私有，房主只透传） |
| `exec.event` | 节点→房主 | `{ turnId, seatId, kind, text? }` | 过程事件（一期只发心跳/阶段提示；二期接 SDK 流式事件，复用已定义未使用的 `chat.event` 尺寸档） |
| `exec.result` | 节点→房主 | `{ turnId, seatId, ok, text?, error?, changes?: FileChangeSummary[] }` | 最终结果；房主 ingest 为 assistant 消息 |
| `exec.abort` | 房主→节点 | `{ turnId }` | 接管/踢人/关房时中止 |
| `node.info` | 客人→房主 | `{ projectPath: string \| null }` | 本机当前项目变化上报（2026-08-28 已落地）；房主写入成员记录随快照广播 |

- `turnId` 幂等：重复 `exec.run` 同 `turnId` 节点直接回上次结果；房主对超时 turn（建议 10 分钟）发 `exec.abort` 并在时间线记系统消息。
- 节点断连：房主把该节点名下 `running` 席位标记失败；节点重连后上报在跑的 `turnId` 清单对账。

### 4.3 权限与安全（不可妥协项）

1. **写文件/跑命令必须本机确认**：节点端走自己的 permissionBroker，房主与发消息的人都不能替本机人点头；
2. 节点设置项：「远程席位只读」「禁止 Bash」两个开关，默认关（即最严）；
3. 房主只有路由权，不能强制节点执行；节点可以随时拒跑（回 `exec.result ok:false`）；
4. 所有 `exec.*` 帧的关键事件（下发/完成/失败/被拒）进时间线 `kind:"tool"`，全员可审计；
5. 加密沿用现有每信道 AEAD：中继/隧道方只见密文，条款与《通信架构补充条款》§1 一致。

### 4.4 分期

- **一期（可立项）**：席位 `executorUserId` + `exec.run` / `exec.result` / `exec.abort` + 节点本地执行与权限 + 结果进时间线 **+ §5 证据链全套（turnId / 双端台账 / 时间线审计 / 断连对账 / 心跳超时）**。diff 摘要在消息里以文本概述（改了哪几个文件）。
- **二期**：`exec.event` 流式中继（各端实时看到对方机器上 Agent 的过程）；`FileChange` 结构化中继，变更栏可查看远端改动记录（只读，回滚按钮仅节点本机可用）；席位会话隐藏逻辑（2026-08-28 已做）扩展到「远端席位」。

## §5 排查与现场恢复（证据链）

分布式执行最怕「中断了都不知道从哪里恢复现场」。证据链按一等公民设计，一期就要落地，不留到二期。

### 5.1 全链路 turnId

- 每次远程执行由**房主**生成全局 `turnId`（ULID，带时间序）；
- `turnId` 出现在每一帧（`exec.run` / `exec.event` / `exec.result` / `exec.abort`）、时间线条目、两端日志里——**一个 id 串起全链路**，任何一端拿到 id 都能 grep 出完整经过。

### 5.2 执行台账（两端各持一份）

- **房主侧**：台账持久化进 `RoomArchive`，每条记录 `{ turnId, seatId, requesterUserId, executorUserId, state, dispatchedAt, ackAt?, doneAt?, error? }`；
- **节点侧**：本地 JSONL 台账（每房间一个文件），额外记 `localSessionId`（本机 SessionManager 会话 id）——恢复现场靠它续上；
- 状态机显式化：`dispatched → acked → running → done | failed | aborted | timeout`，每次状态跃迁都写台账，**不允许无台账的状态变化**。

### 5.3 时间线审计

- 关键跃迁（下发 / 被拒 / 完成 / 失败 / 中止 / 超时）进房间时间线 `kind:"tool"`，全员可见、可回溯；
- 时间线条目带 `turnId`，点击可展开该轮的阶段、执行节点、错误详情（renderer 纯展示，协议已够）。

### 5.4 断连与重启的现场恢复

| 场景 | 恢复动作 |
|---|---|
| 节点断连 | 房主把该节点在跑的 turn 标 `failed(失联)`；节点重连后**主动上报在跑 turnId 清单对账**：房主台账里 `running` 但节点说「没有」的 → 标失败；节点还在跑的 → 恢复心跳 |
| 节点进程重启 | 节点读本地台账，把 `running` 的 turn 逐个核对本机会话是否活着：活着继续汇报；死了回 `exec.result ok:false`，附本地日志尾部 |
| 房主进程重启 | 房主从 `RoomArchive` 恢复台账（房间恢复机制已有）；恢复后对每个非终态 turn 向节点发对账询问，节点如实回答，房主收敛到终态 |
| 房主与节点同时重启 | 双端台账对账，以房主台账为权威收敛；节点侧无法确认的 turn 一律标 `failed(现场丢失)` 并进时间线 |

### 5.5 心跳与超时

- 节点对 `running` 的 turn 每 15s 发一次 `exec.event` 心跳（无内容也要发）；
- 房主侧两个超时：**ack 超时**（下发后 10s 无 ack → 可重发一次，再失败标 `failed`）、**心跳超时**（60s 无心跳 → 标 `failed(失联)` 并发 `exec.abort` 兜底）；
- 单轮总时长上限 10 分钟，超时房主发 `exec.abort`。

### 5.6 日志

- 两端各写每房间 `exec-log.jsonl`（`{ ts, turnId, dir, type, state?, error? }`），随房间归档一起保留；
- 日志只追加、按天滚动、保留 7 天——够排查，不做长期存储。

## §6 明确不做

- 不做跨机器直接读写对方文件系统而不经本机确认；
- 不做房主对节点文件系统的任何直连通道；
- 中继服务器不感知业务明文（沿用补充条款的机密性边界）。
