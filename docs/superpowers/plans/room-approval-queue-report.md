# 审批 UI 队列实现报告

日期：2026-09-05。工作区：`D:/gitRep/ccDesktop`。

## 实现结果

- 新增 `roomPermAskQueue`，按到达顺序保存待审批请求，以 `requestId` 对当前队列去重。重复事件不会替换已有请求内容或调整顺序。
- `roomPermAsk` 保留原有读取 API，始终为队首或 `null`；队列和队首在同一次 Store 更新中发布。连续收到 A/B 时仍显示 A。
- 允许或拒绝 A 后移除 A，展示 B；收到其他窗口或主进程的 resolved 广播时按 ID 删除匹配项。非队首 resolved 不影响队首，未知或重复 resolved 无副作用。
- `clearRoomPermAsk()` 清空整条本地队列；测试 reset 同时重置队首、队列和 desktop 订阅，重新 bootstrap 可接收新审批。
- `respondRoomPermAsk()` 在 await 前捕获请求对象，完成时仅删除仍在队列中的同一对象。覆盖 resolved 先到、响应乱序、等待期间入队，以及 clear/reset 后同 ID 新请求的竞态。
- 弹窗增加“待审批：N”，N 包含正在显示的请求，复用现有样式类。

## 修改文件

1. `apps/desktop/src/state/store.ts`：队列状态、事件入队/删除、响应竞态保护和 clear/reset。
2. `apps/desktop/src/state/store-room-approval.test.ts`：新增 21 项回归，包含真实弹窗渲染检查。
3. `apps/desktop/src/components/RoomPermAskModal.tsx`：显示队列数量。
4. `docs/superpowers/plans/room-approval-queue-report.md`：本报告，使用 apply_patch 创建。

`store.test.ts` 保持原样。上述文件在本任务开始时无既有修改；仅对指定源码位置进行补丁修改，保留其他 worker/main 的已有和并发变化。没有修改全局样式，没有提交、推送或部署。

## TDD 红绿证据

先完整读取 TDD 技能及测试反模式说明，再编写回归并运行红灯，之后才修改生产代码。根因检查和结果核验分别遵循系统化调试与完成前验证技能。

红灯、绿灯均在 `apps/desktop` 目录运行用户指定命令：

```text
node node_modules/vitest/vitest.mjs run src/state/store.test.ts src/state/store-room-approval.test.ts
```

| 阶段 | 结果 |
| --- | --- |
| 实现前红灯，21:43:30 | 退出码 1；原有 19 项通过；新增 21 项中 20 项失败、1 项通过；合计 20 failed / 20 passed |
| 实现后绿灯，21:44:31 | 退出码 0；2 个测试文件通过；原有 19 项和新增 21 项全部通过；合计 40 passed |

红灯全部为断言失败，直接显示 A 被 B 覆盖、resolved 后仍显示错误请求、队列状态缺失、旧响应误删同 ID 新请求，以及弹窗缺少数量。实现前唯一通过的新增用例是空队列不显示弹窗。

新增测试通过真实 `bootstrapStore()` 注册 desktop 事件订阅并投递 `IPC.roomPermAsk`，没有 mock Store、React 或共享业务逻辑。仅替代 `window.desktop` 边界，包括初始化查询、事件收发及可控的响应 Promise；用真实 Store 订阅检查队列与队首一致，用真实组件和 `renderToStaticMarkup` 检查显示内容。

覆盖：跨房间 FIFO、允许/拒绝推进、逐项 resolved、队中/队尾删除、重复 ID、未知和重复 resolved、clear、reset 与取消订阅、等待中入队、resolved 先于响应、并发响应逆序完成、响应拒绝时的定向清理、clear/reset 后 ID 复用、无匹配请求时启动的迟到响应、弹窗隐藏与数量更新。

## 补充验证与风险

- 指定已有源码文件的 `git diff --check` 退出码 0，无空白错误；Git 提示 LF 将在以后操作时转换为 CRLF。
- 补充运行 `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false`，退出码 1。当次输出共 19 项 TS2353，全部位于其他 worker 正在修改的 `electron/main/session-manager.test.ts`：`SessionRunOpts` 尚不接受 `roomReadOnly` / `requestRoomWriteAccess`。本次修改文件无类型诊断，但不能宣称整个工作区类型检查通过；未修改这些范围外文件。
- 保持既有响应失败语义：desktop 调用完成或抛错后均清理本次回答项，抛错继续向调用者传播；没有新增失败重试 UI，也没有改变 `{ ok: false }` 的处理。
- 队列属于当前 renderer 的内存状态，跨窗口删除仍依赖既有 resolved 广播。去重针对当前待审批项；本次未增加持久化、事件重放或主进程协议。
- 已验证真实 Store 订阅、受控异步交错和组件静态渲染；未进行真实 Electron 多窗口 IPC 或浏览器点击端到端测试。
