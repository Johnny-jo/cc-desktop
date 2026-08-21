# 房间传输 S1 执行进度

> 计划：`docs/superpowers/plans/2026-08-21-room-transport-s1.md`（15 任务）
> 分支：`multiplay` · 截至 2026-08-21，任务 1–8 完成，9–15 未做。

## 已完成

| 任务 | 内容 | Commit |
|---|---|---|
| 1 | AEAD 信封（X25519 + ChaCha20-Poly1305 + HKDF） | `0953a63` + 修正 `4eec063` |
| 2 | 握手 PDU（hs）+ HMAC 密码证明 + parsePdu 判别 | `92fec83` |
| 3 | CDR2 邀请码（密码不进码；CDR1 只读拒绝） | `659378e` |
| 4 | 设备钥落盘（userData/room-device.json） | `5ffe9da` |
| 5 | 帧大小上限表 + TokenBucket + HandshakeWatchdog | `f013cab` |
| 6 | RoomConnection（加密收发、mid 去重、累积 ACK、水位） | `9b607a7` |
| 7 | RoomService 接线：握手状态机、默认加密、CDR2 invite、fetchMod 先握手 | `7b426a4` |
| 8 | 审批 / 指纹 TOFU / 黑名单 / 踢人；join() 阻塞到 ok/reject/60s | `ebb523c` |

验证状态：shared 107 例全绿；desktop main 33 文件 351+ 例全绿（含 room-transport 集成 6 例、room-mod 27 例回归）；desktop typecheck 0 error。

## 未做（按依赖顺序）

- [ ] **任务 9**：重连改走握手路径（含密码+指纹），次数 3×30s → 5 次指数回退 1s/2s/4s/8s/8s；joinInfo 增 hostFingerprint/wss（password 仍只存本机归档）；重连后新 kid/session key，msg_id 从 1 重计。← 依赖 7、8
- [ ] **任务 10**：选路 T0+T1——lanAddresses() 加 IPv6；邀请码 LAN 与 wss:// 候选并行竞速（2s 超时，Promise.any）；create 加 `publicWss`（非空强制 encrypt）；Path 记录 T0/T1。← 依赖 7，可与 8/9 并行
- [ ] **任务 11**：T2 Cloudflare Tunnel——room-tunnel.ts（spawn cloudflared、解析 trycloudflare URL、30s 超时回退 LAN）；runtime-paths.resolveCloudflared；named tunnel token 只进 userData；end()/disposeAll() 杀子进程；electron-builder.yml 预留 bin/cloudflared。← 依赖 7、10
- [ ] **任务 12**：观测指标 room-metrics.ts（connect per-path / handshake per-reason / reconnect p50 环缓冲 64 / fanoutBytes；`[room-metrics]` 单行日志；IPC roomMetrics）。← 依赖 7–11
- [ ] **任务 13**：UI 与文案——创建对话框（跳过加密/自动放行/publicWss/隧道复选、密码 hint 改「不进邀请码」）；加入对话框（CDR2 placeholder、CDR1 报错不建连、密码框独立、wss+fingerprint 透传）；邀请弹窗显示加密状态与指纹；RoomPendingBanner（批准/拒绝）；群聊设置成员列表加「移出」；i18n 键按计划 1080–1097 行；推荐抽 src/lib/room-invite-ui.ts 纯函数 + vitest。← 依赖 3、7、8、10、11
- [ ] **任务 14**：滥用防护接线——超限帧丢弃+记桶（连续 5 次断开）、未知帧忽略+耗桶、伪造 roomId 忽略、握手超时 reject timeout、hs.ok 前禁 state.snapshot/席位。← 依赖 5、7
- [ ] **任务 15**：验收回归——全套测试 + 规格 §15 七条人工对照（写进 PR 描述）。← 依赖全部

## 执行中的已知偏离（子代理汇报摘录）

- 任务 7：`encrypt:false` 兼容房收到明文 join 帧时也取消握手看门狗（否则旧测例挂死）；明文兼容房不再校验密码（计划明确要求）；fetchMod 一律先握手；协议断代——新版客人连旧版房主会 12s 超时；room-archive.ts 被迫适配（重启后保留 encrypt/hostFingerprint）。
- 任务 8：`hs.hello` payload 增加可选 `userId`（TOFU 关联键；指纹变化即使 autoApprove 也强制重审）；join() 超时拆分为连接/握手/欢迎三段；踢人不清 members/seats（换设备批准后可回原席位）。
- 任务 6：明文帧无 mid，去重键用 `${peerFp}:${frame.seq}` 合成；补了 `peerUpto` getter。
- 任务 1 修正：`setAAD` 补 `plaintextLength`（@types/node 22 签名要求）。

## 恢复方式

从任务 9 继续，逐任务红 → 绿 → commit。UI 任务 13 之前 app 已可用但无审批/踢人界面。
