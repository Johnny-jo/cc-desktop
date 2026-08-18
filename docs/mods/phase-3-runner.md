# 阶段 3：可移植 runner（延期，后续可补）

对照 `docs/dsh-inspired-mod-kernel-design.md` §3.2 / §4，以及 `docs/superpowers/specs/2026-08-17-mod-kernel-design.md`「本期不上 WASM；v1 默认 in-process-vm」。

**状态：延期。** 不是取消。组合层（阶段 0–2）和自改善管线（阶段 4）不依赖本阶段合入。

## 现在为什么还不上

- 现有 kernel 包都是仓库内官方包，没有工坊、没有陌生人投包。
- 客人不执行 hostApi 2 源码；攻击面不随人数扩大。
- 先爆的是 LLM 配额，不是主进程 CPU。阶段 2 的 `budget` 已覆盖这条。
- hook / schedule 回调仍是同进程函数引用。上 UtilityProcess 要把 railway 和定时器改成 RPC，不是加一个 worker 文件。
- 玩法包（hostApi 1）生产环境已经有 `ModHost` UtilityProcess。kernel 再做一遍，收益是「扩展也隔离」，不是「第一次有隔离」。

## 何时提前

出现任一条件即可开工：

- 开始收第三方 / 工坊包
- 需要跨设备移交进行中的房间
- AI 开始生成并热替换 `mod.js`（与阶段 4 叠加后，隔离变刚需）
- 有官方包卡死 UI / 拖垮主进程的实证

## 后续补做清单（按顺序）

1. **锁 CtxWire**  
   所有进沙箱的能力只传方法名与 JSON 值。`hooks.on` / `schedule.every` 的回调改为 worker 调宿主、宿主再回 worker 的帧，禁止传函数引用或 Node 句柄。

2. **UtilityProcess runner**  
   复制或 export `mod-host.ts` 的 `tryUtilityProcess`。生产可用则走 worker，测试 / 无 `utilityProcess` 时回退 `in-process-vm`。作者 API 不变。

3. **回归**  
   官方包 `shared-memory` / `chat-guard` / `chat-glossary` / `room-pulse` 在两条 runner 上行为一致：pending、词表改写、心跳、预算跳过、卸包停表。

4. **WASM / QuickJS（更后）**  
   只解决「以后能在哪跑」。不要和 UtilityProcess 同一轮做。

## 明确不在本阶段做

- Fiber / epoch / 配置树 diff
- 主机下线后会话中热移交
- 客人执行 kernel 代码
