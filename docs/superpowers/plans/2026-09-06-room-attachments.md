# 群聊真实附件传输 Implementation Plan

> 执行：当前会话内原地继续，按 test-driven-development 与 dispatching-parallel-agents 实施；保留已有改动，不提交。设计见 `../specs/2026-09-06-room-attachments-design.md`。

**Goal:** 图片与文件跨设备送达，校验后发布消息并将真实内容交给远端 Agent。

**Architecture:** 共享不可执行的附件引用 → 本机有界缓存 → 已认证房间连接上的分块按需拉取 → 消息确认与任务输入校验。附件传输不占用普通消息串行队列。

**Stack:** TypeScript、Node fs/crypto、既有 WebSocket / Electron IPC、Vitest。

- [x] 1. 共享引用与协议：先测非法 metadata、路径、大小与重复引用；实现独立验证模块，扩充消息 / 执行 payload，应用协议 3。
- [x] 2. 独立缓存（委派，仅新 cache 文件及测试）：导入复制、摘要、配额、安全读取 / 接收；先红再绿。
- [x] 3. 独立传输（委派，仅新 transfer 文件及测试）：分块、请求匹配、超时、取消、并发和限速；不触及 RoomService。
- [x] 4. 主线 RoomService：真实临时文件测试先行；发送确认 / 去重、成员下载授权、任务附件和远端执行、关闭清理。替换旧测试虚拟路径但保留原断言。
- [x] 5. IPC / 状态与附件卡：预览 / 保存实际文件、失败保留草稿、截图保存、重试可控；不自动打开可执行文件。
- [x] 6. 审查与验证：重点检查任意文件读取、撤回 / 取消竞态、重复派工、配额、断线与旧协议拒绝。最终命令记录见 `room-attachments-verification.md`。

每任务运行其 `node node_modules/vitest/vitest.mjs run <test> --silent`（desktop cwd）；shared 使用 desktop 的 Vitest。最后完整 desktop/shared 测试、`tsc -p tsconfig.json --noEmit`、electron-vite build，记录精确结果。
