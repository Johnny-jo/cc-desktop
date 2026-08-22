# 群聊上云（云房主 roomd）设计

> 状态：待评审。前置：`2026-08-20-room-comms-design.md`（S1 传输架构）、S1 实现与中继/恢复均已落地（分支 multiplay）。
> 用户钉死的前提：**既有连接方式（T0 LAN / T1 公网 WSS / T2 CF Tunnel）全部保留；中继服务是独立模块，另走一套，不并入本设计。**

## 1. 一句话

把「房主」从桌面 App 搬进常开 VPS 上的 headless 守护进程（`roomd`）：房间 7×24 在线，桌面端变成参与/管理端；传输、加密、审批、邀请码协议**零变化**。

## 2. 产品前提（不可再议）

- 云房主 = 房主换了一台常开的机器。权威仍在房主进程，星型拓扑不变，应用层 AEAD 不变。
- 桌面 App 本地开房能力完整保留（LAN / publicWss / 隧道 / 中继照旧）。云房间是「多一种开房位置」，不是替代。
- 中继模块（`scripts/room-relay-server.mjs` + `room-relay.ts`）保持独立：本地房主无入向时照用；云房主天然公网可达，一般不需要中继，但代码路径不动（VPS 入向受限时可反挂中继，属运维选择）。
- 房间不是纯聊天：席位、mod kernel、Agent 席位都随云房主跑在 VPS 上。

## 3. 架构

```
桌面 App（客人/管理员）          VPS
┌──────────────┐   wss    ┌─────────────────────────┐
│  RoomService  │ ◄──────► │  roomd（headless 房主）  │
│  （join 云房间）│          │  RoomService 复用        │
└──────────────┘          │  ├─ RoomArchive（磁盘）   │
                          │  ├─ Agent 运行时（SDK）   │
                          │  └─ config.json（声明式） │
                          └─────────────────────────┘
```

`RoomService` 现有三处 Electron 耦合，抽成可注入适配层（本就接近）：

| 依赖 | 桌面 | roomd |
|---|---|---|
| `getWindow()` 推送 roomEvent | BrowserWindow | 事件 sink：日志单行 + 推给在线管理员（见 §5） |
| `SessionManager`（Agent 席位） | 本机 SDK 会话 | 云端会话运行时（API key 在 daemon 配置） |
| `SettingsStore` / `userDataDir` | Electron app 路径 | 数据目录（默认 `/var/lib/roomd`） |

设备钥、CDR2、握手、AEAD、审批、踢人、滥用防护、metrics、resume 全部复用现状代码。

## 4. 连接方式（全保留）

- **T1 公网 WSS（云房间主力）**：VPS 公网 IP + Caddy/反代 TLS，邀请码 `u` 写 `wss://room.example.com`。roomd 本机仍明文 `WebSocketServer` 监听，TLS 由反代终止（同 S1 决定）。
- **T2 CF Tunnel**：可选，VPS 不想开入向端口时用。
- **T0 LAN**：云场景无意义，代码路径不动（邀请码 `h/hs` 写 VPS 内网地址，没人会用而已）。
- 强制 `encrypt: true`（公网房间不可跳加密，现状逻辑直接继承）。

## 5. 身份与管理面

权威模型从「本地 IPC 即房主」变为「按设备指纹鉴权的在线管理员」：

- daemon 配置 `admins: ["<设备指纹64hex>", ...]`。桌面端用户的设备指纹（`userData/room-device.json`，本机可复制查看）填进 VPS 配置。
- 云房间快照：`members[]` 增 `admin?: boolean`（指纹命中配置即置位）；桌面 UI 管理入口（审批/踢人/设置/邀请）从 `localRole === "host"` 放宽为 `localRole === "host" || 自己 admin`。
- **管理动作走线上帧**：云房间的审批/踢人不再是本地 IPC，而是带指纹的管理帧（新增 `admin.approve` / `admin.deny` / `admin.kick`，或复用现有 kick 帧扩方向——实现时钉），daemon 校验发送者指纹 ∈ admins 才执行。本地房间的管理仍走本地 IPC，两条路径由 room-store 按房间来源分流。
- 待审批推送：daemon 把 pending 列表广播给在线管理员成员（`admin.pending` 帧）；无管理员在线时客人 join 照旧阻塞到 60s 超时，与现状语义一致。
- **建房（MVP）**：不做线上建房协议。roomd 读 `config.json` 的 `rooms[]` 声明式开房（名称/端口/密码/autoApprove/publicWss/tunnel）。线上 `room.create` 管理帧列入后续版本。
- 管理员指纹变化：沿用 TOFU 语义——指纹不在 admins 列表即无权限，不存在「指纹变了还是管理员」的洞；加管理员 = 改配置 + SIGHUP/重启。

## 6. Agent 席位与凭证

- Agent 席位在 roomd 上运行，LLM API key 放 daemon 配置（环境变量引用，不直接写配置文件值）。**不进邀请码、不进客户端、不进日志**。
- 未配置凭证时 Agent 席位发言返回明确错误文案；聊天、mod、游戏逻辑不受影响。

## 7. 持久化与断线语义

- 时间线/席位/成员/归档全在 daemon 数据目录；roomd 重启直接复用 S1 的 resume 逻辑自动恢复开房（端口/指纹/邀请码全稳定）。
- 客人断线重连照旧（5 次指数回退 + 全量快照 ≤400）；桌面端离线浏览照旧。
- 「全员断联房间不死」由此达成：权威进程在常开 VPS，谁回来谁重连。

## 8. 威胁模型增量

- 信任锚点移动：从「房主在用户自己机器上」变为「房主在用户自有的 VPS 上」。**VPS 失陷 = 房间失陷**（与本地房主失陷等价），云厂商/机房人员理论上能读到进程内存——这与「中继/CF 只见密文」不同，因为权威在 VPS 上。用户须知。
- 传输中途方（反代、CF、ISP）仍只见 AEAD 密文，不变。
- 密码不进邀请码、审批、黑名单、滥用防护全部继承，无增量暴露面。管理帧按指纹鉴权，伪造无效。

## 9. 观测

- 沿用 `RoomMetrics`（connect/handshake/reconnect/fanout），roomd 输出 `[room-metrics]` 单行日志；后续版本加只读 metrics HTTP 端点（监听 127.0.0.1，给管理员 scrape）。

## 10. 部署

- `roomd` = Node ≥20 单进程；交付形态：pnpm workspace 新增 `apps/roomd`（或 packages/roomd），构建产物 + systemd unit 示例。
- 配置 `/etc/roomd/config.json`：

```json
{
  "dataDir": "/var/lib/roomd",
  "admins": ["<fp64>"],
  "rooms": [
    { "name": "大厅", "port": 18765, "password": "…", "autoApprove": false,
      "publicWss": "wss://room.example.com" }
  ]
}
```

- 升级 = 换二进制 + `systemctl restart roomd`，resume 保证房间现场不丢。

## 11. 阶段拆分

| 阶段 | 内容 | 验收 |
|---|---|---|
| C1 | roomd 骨架：适配层抽离、配置开房、T1 直连、归档/resume 复用 | VPS 上跑起，桌面端用 CDR2 加入、加密聊天 |
| C2 | 管理员面：admins 指纹、管理帧鉴权、pending 推送、桌面 UI 放宽 | 管理员远程审批/踢人；非管理员伪造管理帧被拒 |
| C3 | Agent 席位上云（凭证配置化） | 云房间 Agent 席位可对话；无凭证时降级文案 |
| C4 | metrics 端点、线上建房管理帧、systemd/安装文档完善 | 运维闭环 |

**明确不做（本期）**：中继邮箱/存储转发（路线 A，另行立项）、多房主 failover、房间跨机迁移、member 间 mesh、线上建房（C4 才做）。

## 12. 验收标准（C1+C2 完成时）

1. roomd 在 VPS 常开，桌面端凭邀请码 + 密码加入，全程 AEAD（抓包无明文）。
2. 桌面全员退出后房间仍在；重连拿到完整快照。
3. roomd 重启自动恢复开房，原邀请码有效。
4. 管理员设备远程审批新设备、踢人；踢后黑名单生效。
5. 非管理员发管理帧被忽略并耗桶（滥用防护一致）。
6. 本地开房四条路径（LAN/WSS/隧道/中继）回归全绿——云端改动不触碰本地路径。
