# DSH 启发：群聊 Mod 系统的内核设计笔记

> 来源：2026-08-17 关于 DeepSeek Harness（DSH）的讨论整理。
> 背景：自研群聊系统，从群聊中提取需求做类似 Steam 创意工坊的 mod 机制，目标是群成员共享一个/多个 AI、跨设备调度。

## 1. DSH 核心结论速览

- DSH = Cordis 插件图（空间：系统由什么组成）+ Session 事件溯源日志（时间：系统做过什么），Agent Loop 夹在两者之间。
- 哲学一句话：**事件流 + 可逆副作用 = 全部控制流**。策略以监听器挂事件，能力以 Provider 挂 service seam。
- 关键机制：
  - **capability seam**：Definition / Provider / Consumer 三角色，消费者只依赖接口；`isolate()` 提供作用域隔离。
  - **Fiber + epoch**：Provider 身份（UID）编入 Consumer 依赖纪元，Provider 被替换 → Consumer 自动级联卸载重载，无需重启。
  - **effect/disposer**：插件创建任何资源必须同时登记清理函数，卸载时框架统一逆序回收。
  - **waterfall 事件**：`agent/pre-step`、`llm/stream` 等扩展点可包裹、可改写、可短路。
- 执行本体是 **turn/step 状态机 + 循环**，不是 DAG；DAG 只出现在编排层（workflow/jobs）。趋势是三层分化：流程可知→DAG，流程不可知→循环+状态机，跨执行历史→事件溯源。

## 2. 我们的系统与 DSH 的映射

| 我们的概念 | DSH 对应物 |
|---|---|
| mod | Plugin / Fiber |
| 群聊消息流 | Session 事件溯源日志（聊天天然是追加式事件流） |
| mod 跑在主机 or 分布式 | seam 里 Provider 的部署位置（实现细节，不是架构选择） |
| 群成员共享 AI | 多 Consumer 共享 service，会话作用域各自 isolate |
| 发起人（主机） | 宿主进程：注册表、审批、沙箱 |

## 3. 已定的架构决策

1. **放弃"分布式每人强制同步 mod 环境"**：mod 是不可信第三方代码，同步到每台成员设备 = 供应链攻击面 + 状态分叉无底洞。
   改为 **主机权威执行 + 事件流广播**：mod 只在主机沙箱跑，过程和结果作为事件追加到群聊日志，成员端只做投影和交互。
2. **跨设备靠可移植性，不是靠同步**：mod 用 WASM（或 QuickJS/isolated-vm）这类可移植沙箱格式，解决"能在哪跑"。
3. **不做完整 Cordis 内核，做最小可信子集**（两三百行加载器）：
   - manifest 声明式依赖：`inject` / `provides` / 权限声明；缺失即挂起，不崩溃。
   - disposer 所有权：注册资源时必须登记清理，卸载统一逆序回收。
   - waterfall 事件钩子：消息收发、AI 调用前后暴露为可包裹中间件链。
   - 简化加载器骨架：读 manifest → 拓扑排序 → 依序实例化并收集 disposer；不做 Fiber 状态机 / epoch / 配置树 diff。
4. **第一天就要守的纪律：mod 只许通过 ctx 拿能力，不许直接 import 宿主内部模块。** 一旦绕过 seam，依赖图就漏了，后续一切升级（换 Provider、迁设备、上内核）都堵死。

### 3.1 主机权威执行的压力评估（人数上来会不会撑不住？）

主机在一次 mod 执行中做四件事，重量差异很大：
- **事件扇出**：纯 WebSocket 转发，O(人数) 但单价极低——不是瓶颈。
- **mod 代码执行**：典型 mod 很轻，耗时在等 LLM 返回（I/O 等待，不占 CPU）——基本不是瓶颈。
- **沙箱常驻开销**：每群每 mod 一份 WASM/QuickJS 实例，MB 级——需配额管理，非结构性问题。
- **LLM 调用**：走云端 API（CPA 网关）时主机不出算力，出的是**配额和钱**——这才是真瓶颈，且与架构无关（分布式跑 mod 也不会减少 LLM 调用总量）。

结论：**先爆的是 LLM 配额/成本，不是主机性能。** 应对靠 mod 侧约束：防抖、批处理、每群速率上限、manifest 里声明 mod 资源预算（CPU/内存/调用频率上限，超限挂起——兼作防恶意 mod）。

Scaling 路径（关键认知：**权威的单位是"每个群一个"，不是"全系统一个"**，要的只是单群事件顺序确定 = single-writer per group）：
1. **按群分片**：谁建群谁扛，发起人设备即分片键。
2. **控制面/数据面分离**：主机只做权威排序+广播，mod 执行挪到专门 runner 节点——seam 的直接回报（Provider 从 local 换成 remote-runner 是配置层改动，mod 无感），即"执行位置迁移"场景的理赔。
3. 成员端投影/交互天然分布式（各自渲染 UI），无需管。

## 4. 什么时候才需要 Cordis 级内核

判别标准：**"换掉一个实现"发生得越频繁、越不允许中断，内核越值。**

需要它的场景：
- 能力 Provider 运行时切换（本地小模型 ↔ 云端大模型，Consumer 集体无重启迁移）
- mod 热升级（下游级联卸载→重载，群聊不中断）
- 安全降级（异常 Provider 立刻替换/拔除，Consumer 级联失效）
- 执行位置迁移（主机下线，会话进行中移交另一台设备）
- **自进化**：AI 自己生成 mod、加载、试用、不满意卸了换一版——产消双方都是 AI，变更频率远超人工场景，绝不可能靠重启

## 5. 核心目标：有边界的 AI 自改善（不超越既定范围）

> 目标：人类使用过程中，AI 帮助改善 mod 机制或功能（可自主自发、也可被动触发），但不能超越既定范围。

设计要点见下节（与 AI 讨论后的方案）。

### 5.1 边界的三层定义

- **能力边界（运行时强制）**：mod 的 manifest 即边界。AI 可以改实现，**不能改 `inject`/`provides`/权限声明**。AI 生成的代码就算试图访问未声明能力，ctx Proxy 直接挡住——这是结构保证，不靠 AI 自觉。
- **变更管线（流程强制）**：proposal → 沙箱试用 → diff → 分级放行：
  - 纯实现修复、不改变对外行为 → 可自动应用（留审计事件）
  - 新增能力声明、改接口、改权限 → 必须人类审批
- **自主权分级（可配置）**：
  - L0 被动：只提建议，人类动手
  - L1 半自主：修 bug、优化性能（同 manifest 内），自动应用 + 可回滚
  - L2 自主：重写实现、生成新版本（同 manifest），试用达标后自动替换
  - 任何级别都不允许自己扩大 manifest —— 范围扩大永远是人类特权
- **审计与回滚（事件溯源兜底）**：AI 每次修改都是事件日志里的一条事件，回滚 = 重放到修改前。群聊日志和 mod 变更日志可以共用同一套事件溯源设施。

### 5.2 与 Cordis 的对应关系

这个"有边界自改善"恰好是 Cordis 论文里"自进化 Harness"的收敛版：
- Cordis 的 `inject` 检查（未声明的 service 访问直接报错）= 能力边界的现成实现
- Fiber 级联重载 = AI 换版 mod 时下游自动跟随的机制
- effect/disposer = AI 试错（加载→试用→卸载）不留残留的前提

## 6. 与 CC SDK（claude-desktop）的分层关系：会不会和 CC 自身 loop 重合？

> 背景：claude-desktop 依托 Claude Agent SDK。结论：**只在选错层时才重合；分层选对了，mod 机制与 CC loop 是上下级关系。**

### 6.1 各管各的层

- **CC SDK 的 loop = 执行层**：单次会话内 模型调用→工具执行→结果回灌。这是 SDK 的本职，不重写、不外包。
- **我们的 mod 机制 = 组合层 + 分发层**：mod 的分发、版本、依赖、装卸、权限边界、跨设备部署位置、多人群聊共享。
- SDK 对组合层的态度是"启动时静态配置一次"（`options.plugins/agents/hooks`、MCP 配置），**没有**运行时依赖图、级联重载、在线替换的概念——不是重合，是空位。

### 6.2 三个真实重合点与避让策略

1. **自写 turn/step 循环 → 完全重合，禁止。** 状态机只做 mod 生命周期（pending→active→disposed），不碰模型对话轮次。
2. **自建消息中间件 vs SDK hooks（28 种）→ 部分重合，让 hooks 做实现。** mod manifest 声明"挂哪些事件"，加载器翻译成 SDK hooks 注册；我们做声明层/管理层，SDK 做触发层。不在 SDK 外再包消息管道。
3. **mod 工具能力 vs MCP/plugins → 重合，直接收编。** mod 包作为"编译目标"：

```
mod 包 → 加载器校验 manifest（inject/provides/权限）
       → 翻译成 SDK 原语：MCP server + skills + hooks + agent 定义
       → 交给 CC SDK 的 loop 执行
```

工坊流通的 mod 底层即 CC 兼容包；内核只管 SDK 不管的事：依赖图、生命周期、作用域隔离、权限边界、跨设备 Provider 位置。

### 6.3 我们独占、SDK 完全没有的层（核心资产）

- **多人维度**：SDK 是单用户单会话；群聊、成员共享 AI、主机权威执行 + 事件广播投影，SDK 完全没有。
- **分发与热生命周期**：工坊版本管理、依赖解析、在线装卸（SDK 的 `reloadPlugins` 只是重读配置）。
- **有边界的 AI 自改善**：manifest 能力圈 + 分级审批管线（SDK 权限是 per-tool 规则，不是 per-mod）。

### 6.4 一句话定位

**CC SDK ≈ Agent Loop + 工具执行管道；我们 ≈ Cordis（组合/生命周期）+ 群聊事件总线 + 多人投影。** 执行层有生产级 SDK 扛着，只需把组合层做扎实 + 定义 mod manifest → SDK 原语的翻译表。

### 6.5 待验证风险（下一步行动）

SDK 的 hooks/plugins 覆盖面能否表达我们的 mod 需求？
**验证方法**：挑 2~3 个典型 mod（消息自动翻译、群共享记忆、定时任务），试着把 manifest 映射到 SDK hooks + MCP。
- 映射得通 → 架构成立；
- 映射不通的部分 → 就是真正需要自建机制的最小范围。

## 7. 参考

- DSH 源码级中文拆解（15 篇）：https://github.com/Bin-hy/dsh
- DSH 架构解析（腾讯新闻）：https://view.inews.qq.com/a/20260814A062FZ00
- 两种 Harness 哲学对比（博客园）：https://www.cnblogs.com/shanyou/p/22485002
- Cordis 论文：*A Programming Paradigm for Spatiotemporal Composability*（88 页，时空可组合性）
