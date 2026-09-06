# 群聊有效提及与任务控制实现计划

> **面向 AI 代理的工作者：** 按测试驱动步骤执行；独立文件任务用 dispatching-parallel-agents 分派，主控制者负责共享协议与 RoomService 集成，完成后进行规格及质量审查。

**目标：** 实现有效提及、审批队列、三档 Agent 转交权限和任务级中断授权。

**架构：** 共享包定义结构化提及、任务状态与权限；RoomService 是当前群聊任务的处理端，负责所有身份绑定和调度。Agent 工具绑定运行实例；执行端只读门禁挂在每次工具调用之前，独立于文本与 UI。未来常驻服务器可复用协议，本轮不改拓扑。

**技术栈：** TypeScript、Electron/React、现有 SDK MCP 工具、WebSocket、Vitest。

## 全局约束

- 不提交/推送/部署；保留已有未提交成果，禁止覆盖 styles.css（原 SHA256 E59F16770780F292725A08F0016A9F8113A349800F6653181D19FA7F97178D86）。
- 旧版本不兼容。旧 Mod 行为与自主权设置不混用。
- 不以模型输出声明保证只读，不以 UI 隐藏按钮代替权限检查。
- 所有新执行状态必须在取消、关闭、超时路径收敛，不自动重启已取消任务。

## 文件与接口

- 共享 `room-mentions.ts`：`RoomMention = { seatId: string; start: number; end: number }`，end 不含尾空格；`validateRoomMentions(text, mentions, seats)` 验证实际名称与尾空格并返回有效记录。
- 共享 `room-protocol.ts`：`RoomTask`（id/seatId/initiatorUserId/parentTaskId/status/text/readOnly/createdAt），成员 `delegationPolicy?: "ask" | "read-only" | "auto"`，快照 `tasks?: RoomTask[]`；消息 `mentions?: RoomMention[]`。
- `room:send` 第六参数 `mentions?: RoomMention[]`；新增任务停止/审批/个人转交策略 IPC，处理端使用真实连接身份。
- `src/state/store.ts` / `RoomPermAskModal.tsx`：旧工作区审批队列，不混入新任务所有者审批。
- `session-manager.ts`：仅群聊启用 `roomReadOnly?: boolean` 与 `requestRoomWriteAccess?: (name, input) => Promise<boolean>`；跨轮显式重设，不影响普通会话。
- `room-task-controller.ts`：独立任务调度、归属、审批、取消与三档规则；`room-service.ts` 接入本机、远端、连接生命周期。
- `room-chat-agent.ts`：成员列表/通知/交办工具，处理端绑定运行身份；禁止从普通输出解析工具调用。
- `RoomStage.tsx` / `room-compose.ts` / `RoomTimeline.tsx` / `room-notify.ts`：选择生成元数据、编辑失效、真实提及渲染与通知；任务控制显示归属、状态与授权操作。

## 任务 1：审批队列（独立工作者）

- [x] 在独立的 `src/state/store-room-approval.test.ts` 加真实事件订阅回归：发 A、B，当前仍 A，回复 A 后显示 B；resolved B 不清 A；重复 requestId 去重，原 `store.test.ts` 保持不变。
- [x] 运行 `node node_modules/vitest/vitest.mjs run src/state/store.test.ts src/state/store-room-approval.test.ts`，确认新增断言红灯后修复。
- [x] 在 Store 保存 requestId 队列，所有清理/回复仅移除对应项，Modal 显示剩余数量；不更改其他会话权限。
- [x] 重跑测试与类型检查，实际结果见审批队列报告及最终集成验证记录。

## 任务 2：结构化提及（主控制者定义协议，UI 独立工作者接线）

- [x] 在共享测试先加入无元数据不触发、显式位置有效、删除空格、错 ID、重复/重叠区间无效等断言。
- [x] 红灯后实现校验并升级应用协议至 v2；IPC 全链路携带元数据，加密/握手信封版本不变。
- [x] UI 写编辑/粘贴/插入测试再实现提及记录维护，取消普通文字自动执行；补齐同值替换、选区末端和 Markdown 解码偏移回归。
- [x] 通知与时间线按元数据高亮，Agent 发送身份不再因空 authorUserId 被过滤；运行相关测试。

## 任务 3：执行端只读门禁（独立工作者）

- [x] `session-manager.test.ts` 捕获真实 query 配置，测试只读 Read 允许、Edit/Bash/未知 MCP 不可未批准执行、退出只读恢复、普通会话不受影响。
- [x] 红灯后接入上述 SessionRunOpts 字段和 PreToolUse 门禁；写操作在 callback 批准前阻塞，拒绝则 deny。
- [x] 覆盖取消期间等待授权、允许结果、下一轮重新只读；补齐异步准备取消、同名 MCP 配置与 SDK 实例重绑，报告测试结果。

## 任务 4：任务控制与 Agent 工具（主控制者）

- [x] 新 `room-task-controller.test.ts` 验证 member 不可停止他人任务，host/admin 可停止全部，子任务继承原发起人；串行目标与并行不同目标；审批队列、拒绝/取消后迟到允许无效。
- [x] 红灯后实现有界台账、调度、ask/read-only/auto 与父子任务取消；审查修复并发写升级、旧审批续体与 workspace 状态竞争。
- [x] 新 `room-chat-agent.test.ts` 验证工具结构与回调，实际 RoomService 测试验证 notification 不运行、delegate 需原发起人审批、不可伪造来源、只读升级。
- [x] 本机与远端运行挂载工具、绑定任务、传递只读控制；远端通知/交办由执行连接+turnId 认证。
- [x] 新任务控制 UI 调用停止/审批/策略 IPC，按权限显示并由处理端再次校验。

## 任务 5：集成与交付验证

- [x] 更新旧多 Agent 测试为明确提及；新增真实 WebSocket 越权停止、排队取消、远端待批停止，并在共享协议测试拒绝旧应用帧。
- [x] 主控制者检查所有工作者差异；单独审查代码规格及取消/权限风险并修复，最终三项处理端 Important 经复核关闭。
- [x] 桌面目录：`node node_modules/vitest/vitest.mjs run --silent`，78 文件 / 931 项通过。
- [x] 共享目录：`node ../../apps/desktop/node_modules/vitest/vitest.mjs run --silent`，14 文件 / 137 项通过。
- [x] 桌面目录：`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`；`node node_modules/electron-vite/bin/electron-vite.js build`，均 exit 0。
- [x] `git diff --check` 与 styles.css 哈希；实机/模型调用验证限制已记录。保留 group 分支，不提交、推送或部署。

## 执行记录

- 开始前：当前 group 分支原地继续；相关基线 4 文件 / 57 测试通过（21:33），未修改全局样式。
- 用户暂停后于“继续开发”恢复，原地保留全部工作；初次复测 5 文件 / 89 项通过，类型检查仅剩远端完成轮次清理方法未接线。
- 23:29～23:34：先用失败用例定位收包器仍只认 v1、无元数据 Agent 席位回退误触发、远端待批停止未清审批；修复后多 Agent 集成 12/12 通过。远端取消增加轮次墓碑、停止确认等待、连接清理与 SDK 取消信号接线。
- 23:39～23:49：真实 WebSocket / 实际 MCP client 验证普通成员和当前管理员权限、原始发起人审批、通知不执行、远端写升级与项目拒绝独立生效。新增失败用例后修复连接重复声明身份、已知设备改报另一成员跳过审批、公钥指纹不匹配、离群审批失效、活跃任务不被历史快照挤掉；集成 20/20 通过。
- 首次全量桌面回归 811 passed / 20 failed；失败集中于旧测试仍直接向 Agent 席位发送或写死 v1，正在逐条迁移（不放宽原权限/ctx/Mod 断言）。共享 134 passed / 2 failed 同为旧协议正例，迁移中。
- 当时进行中：UI 输入同值替换/选区末端/Markdown 实体高亮修复；SDK 异步准备取消检查；独立任务控制器与处理端质量审查。以下为后续收尾结果。
- 2026-09-06 00:03：中间全量桌面回归 868 passed / 1 failed。剩余断言要求本机停止请求后立刻清空 running，与执行 Promise 尚未结束矛盾；调整为 stopping 期间保留占用、终态后清空，定向 25/25 通过。
- 00:06～00:19：TDD 修复 MCP 同名重绑、控制器并发审批，以及本机/远端等待期间撤销项目权限、席位改绑后停止原执行节点、Mod 异步等待后争用席位。真实 RoomService 集成扩展到 29 项；独立规格/质量复核关闭最后三项 Important。
- 00:26：所有工作者结束后重新执行最终完整验证：桌面 931/931、共享 137/137、类型检查 exit 0、生产构建 exit 0；diff 检查通过，styles.css 哈希与原值一致。详细范围、验证命令与未覆盖的实机检查见 [最终验证记录](room-task-controls-verification.md)。
