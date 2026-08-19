# 群聊体验改造 — 任务清单（2026-08-19 完成）

当前状态：**全部完成并验证**（typecheck 通过；测试 349/349，含新增 quote 透传单测；此前 4 个 SDK 加载环境失败已自行消失）。

## 已完成（2026-08-18 底层，已落盘）

- shared：`RoomTimelineItem.quote?`（`RoomQuoteRef`）、`RoomListItem.offline?`、`room:send` 加 quote 参、新 IPC `room:rejoin`、`roomEvent` 加 `offline`（`packages/shared/src/room-protocol.ts`、`ipc.ts`）
- 主进程 `room-service.ts`：quote 全链路透传；掉线不删房间（status=ended + persist + emit，重连耗尽 `offline=true`）；`join()` 支持 `opts.userId`；新增 `rejoin(roomId)`；`StoredRoom` 增加 `localUserId` / `offline`
- preload：`sendRoomMessage(..., quote?)`、`rejoinRoom(roomId)`
- 渲染 `room-store.ts`：`sendToSeat(text, quote?)`、`rejoinRoom(roomId)`；`closed` 事件改为 `refreshRooms()`

## 已完成（2026-08-19 UI 层）

- **A. 退出确认弹窗**：新组件 `RoomLeaveConfirm.tsx`（`.room-modal-overlay` portal，群主红色警告 / 成员普通）；接入 `RoomStage.tsx` 头部按钮与 `RoomSidebar.tsx` 两处退出按钮
- **B. 邀请码弹窗**：新组件 `RoomInviteModal.tsx`（只读框 + 复制按钮 + 已复制 2s 反馈 + 防火墙提示）；去掉自动复制，删除 `.room-invite-bar`
- **C. 加 Agent 席位弹窗**：新组件 `RoomAddSeatModal.tsx`（席位名 + 人设下拉 + description 预览 + 确定/取消）；删除 `.room-add-seat` 内联面板
- **D. 输入框重设计 + @提及 + 引用**：`.room-composer-box` 圆角容器（引用预览条 + textarea + 底栏）；@提及复用 `parseTrailingAt` + `.slash-menu` 弹层键盘导航；消息渲染 `@名字` 包 `.room-mention`（@自己加底色，纯渲染层）；消息 hover「引用」→ `setQuote` → `sendToSeat(text, quote)`；`it.quote` 渲染 `.room-msg-quote`
- **E. 断线 UI**：侧栏房间行 offline 显示「已断线」+「重连」→ `rejoinRoom`；`RoomStage` 顶部 `.room-offline-banner` + 重新连接按钮；输入框/游戏按钮 offline 时禁用
- **F. 项目文件夹可选化**：`ipc-handlers.ts` sessionStart 无项目时回退 `lastProjectPath ?? os.homedir()`，不再抛 "No project open"；`Composer.tsx` 去掉 `!projectPath && !activeSessionId` 禁用；输入区左下角新增文件夹 chip（`.composer-project-chip`，显示当前文件夹名，点击 `openProject()`）
- **G. i18n + 样式**：`zh.ts`/`en.ts` 补 `leaveConfirm*`、`inviteTitle/inviteCopied/inviteFirewall/inviteNotListening`、`addSeat*`、`quoteAction`、`rejoin`、`offline`、`offlineBanner`、`chat.pickProject`（移除 `composerNoProject`）；`styles.css` 新增 `.room-leave-*`、`.room-invite-code`、`.room-composer-box/bar`、`.room-quote-bar*`、`.room-mention`、`.room-msg-quote*`、`.room-offline-banner`、`.composer-project-chip`
- **H. 验证**：`pnpm typecheck` ✅；`pnpm test` 349/349 ✅（新增 room-mod.test.ts quote 透传用例）

## 明确不做
- 群主退出后重新开房恢复现场（房主进程即服务器，属更大改动）
