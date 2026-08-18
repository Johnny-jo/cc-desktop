# 房间 Mod 阶段任务

> 对照 `docs/dsh-inspired-mod-kernel-design.md` 与已落地的 hostApi 2 内核。  
> **已执行：阶段 0、1、2、4、5、6。** 阶段 3 延期，清单见 `docs/mods/phase-3-runner.md`。

**目标：** 把「组合层」从能挂两个官方包，推进到笔记 §6.5 的映射验证闭环；后面的 Cordis / 自改善单独开阶段。

**架构：** hostApi 1 玩法包保持单局 specialty。组合只走 hostApi 2：`inject` / `provides` / railway / 编译到现成 Agent 席位。不重写 SDK turn loop，不上 Fiber / WASM。

---

## 阶段总览

| 阶段 | 主题 | 对应笔记 | 本轮 |
|---|---|---|---|
| **0** | `inject` 真接到宿主 stub + 词表组合包 | §3.4 ctx 纪律、§6.5 翻译类映射 | **已完成** |
| **1** | 房间调度缝 + 定时/心跳包 | §6.5 定时任务（SDK 映射不通则自建最小缝） | **已完成** |
| **2** | manifest 资源预算与每群速率 | §3.1 配额 | **已完成** |
| **3** | UtilityProcess / WASM 可移植 runner | §3.2、§4 执行位置 | **延期**（`docs/mods/phase-3-runner.md`） |
| **4** | 有边界 AI 自改善管线 | §5 | **已完成** |
| **5** | Agent 席位编译 improve MCP | §5、§6.2 编译到现成席位 | **已完成** |
| **6** | 已应用 `mod.js` 落盘，再启用覆盖 | §5 审计/回滚兜底 | **已完成** |

玩法包多开（两套 `createGame`）**不列入阶段**：笔记把组合放在 kernel，不在 reduce 上叠局。

---

## 阶段 0（本轮）

**要证明的事：** 一个 hook 包可以 `inject: ["memory"]`，真正读到宿主 KV，并改写入站聊天。缺 `shared-memory` 时自己 pending，房间不崩。

今日缺口：`ModKernel.start` 把 inject bag 填成 `{ provided: true }`，依赖方拿不到 `get` / `set`。规格写的是「运行时 MCP / inject 绑宿主 KV，不执行作者闭包」。

### 交付

1. 知名 provide `memory` 的宿主 stub（打 `RoomKv.namespace("memory")`）。
2. 官方包 `apps/desktop/resources/mods/chat-glossary/`：
   - `inject: ["memory"]`，`hooks: ["room.chat.in"]`
   - 用记忆表做原文→替换（`key` 出现在消息里则换成 `value`）
3. 单测：无 memory → pending 且原文通过；有 memory 且 `hi=你好` → 入站变成「你好」。
4. 作者文档补一句：inject 的是宿主 stub，不是作者 `provide` 闭包。

### 不做

- 机器翻译 / 调 LLM
- SDK `extraHooks`
- 改玩法握手、多开 `ModHost`

---

## 阶段 1（下一轮）

笔记第三个典型包是定时任务。房间总线不是 SDK Cron 工具。

- 新缝：宿主 `schedule`（或复用现成 jobs，只对房间暴露 `ctx` 方法名登记）。
- 官方包：按间隔 `append` 系统条或 `inject` 到 Agent 席位。
- 映射不通的部分才自建；不包一层第二套 loop。

---

## 阶段 2

- manifest 增可选预算：调用频率、KV 已有配额之外的 hook 次数。
- 超限 → 该包 `pending` / 挂起，不拆房间。
- 防抖写进官方 hook 包或加载器，不进玩法 reduce。

---

## 阶段 3（延期）

完整说明与可补清单：`docs/mods/phase-3-runner.md`。

## 阶段 4（本轮最小管线）

笔记 §5：AI 可改 `mod.js` 实现，**不能**改 `inject` / `provides` / 权限 / hooks。

本轮交付：

- 提案只接受新 `mod.js`，manifest 边界用现包的，改边界直接拒绝。
- 沙箱试用：`compileKernelActivate` + 孤立 `ModKernel.start`。
- L0 只挂起待批；L1 提供集不变则自动应用；L2 试用通过即替换（仍同 manifest）。
- 应用前留下一版可回滚源码；时间线写审计条。

不做：自动找模型改代码、改 Fiber、客人执行提案。

### 验收

```
pnpm --filter @claude-desktop/desktop exec vitest run \
  electron/main/mod-kernel-improve.test.ts \
  electron/main/room-mod.test.ts
```

- L0 提案挂起，聊天仍走旧实现；房主批准后才换版。
- L1 同 `provides` 自动应用，回滚恢复上一版。
- 禁 import / 试用失败直接拒绝；L1 下 `provide` 集合有变仍待批。
- 房间设置可见自主权、粘贴 `mod.js`、待批批准/拒绝、回滚。

## 阶段 5（本轮）

阶段 4 的管线只有房主粘贴。笔记 §5 要的是 **AI 也能走同一条管线**，不是另开改代码 loop。

本轮交付：

- 房间挂了任意 hostApi 2 包时，把 `mod-improve` MCP 编进该房 Agent 席位。
- 工具：`kernel_list` / `kernel_get_source` / `kernel_propose` / `kernel_status` / `kernel_rollback`。
- `kernel_propose` 只收 `pack_id` + `mod_js`（+ 可选 note），内部走现成 `proposeKernelImprove`。
- 不给 Agent `apply` / `reject`：L0 批准仍是房主设置里的事。
- 卸掉最后一个扩展时，从已打开席位拆掉这组工具。

不做：自动找模型改代码、客人调用、改 Fiber、上阶段 3 runner。

### 验收

```
pnpm --filter @claude-desktop/desktop exec vitest run \
  electron/main/mod-kernel-compile.test.ts \
  electron/main/room-mod.test.ts
```

- 只开 `room-pulse` 对 Agent 说话 → extras 有 `mod-improve` / `kernel_propose`，没有 `mod-memory`。
- 卸包后 `syncExtras` 去掉 `mod-improve`。
- 开 `shared-memory` → `mod-memory` 与 `mod-improve` 同时在。

## 阶段 6（本轮）

阶段 4/5 只把已应用源码留在内存和 cache。`enableKernelMod` 总是从打包目录读官方 `mod.js`，卸包再勾上会丢改善。笔记 §5 的回滚/重放要求房间级 live 源码落盘。

本轮交付：

- improve store 增加按 pack 的 live `mod.js`；应用和回滚都更新它。
- 再启用同一 pack 时，试用 live 源码通过则覆盖打包目录版本。
- 试用失败则仍用打包目录，不拆房间。

不做：进程重启后续摊整房、自动找模型改代码、阶段 3 runner。

### 验收

```
pnpm --filter @claude-desktop/desktop exec vitest run \
  electron/main/mod-kernel-improve.test.ts \
  electron/main/room-mod.test.ts
```

- L1 应用 v2 → 卸包 → 再启用同一目录 → 聊天仍是 v2。
- 回滚后再卸/装 → 聊天是 v1。

---

## 阶段 0 验收

```
pnpm --filter @claude-desktop/desktop exec vitest run \
  electron/main/mod-kernel.test.ts \
  electron/main/room-mod.test.ts \
  electron/main/mod-kernel-package.test.ts
```

- 只勾「入站词表」→ 设置里显示 `pending · missing inject: memory`，聊天不改写。
- 再勾「群共享记忆」，在记忆里加 `hi` / `你好`，发送 `hi` → 时间线是 `你好`。
