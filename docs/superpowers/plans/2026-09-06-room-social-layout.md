# 群聊社交布局修订实现计划

> 面向 AI 代理的工作者：使用 executing-plans 按检查点执行，互不重叠的时间线 / 群列表任务使用 dispatching-parallel-agents。已有用户截图规格，不重新启动方案投票。仅当前工作区，不 commit。

**目标：** 落实用户五点截图反馈，保留群聊现有功能。

**架构：** 时间线只改变展示；群列表由共享纯函数派生最后消息摘要并接入服务列表和 renderer 事件；头部设置与协作栏只重新分配已有信息。所有 CSS 以群聊类名限定，字号沿用 rem。

**技术栈：** React、TypeScript、CSS、Vitest。

## 1. 上下文与规格

- [x] 检查实际组件、字号设置链路、列表和消息数据。
- [x] 用户截图作为明确设计依据；核对 WhatsApp 官方参考，限定不新增社交系统。
- [x] 编写并自检本规格与计划。基线 Stage / Timeline / TaskPanel 共 106 项通过。

## 2. 时间线（并行 A）

文件：`apps/desktop/src/components/RoomTimeline.tsx`、`RoomTimeline.css`、`RoomTimeline.test.ts`。

- [x] 添加系统行无头像、单一实际发送者、Agent / 人类及遗留不同席位名、头像提及仍指向作者的测试。
- [x] 运行 `node node_modules/vitest/vitest.mjs run src/components/RoomTimeline.test.ts`，确认新断言失败。
- [x] 系统分支渲染居中通知；其余消息只保留一个 author label。仅调整群聊 CSS。
- [x] 同命令通过，审查引用 / 附件 / 撤回 / Agent 无气泡回归，并覆盖非法时间戳不崩溃。

## 3. 群列表（并行 B）

文件：`packages/shared/src/room-list-preview.ts` 与测试、`room-protocol.ts` 列表类型、`index.ts`；`apps/desktop/electron/main/room-service.ts` 的 list；`apps/desktop/src/state/room-store.ts` 事件列表项与测试；`RoomSidebar.tsx`、新增 `RoomSidebar.css` / 列表行测试。

- [x] 先测试真实最后聊天消息的作者 / 摘要 / 时间、系统和工具过滤、撤回、图片文件、无消息与窄列表省略结构。
- [x] 运行共享预览及列表组件测试观察缺失断言失败。
- [x] 共享函数返回有限长纯文本 `{ authorLabel, text, at }`；列表项可选 lastMessage。主进程列表和每个房间快照事件统一调用，不能只更新选中的群。不重排列表、不增加历史读取。
- [x] 原有 RoomRow 拖出、双击、选择、重连保留，新增头像和双行摘要；各相关测试通过。

## 4. 头部 / 设置 / 协作（主代理）

文件：`RoomStage.tsx` / 测试、`RoomSettingsModal.tsx` / 新测试、新增 `RoomSettingsDetails.css`、`RoomWorkspace.css`、`RoomTaskPanel.tsx` / CSS / 测试。`RoomCollaborationSidebar.tsx` 现有语义结构不需更改。

- [x] 先断言 header 只含群名和设置 / 协作入口，设置能访问邀请与原状态，任务摘要转入任务侧栏，策略默认折叠，字体无固定 px。

```ts
expect(headerText).toBe("群");
expect(headerNodes.some(node => node.props.className === "room-stage-meta-row")).toBe(false);
expect(policyDisclosure.props.open).not.toBe(true);
expect(taskCss).not.toMatch(/font-size:\s*\d+(?:\.\d+)?px/);
```

- [x] 执行 Stage / TaskPanel / Settings 测试，观察预期失败。
- [x] 移动实际信息与邀请回调，不删除功能。头部保留协作和群设置图标，任务审批提醒由协作入口的小圆点、说明及页签计数保留。紧凑侧栏分组，字号 rem、控件继承，大字号可换行。
- [x] 重跑相关测试，核对审批 / stop / Mod 单实例保持。新增邀请弹窗出现时设置暂时隐藏 / 停止监听 Escape，但保留未保存的名称草稿。

## 5. 最终验证

- [x] 运行完整桌面与共享测试、`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`、`node node_modules/electron-vite/bin/electron-vite.js build`。
- [x] 尝试浏览器视觉验证；默认连接失败、发现结果为空，无可用浏览器。未进行真实窗口视觉验收。
- [x] 独立审查、`git diff --check`、全局样式哈希核对。邀请错误被名称放弃确认遮挡的问题经新增交互测试复现并修正；`RoomSettingsModal.interaction.test.ts` 覆盖草稿保留与错误可见性。记录实际结果，不提交 / 推送 / 部署。

最终结果见 [验证记录](room-social-layout-verification.md)。
