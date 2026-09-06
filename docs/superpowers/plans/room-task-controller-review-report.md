# RoomTaskController 审查修复报告

日期：2026-09-06。

本轮确认的 3 项 Important 已按逐项红→绿修复；控制器完整测试文件 39/39 通过，两个 TypeScript 文件的定向严格类型检查通过。本结论仅覆盖控制器，不代表整合层或底层工具授权已完成验证。

## 范围与语义

本轮仅修改 `apps/desktop/electron/main/room-task-controller.ts`、对应 `.test.ts`，并新增本报告。未修改 `room-service.ts` 或其他业务文件，未提交、推送。

依据 `docs/superpowers/specs/2026-09-05-room-task-controls-design.md` 的任务与审批、中断权限节，以及本轮明确的语义：同一任务的写升级是一次“解除只读”决定；同时等待该决定的调用共享结果。它不替代底层每工具授权，不改变目标项目的权限门禁。

## 修复内容

1. **并发写请求共享决定。** `Runtime.approval` 保存决策 Promise；`requestWrite` 复用当前 Promise。等待中的第二个调用不会提前得到 `false`，也不会替换请求 ID、详情或计时器。允许、拒绝、超时和取消都会结算等待者。
2. **旧续体不再修改审批状态。** 写升级的 `readOnly` 和状态转换集中到 `resolveApproval`，在释放当前审批槽位、唤醒等待者之前同步结算。等待者只读取本次决定并重新检查任务是否仍活跃，不再写状态，因此旧拒绝或超时续体不能覆盖新审批。允许已经结算后立即到来的调用不会重复申请升级；旧请求 ID 仍会被 `approve` 拒绝。
3. **审批期间保留 workspace 等待状态。** 控制器单独记录最新 `waitingWorkspace`。workspace 回调不会覆盖 `awaiting-approval`；审批结束后，根据最新记录恢复为 `awaiting-workspace` 或 `running`。停止或终态后的回调仍不能恢复任务。

允许决定结算后再停止，不回滚已作出的升级决定；尚未恢复的并发等待者会因任务已中断而得到 `false`。停止先于批准时，迟到批准无效，任务保持只读。以上行为不替代调用端的 AbortSignal 和每工具授权检查。

测试 fixture 已通过 `submit("dev", "a", true)` 创建只读任务，删除直接修改 `task.readOnly` 的做法。测试实例化真实 `RoomTaskController`；只控制执行 Promise、成员/策略依赖和时钟，不 mock 控制器方法或改写其私有状态。

## 逐项红→绿记录

命令工作目录均为 `apps/desktop`，使用 Vitest 3.2.7。完整测试命令：

```powershell
node node_modules/vitest/vitest.mjs run electron/main/room-task-controller.test.ts --no-cache
```

| 阶段 | 红灯筛选参数及实测失败 | 修复后的完整文件结果 |
| --- | --- | --- |
| 基线 | 原有测试 | 7/7 通过 |
| 1：共享升级决定 | `-t 'shares a pending write upgrade'`：3 项失败；用户尚未决定时结果已为 `[false]`，预期 `[]` | 10/10 通过 |
| 2：消除旧续体覆盖 | `-t 'older waiters\|another approval'`：3 项失败；拒绝/超时后的新审批被写成 `running`，允许后又产生新请求 ID | 13/13 通过 |
| 3：保护 workspace 状态 | `-t 'keeps approval visible'`：6 项失败；等待确认被覆盖成 `running` 或 `awaiting-workspace` | 19/19 通过 |
| 补充既有边界回归 | 新增 20 项回归，无须改变这些边界的生产逻辑 | 39/39 通过 |

第 2 轮在 PowerShell 中实际使用的筛选参数为 `-t 'older waiters|another approval'`；表格内的竖线进行了 Markdown 转义。

三轮红灯均是预期行为断言失败，退出码为 1；每轮绿灯均运行完整目标文件并以 0 退出。既有边界回归直接通过，如实记录为回归验证，没有为制造红灯或通过测试而调整设计。

## 关键覆盖

- 同席位串行、不同 Agent 并行；批准后排队的子任务遇到父任务停止，不会因审批续体或席位释放而运行。
- 并发写申请延迟允许、拒绝、取消；停止/销毁/执行结束结算所有等待者；允许后、等待者恢复前停止，全部返回 `false`。
- 拒绝或超时后立即产生新审批，旧等待者不会覆盖新状态；旧请求 ID 不能批准新请求；并发调用保留同一请求 ID 和原始详情。
- workspace 等待与就绪两种回调，分别与允许、拒绝、超时组合；审批期间优先显示等待确认，之后恢复最新 workspace 状态。
- 动态降权、升权、退群；原始发起人离群后不能审批，管理员不能代批；多层转交沿用原始人类及其当前策略。
- ask/read-only/auto 转交策略；只读父任务不能自动升级写子任务；三种转交策略均不免除只读任务的升级审批。
- 写升级和转交的 299999/300000 ms 超时边界；转交拒绝与超时均取消任务并拒绝迟到批准。
- 4 次转交允许、第 5 次拒绝；32 个未完成任务的上限包含 `stopping`，执行结束后释放名额。
- 每链 16 项的计数包含已完成子任务；历史淘汰后仍不能重置链限。
- 有未完成后代时保留已完成祖先；淘汰后仍可通过原任务取消后代，不影响其他成员的独立任务。
- 129 条记录触发淘汰至 96 条，保留活跃任务；显式 `RoomStopUnconfirmedError` 进入 `failed`，不会虚报 `cancelled`。

## 验证结果与边界

最终目标文件：**1 个测试文件通过，39 项测试通过，0 失败**。本次执行耗时 505 ms，其中测试耗时 137 ms。

定向类型检查退出码 0，无诊断：

```powershell
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --esModuleInterop --skipLibCheck --strict electron/main/room-task-controller.ts electron/main/room-task-controller.test.ts
```

本轮未开展 service、协议、UI、真实远端或底层每工具授权的整合验证。工具请求去重及目标项目权限门禁仍属于主控整合验证范围；本轮没有修改这些契约，也没有将其视为已验证。
