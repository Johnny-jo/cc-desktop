# 群聊任务控制最终验证

日期：2026-09-06，Asia/Shanghai。工作区 `D:/gitRep/ccDesktop`，分支 `group`。

## 本批结果

当前批次的有效提及、任务调度、转交审批和中断权限已实现并通过自动化验证。不代表整个账号与常驻中继改造已完成，也不代表完成实机验收。

- 通过候选框或头像选择才生成有效提及；`@名称 ` 末尾普通空格必需。粘贴、未选择的文字、引用和附件名称不会单独触发执行。消息保持人类身份；Agent 通知与交办走绑定任务的结构化工具。
- 同一 Agent 排队、不同 Agent 并行；项目审批弹窗 FIFO，转交及写升级显示在任务面板。任务保留原始人类发起人。
- 三档个人转交策略：逐次确认、只读自动/修改需批、授权范围内自动。执行端每工具门禁、项目主人权限和转交审批彼此独立。
- 普通成员只停本人发起的任务及后代，群主/管理员可停任何任务；按当前连接身份和成员角色授权。远端请求先为 stopping，执行端回报终态后结束；迟到批准、重发和失联不伪装为成功停止。
- 保留人类柔和气泡、Agent 无气泡、附件选择与发送参数、ctx 和既有 75% 自动压缩、Mod 可选参与、现有局域网与中继路径。
- 应用层协议为 v2，旧应用帧被拒绝，不向旧版降级；加密/握手信封沿用现有 v1。

## 最终命令与结果

所有工作者结束、最新生产补丁合并后，于 00:26 重新运行：

| 工作目录 | 命令 | 实测结果 |
| --- | --- | --- |
| `apps/desktop` | `node node_modules/vitest/vitest.mjs run --silent` | 78 文件，931 passed，0 failed，exit 0 |
| `packages/shared` | `node ../../apps/desktop/node_modules/vitest/vitest.mjs run --silent` | 14 文件，137 passed，0 failed，exit 0 |
| `apps/desktop` | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | 无诊断，exit 0 |
| `apps/desktop` | `node node_modules/electron-vite/bin/electron-vite.js build` | main / preload / renderer 均构建成功，exit 0 |
| 仓库根目录 | `git diff --check` | exit 0；仅 Git 的 LF/CRLF 提示 |

`styles.css` SHA256 保持 `E59F16770780F292725A08F0016A9F8113A349800F6653181D19FA7F97178D86`。文件本来就有用户未提交改动，本批没有覆盖。`.agents/`、`docs/1.txt`、`problem/` 等原有内容保留。未提交、推送、部署或切换分支。

## 审查后的关键修复

按测试驱动开发和代码审查反馈先复现，再修复，并由主控制者检查实际差异和重跑完整测试：

- 输入框同值替换消除旧提及授权，候选插入尊重选区末端；Markdown 实体/转义解码后仍按原始提及位置高亮。
- 只读升级的并发请求共享当前决定；旧审批续体不能覆盖新审批，workspace 状态不能隐藏等待确认。
- SDK 准备、工具授权、压缩期间取消后不继续执行。同名 MCP 配置或 SDK 实例改变时重新绑定 query，权限豁免读取实际 query 配置。
- 等待模型准备或写升级期间，项目主人改为 deny 后阻止执行；本机最新选择不被延迟快照覆盖。
- 席位改绑后停止仍路由到原执行节点/会话；Mod 异步等待后重新检查席位，同席位普通任务先同步预留。

最后三项处理端修复经独立只读复核，规格及质量检查通过。最终真实 RoomService / WebSocket 集成 29 项已包含在 931 项桌面测试中，不重复累加工作者测试数量。

分项红绿记录：[审批队列](room-approval-queue-report.md)、[UI](room-task-ui-report.md)、[执行门禁及 MCP](room-read-only-report.md)、[控制器](room-task-controller-review-report.md)、[Agent 工具](room-chat-agent-report.md)、[旧测试迁移](room-protocol-test-migration-report.md)。分项报告保留中间结果，最终整合以本记录为准。

## 验证边界和后续批次

- 未执行真实 Electron 多窗口/DOM/中文输入法点击验收。UI 自动化覆盖真实组件静态渲染、Store 事件及受控输入事件，不等价于实机操作。
- 集成测试使用真实 RoomService、WebSocket 和 MCP client，但模型 SDK 查询由测试边界替代。未使用付费模型、执行真实危险工具，或验证操作系统子进程对中断的最终响应。
- 图片/文件选择、发送参数保留；跨机器传输附件字节和远端可读性尚未完成，不能把现有本地路径参数当作云文件传输。
- 全局账号、好友/私聊、跨群资料/黑名单/云历史，以及群主离线仍可使用的常驻中继服务属于后续批次；本轮没有更改房主承担协调端的网络拓扑。
- 下一步实机验收应覆盖：中文输入法选择/删除提及、多窗口并发审批、真实模型只读升级与停止、双设备断网及权限撤销。完成这些后再评估发布，不以本轮自动化通过代替线上验收。
