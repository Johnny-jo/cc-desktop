# 群聊协作界面 Implementation Plan

> 与附件主线平行实施，独立写集：RoomStage、RoomTaskPanel、群聊专用新 CSS / 组件及对应测试。不得修改 styles.css、其他页面或执行服务。

**Goal:** 将用户确认的协作原型落地到真实群聊组件，保留现有功能和权限。

**Reference:** `.superpowers/brainstorm/room-ui-20260906/content/room-collaboration-refined.html`；当前任务控制设计优先于旧版 mention 扫描方案。

- [x] 1. 为任务 / 成员 / 活动页签、展开收起、任务数量、权限按钮和空状态添加失败测试。
- [x] 2. 提取可维护的协作侧栏，默认任务页；将已有成员与 ModPlayPanel 接入页签，避免重复挂载 Mod。
- [x] 3. 精修群聊 header、输入区、@ 成员选择器，维持人类气泡和 Agent 无外框；样式全部在群聊作用域。
- [x] 4. 检查键盘 / 窄屏规则、ctx 真实状态、现有选择 mention 与任务停止测试；补充跨群发送期间的草稿隔离测试。
- [x] 5. 变更已交主线集成（无 git commit）；构建验证及验收路径见 `room-attachments-verification.md`。真实窗口视觉检查待可用浏览器。

附件 UI 的新 IPC 接线由主线或后续独立任务实现，避免共享写冲突。
