# 群聊体验第一批实现计划

> 使用测试先行和并行任务分派；实现后独立审查。保留当前 group 分支的未提交改动，不重置、不切分支、不提交其他人的文件。

**目标：** 落地已确认的人类气泡 / Agent 正文展示与单消息多 Agent 调度。

**架构：** 共享纯函数解析明确提及；RoomService 入站消息只写一次并对去重后的目标分别启动已有执行链路。UI 沿用单次发送 IPC 和自由 @，视觉由群聊专用 CSS 作用域控制。

**技术栈：** TypeScript、React、现有 Electron/WebSocket、Vitest。

## 任务 1：提及解析与多 Agent 执行（主代理）

文件：新增 packages/shared/src/room-mentions.ts、room-mentions.test.ts，并从 index.ts 导出；修改 apps/desktop/electron/main/room-service.ts；新增 room-multi-agent.test.ts。

- [x] 先写纯函数用例，覆盖人类和 Agent 混合、重复、名称前缀、邮件误匹配，确认缺少实现而失败。

```ts
expect(findRoomMentionedSeats("@人类 @检查员 @开发员 @检查员", seats).map(s => s.name))
  .toEqual(["人类", "检查员", "开发员"]);
expect(findRoomMentionedSeats("mail@开发员.example @开发员Plus", seats)).toEqual([]);
```

- [x] 实现按消息出现顺序、最长完整名称与边界匹配的提及解析，导出并验证。
- [x] 真实 RoomService 先写失败测试：宿主/成员一条消息使两个不同席位同时处于执行中；时间线用户消息只出现一次；只 @ 人类不触发；重复提及只触发一次。
- [x] ingestUserChat 继续只运行一次群扩展 hook、一次 append，然后分别调用 runAgentSeat。busy 检查覆盖异步审批前的在途请求，保证退出及异常释放标记。新的群消息不阻塞其他席位。

```ts
expect(sessions.start).toHaveBeenCalledTimes(2);
expect(rooms.get(roomId)!.items.filter(i => i.kind === "user" && i.text === text)).toHaveLength(1);
expect(rooms.get(roomId)!.seats.filter(s => s.running)).toHaveLength(2);
```

- [x] 运行：在 packages/shared 执行 node ../../apps/desktop/node_modules/vitest/vitest.mjs run src/room-mentions.test.ts；在 apps/desktop 执行 node node_modules/vitest/vitest.mjs run electron/main/room-multi-agent.test.ts electron/main/room-turn-ask.test.ts electron/main/room-remote-exec.test.ts --silent，预期全部通过。

## 任务 2：群聊消息视觉（独立 UI 子任务）

文件：仅修改 apps/desktop/src/components/RoomTimeline.tsx、RoomTimeline.test.ts；新增 RoomTimeline.css。禁止改 styles.css、RoomStage、服务层和其他公共组件。

- [x] 静态渲染先验证：人类发给 Agent 仍带 human 类与人类头像；Agent 回复带独立 prose 类；自己的 assistant 不能右对齐；两个实时任务分别有各自状态。
- [x] 按 item.kind 判定作者类型，自己的对齐只对人类消息生效。新增 CSS 只在 .room-timeline 下生效：人类柔和气泡、Agent 无背景/边框/外层圆角，代码和引用保留自身样式。
- [x] 保留 Markdown、撤回、引用、右键菜单、80 条渲染窗口，修正纯工具进度与 typing 占位重复呈现。
- [x] 在 apps/desktop 执行 node node_modules/vitest/vitest.mjs run src/components/RoomTimeline.test.ts --silent，预期全部通过；报告 red/green 证据及文件清单。

## 任务 3：输入框整合与总体验证（主代理）

文件：apps/desktop/src/components/RoomStage.tsx；需要纯交互测试时使用 src/lib/room-compose.ts 和 room-compose.test.ts。

- [x] 以共享解析替换 find 单目标逻辑；任何明确提及优先从自己的成员席位发送，处理端完成多目标分发；没有提及时保留已选席位语义。
- [x] /stop 使用去重后的 Agent 列表并行停止；某项失败显示具体 Agent 名称。一次提交锁只覆盖消息提交，不覆盖各 Agent 执行时长，避免双击重复发言。
- [x] 保留引用与附件参数，不修改当前附件传输能力。不将附件名称当作可执行提及来源。
- [ ] 审查任务 1 与任务 2 的规格/质量和集成边界，修复重要问题后再验证。
- [ ] 运行 node node_modules/vitest/vitest.mjs run --silent、node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit、node node_modules/electron-vite/bin/electron-vite.js build；共享包执行 node ../../apps/desktop/node_modules/vitest/vitest.mjs run --silent。
- [ ] git diff --check，styles.css SHA256 应保持 E59F16770780F292725A08F0016A9F8113A349800F6653181D19FA7F97178D86；交付当前代码与实际验证范围，不声称其他独立阶段已完成。

## 基线

2026-09-05：桌面 69 个测试文件 / 663 项通过。当前工作区已有上一批 Mod 参与改动；用户的 styles.css 及无关未跟踪文件保持原状。

## 实施补充

- 已补充真实本地 WebSocket 的双远端 Agent、审批等待防重入、按 Agent 取消待审批任务、36 KB 长文本加包含 @ 的附件名回归。等待审批的旧 stop 逻辑确实被新测试捕获；修复后服务相关 39 项通过。
- 消息原始输入的边界在有附件时以 `mentionTextLength` 数值传递，不重复发送大段文本，避免触发帧大小限制。提及目标取扩展改写前的原文，扩展仍可丢弃消息，但不因显示文本改写悄悄新增 Agent 调度。
- 通过浏览器技能检查连接，运行时没有可用浏览器，未进行真实视觉/点击验收。现有 React 静态渲染与右键回调测试不代替真实桌面交互验收。
