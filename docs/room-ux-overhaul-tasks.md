# 群聊体验改造 — 剩余任务清单（2026-08-18 晚收敛）

当前状态：**底层改动已完成并验证**（typecheck / build 通过；测试 344/348，4 个失败为 HEAD 上就存在的 SDK 加载环境问题，与本次无关）。UI 层基本未动，应用可正常使用。

## 已完成（已落盘）

- shared：`RoomTimelineItem.quote?`（`RoomQuoteRef`）、`RoomListItem.offline?`、`room:send` 加 quote 参、新 IPC `room:rejoin`、`roomEvent` 加 `offline`（`packages/shared/src/room-protocol.ts`、`ipc.ts`）
- 主进程 `room-service.ts`：
  - quote 全链路透传（send → chat.user 帧 → ingestUserChat → append；`ChatInEnvelope.quote` 已加，hook 改写不丢引用）
  - **掉线不再删房间**：`dismissGuest` 改为 status=ended + persist + emit，重连耗尽时 `offline=true`；群主解散同样保留归档；只有显式 `room:delete` 才清
  - `join()` 支持 `opts.userId` 复用成员身份；新增 `rejoin(roomId)`（用存档的 joinInfo 重走 join，失败恢复旧记录）
  - `StoredRoom` 增加 `localUserId` / `offline` 并随归档持久化（重启后仍可重连）
- preload：`sendRoomMessage(..., quote?)`、`rejoinRoom(roomId)`
- 渲染 `room-store.ts`：`sendToSeat(text, quote?)`、`rejoinRoom(roomId)`；`closed` 事件不再移除房间，改为 `refreshRooms()`

## 剩余任务（按优先级）

### A. 退出确认弹窗（防误触）
- 新建 `src/components/RoomLeaveConfirm.tsx`：`.room-modal-overlay` portal 弹窗，区分群主（退出并解散，红色警告）/ 成员
- 替换 `RoomStage.tsx:188-217` 内联两步确认；接入 `RoomSidebar.tsx:380-388、424-436` 两处无确认的 `leaveActiveRoom()`

### B. 邀请码弹窗
- 替换 `RoomStage.tsx:239-246` 的 `room-invite-bar`：弹窗内只读框显示 CDR1 邀请码 + 「复制」按钮（`navigator.clipboard.writeText` + "已复制" 反馈 2s）+ 防火墙提示；去掉自动复制

### C. 加 Agent 席位改弹窗
- 替换 `RoomStage.tsx:297-333` 的 `.room-add-seat` 内联面板：席位名 input + 人设下拉（`settings.agents`，选中显示 description 预览）+ 确定/取消；仍走 `addSeat("agent", name, agentName)`

### D. 输入框重设计 + @提及 + 引用
- 输入区：圆角容器 = 引用预览条 + textarea + 底栏（🎲✊✌️✋ + 发送），新增 `.room-composer*` 样式
- @提及：复用 `src/lib/at-mention.ts` 的 `parseTrailingAt`（返回 `{query, start, end}`）；候选来自 `room.seats`；弹层复用 `.slash-menu` 样式 + 键盘导航（参考 `Composer.tsx:441-466、520-541`）；选中插入 `@席位名 `；消息渲染时按席位名匹配 `@名字` 包 `<span class="room-mention">`（蓝色，@自己加底色）——**纯渲染层，协议无需再改**
- 引用：消息 hover 出「引用」按钮 → `setQuote({id, authorLabel, text: 截120字})` → 输入框上方预览条（可 × 取消）→ `sendToSeat(text, quote)`；有 `it.quote` 的消息在正文上方渲染引用块

### E. 断线 UI 收尾（底层已通）
- 侧栏房间行：`offline` 时显示「已断线」+「重连」按钮 → `rejoinRoom(roomId)`
- `RoomStage`：offline 时顶部横幅「连接已断开，聊天记录已保存在本地」+「重新连接」按钮；输入框禁用

### F. 项目文件夹可选化（新需求，未动工）
- 现状：必须在左侧栏选中文件夹才能对话
- 目标：不选文件夹也能聊（默认空路径 / 无项目态）；把文件夹选择入口挪到对话区（Composer 附近）
- 需查：`App.tsx` / `SessionList.tsx` / `state/store.ts` 里 project 与 sendMessage 的耦合点、`session-manager` 对空 cwd 的处理

### G. i18n + 样式
- `zh.ts`/`en.ts` room 块补 key：`leaveConfirm*`、`inviteTitle/inviteCopy/inviteCopied`、`rejoin`、`offlineBanner`、`quoteAction` 等
- `styles.css`：`.room-composer*`、`.room-mention`、`.room-msg-quote*`、`.room-invite-code`、`.room-offline-banner`

### H. 验证
- `pnpm typecheck && pnpm test && pnpm build`（apps/desktop）
- 可补一条 quote 透传的 room-service 层单测

## 明确不做
- 群主退出后重新开房恢复现场（房主进程即服务器，属更大改动）
