# 房间传输 S1 执行进度

> 计划：`docs/superpowers/plans/2026-08-21-room-transport-s1.md`（15 任务）
> 分支：`multiplay` · 截至 2026-08-22，**任务 1–15 全部完成**。

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
| 9 | 重连走握手路径：5 次指数回退 1s/2s/4s/8s/8s；joinInfo 增 wss（hostFingerprint 任务 7 已有）；新 kid/session key、msg_id 从 1 | `14c8ce9` |
| 10 | 选路 T0+T1：lanAddresses 加 IPv6；LAN/wss 候选并行竞速（2s，Promise.any）；create 加 publicWss（非空强制 encrypt）；joinInfo.path 记 T0/T1/T2 | `bd1c4b2` |
| 11 | T2 Cloudflare Tunnel：room-tunnel.ts（quick/named、30s 超时降级 LAN）；resolveCloudflared；electron-builder 预留 bin/cloudflared；end()/disposeAll() 杀子进程 | `b865476` |
| 12 | 观测指标 room-metrics.ts（connect per-path / handshake per-reason / reconnect p50 环缓冲 64 / fanoutBytes；`[room-metrics]` 单行日志；IPC roomMetrics + preload getRoomMetrics） | `97eb0e4` |
| 13 | UI：创建对话框（跳过加密/自动放行/publicWss/隧道、密码 hint）；加入对话框（CDR2 placeholder、CDR1 报错不建连、密码框独立、wss+fingerprint 透传）；邀请弹窗加密状态+指纹；RoomPendingBanner；群聊设置成员「移出」；lib/room-invite-ui.ts 纯函数 + 6 例 | `4dc56e6` |
| 14 | 滥用防护接线：超限帧丢弃+连续 5 次断开、未知帧忽略+耗桶、伪造 roomId 忽略、握手超时 reject timeout、hs.ok 前禁 state.snapshot/席位 | `6280c39` |
| 15 | 验收回归（结果见下） | 本文档 |

## 任务 15 验收结果（2026-08-22）

- `pnpm --filter @claude-desktop/shared test`：107/107 绿；shared typecheck 干净。
- `pnpm --filter @claude-desktop/desktop typecheck`：0 error。
- desktop 全套 vitest：466 过 / 4 失败。**4 个失败全部是既有环境问题**：`mod-kernel-compile.test.ts` 2 例 + `room-mod.test.ts` 2 例（"attaches improve/memory MCP extras…"、"…the SDK accepts"），根因是本机 Node v20.14.0 无法 `require()` ESM-only 的 `@anthropic-ai/claude-agent-sdk@0.3.220`（sdk.mjs），`loadSdk()` 返回 null。与 S1 改动无关，同 `room-ux-overhaul-tasks.md` 记录的「SDK 加载环境失败」同类；Electron 运行时 Node ≥22.12 支持 require(esm) 不受影响。
- room 传输专项 8 文件：83 过 + 上述 2 例环境失败。

### 规格 §15 七条对照（PR 描述可勾选）

1. ✅ LAN + CDR2 + 密码进加密房，线上不见明文——room-transport.test.ts「加密加入成功」用 `parsePdu === env` + `openEnvelope → welcome` 代替 tcpdump。
2. ✅ 仅凭 `wss://` 可进同一协议——room-path.test.ts「prefers a live wss candidate when LAN is dead」（自签 TLS 管道 + `rejectUnauthorized:false` 仅测试钩子）；room-tunnel.test.ts 证明 invite 含 trycloudflare wss 且强制 encrypt。
3. ✅ 错密码无成员列表（reject reason=password，无 state.snapshot）；未审批设备进不了默认审批房（任务 8 pending 用例）。
4. ✅ 被踢指纹换端口重连仍拒（"blacklisted fingerprint is rejected after kick"）。
5. ✅ 不开隧道时 T0 测例全绿；T2 为独立 `room-tunnel.ts`，可删除而不影响 T0。
6. ✅ CDR1 粘贴只提示升级：room-protocol.test.ts + room-invite-ui.test.ts（joinErrorForInvite）。
7. ✅ metrics 区分 T0/T1/T2 与握手原因分槽：room-metrics.test.ts + room-transport 集成断言（T0 connect ok 与 password 失败分槽）。

## 执行中的已知偏离（子代理汇报摘录）

- 任务 7：`encrypt:false` 兼容房收到明文 join 帧时也取消握手看门狗；明文兼容房不校验密码；fetchMod 一律先握手；协议断代——新版客人连旧版房主 12s 超时；room-archive.ts 适配（保留 encrypt/hostFingerprint）。
- 任务 8：`hs.hello` payload 增可选 `userId`；join() 超时拆连接/握手/欢迎三段；踢人不清 members/seats。
- 任务 6：明文帧无 mid，去重键用 `${peerFp}:${frame.seq}` 合成；补 `peerUpto` getter。
- 任务 1 修正：`setAAD` 补 `plaintextLength`。
- 任务 9：metrics 模块当时不存在，重连失败埋点在任务 12 补上（tryReconnectOnce 的 done() 统一记 reconnect{ms,ok}）；单次重连预算 12s/10s（5×12+23≈83s 与旧 3×30s 同量级）；测试时间注入用私有 `reconnectSleep` 字段 cast。
- 任务 10：选路测试用 `tls.createServer` 字节管道转发到房主明文端口（模拟外部 TLS 终止），而非 https.createServer+WSS——走真实完整握手路径；竞速失败文案改「无法连接主机（已尝试 N 条路径）」；`publicWss` 非 `wss://` 开头直接报错（防御性）。
- 任务 11：`prepare-vendor.mjs` 增 `ensureDir(vendor/cloudflared)`（vendor 被 gitignore，空目录无法入库）；named 配置缺 wss 字段的报错文案与子进程早退文案为自选补充。
- 任务 12：connect 指标埋在 `raceCandidates` 每条候选（非只记胜出者）；fanout 字节按明文帧×接收人数计，不含 AEAD 信封开销。
- 任务 13：「自动放行新设备」「公网可达」两标签无 i18n 键，按 RoomSidebar 惯例硬编码中文；客人侧等待沿用 busy 进度 + 60s 超时错误文案。
- 任务 14：**计划内部冲突的取舍**——任务 7 说「mod.fetch 必须在 hs.ok 之后」，任务 14 规则 5 说「mod.fetch 仍允许（checksum 已在邀请码里）」；按任务 14 执行，加密房 pre-hs.ok 的明文 mod.fetch 会被服务（fetchMod 客户端流程不变，仍先握手）。**已知缺口**：尺寸闸门只在 onGuest.onMsg（握手前 + 明文房全程）；握手升级后加密房入站归 RoomConnection.onMessage，无字节上限（AEAD 校验兜底），如需收紧给 RoomConnection 加同类检查，另开任务。

## 后续（非 S1 范围）

- RoomConnection 入站尺寸闸门（见上）。
- S2：快照差量与扇出写合并；跨 Path 半包续传（未 ACK 缓冲已在 RoomConnection 预留）。
- 房主崩溃后续摊；CPace/OPAQUE 替代 HMAC 挑战-响应。
