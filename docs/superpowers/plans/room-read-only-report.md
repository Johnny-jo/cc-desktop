# 群聊执行端只读门禁报告

日期：2026-09-05（Asia/Shanghai）

## 本次文件

- `apps/desktop/electron/main/session-manager.ts`：新增运行选项、每轮审批状态及真实 `PreToolUse` 门禁。
- `apps/desktop/electron/main/session-manager.test.ts`：新增 16 个 query hooks 场景，使用实际 `SessionManager.start/continue/abort`。
- `docs/superpowers/plans/room-read-only-report.md`：本报告，通过 `apply_patch` 新增。

未新增 `room-read-only.ts/.test.ts`；本次实现集中在 SessionManager 内。未编辑 RoomService、shared、UI 或其他并发修改文件，未安装依赖，未提交或推送。

## 行为与接入约定

`SessionRunOpts` 新增：

```ts
roomReadOnly?: boolean;
requestRoomWriteAccess?: (
  name: string,
  input: Record<string, unknown>,
) => Promise<boolean>;
```

- 每次工具调用都经过 `PreToolUse`，不依赖提示词、SDK plan 模式或 `canUseTool` 是否触发。测试包含 default、acceptEdits、auto、plan 模式及显式 `extraAllowedTools`。
- `Read/Glob/Grep` 允许执行，仍受 `pathJail` 约束。越界请求首先直接 deny，不发起只读升级审批；等待审批后再次校验路径。
- Bash、Edit、Write、MultiEdit、NotebookEdit、Task、Agent、未知 MCP 及其他不在白名单中的工具，必须先等待 `requestRoomWriteAccess`。回调缺失、返回 false 或抛错均 deny；仅严格返回 true 才批准。
- 仅精确匹配 `mcp__room-chat__room_members` / `mcp__room-chat__room_message`，且出现在实际 query 绑定快照的工具列表、对应 `extraMcpServers["room-chat"]` 为内置 SDK server 时豁免。普通同名 stdio server 或未绑定工具不会获得豁免。两项工具的业务权限由 RoomService 控制。绑定快照修复见 2026-09-06 补充。
- 批准仅解除本轮只读限制；hook 返回 `{}`，继续遵守路径守卫、SDK 权限和原有 PermissionBroker，不返回强制 allow。
- `start/continue` 每轮创建新的 `roomReadOnlyTurn`，保存本轮回调，初始化未批准状态。`continue` 未传回调不会沿用旧回调；`roomReadOnly` 为 false 或省略时清除本轮只读状态。
- query hooks 每次读取当前 entry 的轮次对象，避免 query 复用时捕获旧权限状态；MCP 豁免则固定读取实际 query 的绑定快照。测试确认同一个 query 可依次处理普通、只读批准、只读拒绝、无回调只读及普通轮次。
- 审批前后检查轮次对象身份、`turnActive`、query 的 `streamGen`、query AbortController 及 SDK hook signal。取消后即使旧审批迟到批准，且新 query 已启动，也拒绝旧工具，不解锁新轮次。
- 普通会话未启用 `roomReadOnly` 时，不调用房间审批回调，保持既有工具权限流程。调用方应在每个需要只读的群聊轮次显式传入 `roomReadOnly: true`。

## TDD 红绿证据

先完整读取 `test-driven-development/SKILL.md` 及其测试反模式参考，再编写测试；确认红灯后才修改实现。以下测试命令均在 `D:/gitRep/ccDesktop/apps/desktop` 运行。

1. 第一轮红灯（21:43:33）：

   ```text
   node node_modules/vitest/vitest.mjs run electron/main/session-manager.test.ts -t 'room read-only query hooks'
   Tests 13 failed | 2 passed | 41 skipped (56)
   exit 1
   ```

   失败来自真实缺失行为：危险工具执行、审批回调未调用、旧状态不能按轮隔离。两个已通过用例是原有路径守卫和普通会话对照；没有用语法或导入错误冒充红灯。

2. 第一轮绿灯（21:45:46）：同一命令，`15 passed | 41 skipped (56)`，exit 0。

3. 补充路径守卫优先级红灯（21:47:33）：

   ```text
   node node_modules/vitest/vitest.mjs run electron/main/session-manager.test.ts -t 'rejects out-of-jail writes before'
   Tests 1 failed | 56 skipped (57)
   exit 1
   ```

   失败原因：越界 Write 仍调用一次升级审批，预期为零次。调整为越界优先 deny 后，同一命令在 21:48:11 得到 `1 passed | 56 skipped (57)`，exit 0。

## 最终验证

完成前按 `verification-before-completion` 技能重新运行相关测试及 typecheck，使用已有本地依赖。

```text
node node_modules/vitest/vitest.mjs run electron/main/session-manager.test.ts electron/main/room-turn-ask.test.ts electron/main/permission-broker.test.ts electron/main/message-stream.test.ts
```

21:48:32：4 个文件全部通过，97/97，exit 0。

| 测试文件 | 通过数 |
| --- | ---: |
| session-manager.test.ts | 57（含本次新增 16） |
| room-turn-ask.test.ts | 25 |
| permission-broker.test.ts | 13 |
| message-stream.test.ts | 2 |

```text
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

最后一次 typecheck 为 exit 1，仅报告并发修改文件中的一处错误：

```text
src/state/room-store.ts(259,7): error TS2353:
Object literal may only specify known properties, and 'mySeatName' does not exist in type ...
```

本次修改的两个 TypeScript 文件均无 typecheck 诊断。较早一次检查曾报告 `room-compose.test.ts`、`room-mention-draft.test.ts`、`room-notify.test.ts` 的并发接口错误；最终检查时这些错误已消失。上述文件未由本次任务修改。

`git diff --check` 对本次两个代码文件通过；Git 仅提示工作区 LF/CRLF 转换。

最初 `pnpm --filter @claude-desktop/desktop exec vitest ...` 因命令解析报 `vitest not found`，随后直接用 Node 运行工作区已有 `vitest.mjs` 和 `typescript/bin/tsc`。这次启动失败不计入 TDD 红灯。

验证边界：测试在注入的 SDK query 边界调用 SessionManager 实际生成的 hooks，覆盖真实生命周期和权限判定；未启动模型服务、执行真实危险工具或测试 RoomService/UI 的端到端接线。

## 只读审查与取消入场窗口修复补充

日期：2026-09-05；验证时间 23:41–23:50（Asia/Shanghai）。

### 审查结论及范围

按 `requesting-code-review` 对照 `git diff HEAD` 和实际 SessionManager 生命周期检查。当前环境没有子代理工具，直接按技能模板完成规格、质量及边界审查。

- 审批 FIFO：指定范围的实现符合 A/B 不覆盖、按 requestId 删除、旧响应不清新请求的要求。检查了真实 Store 订阅、对象身份保护、reset/clear 和组件读取方式；未重跑审批队列测试，未编辑 Store、UI 或对应报告。
- 执行门禁：保守白名单、默认拒绝、审批后身份/路径复核和 start/continue 的逐轮权限重置合理。未确认 Critical；发现下面的 MCP 绑定 Important 和取消准备阶段 Important。
- `room-service.ts` 按主控要求未纳入审查或编辑。

**历史 Important：room-chat 豁免与实际 query 绑定可能不一致。主控后续确认并授权修复，现已解决，见 2026-09-06 补充。**

位置（修复前快照）：`session-manager.ts:2263` 的 `isRoomChatTool` 和既有 `extrasChanged`（415 行）。门禁读取可变的 `entry.extraMcpServers`；既有 extras 变更判断只比较服务器名和工具名集合，相同名称下替换服务器不会重开 query。

复现步骤：

1. `start()` 传 `roomReadOnly: true`、始终返回 false 的写审批回调、`extraAllowedTools` 包含两项 room-chat 工具，`extraMcpServers["room-chat"]` 绑定 stdio server。
2. 第一轮调用 `mcp__room-chat__room_message`，被拒绝并调用一次审批。
3. `continue()` 保持相同工具/服务器名，传 `replaceExtras: true`，将同名 server 替换为 `{ type: "sdk", name: "room-chat", instance: ... }`。
4. 第二轮真实 query 仍绑定旧 stdio，但 hook 已按新 extras 豁免。

只读内存诊断加载了实际 SessionManager，并在 query 边界记录配置与 hook 输出；结果为 `queryCount: 1`，两轮实际绑定均为 stdio，决策分别是 `deny` 和 `{}`，审批调用总数仍为 1。没有启动 MCP 进程或执行工具。最小建议是绑定变化时重开 query，且豁免依据取实际 query 的绑定。该阶段授权只修取消窗口，未修改该问题；后续修复及红绿证据见下节。

**取消准备阶段 Important：已在本补充中按授权修复。**

原根因：`start()` 在创建 sessionId 前等待 CPA；`continue()` 也会在 push/开 query 前等待 CPA。外部在调用 SessionManager 前检查一次取消状态不足以覆盖这些等待。`onSessionId` 内调用 `abort()` 也不足：既有 `openStreamingSession()` 会随后新建 AbortController 并重新设 `turnActive = true`。

修复前只读诊断记录：

- start：CPA 等待 → 房间取消 → onSessionId 内 abort 返回 → query 仍创建，Read hook 返回 `{}`。
- continue：CPA 等待 → abort 返回 → CPA 完成 → 第二个 query 仍创建。

### 修复行为与最小接线约定

新增 `SessionRunOpts.roomAbortSignal?: AbortSignal`，只由群聊调用方传入，与 `roomReadOnly` 独立：已获写权限的群聊任务同样可取消。

- 主线本地任务在每次 `start/continue` 传 `roomAbortSignal: context.signal`；远端传当前 `NodeTurn` 的 `AbortController.signal`。同一轮其他 extras 和门禁参数保持现有接线。
- start 在 CPA 前后检查 signal；登记 session 后立即建立本轮监听，在 onSessionId 返回后复核。continue 在 CPA 准备前建立新的轮次对象，等待后验证对象仍属本轮且未取消。
- 已取消的准备阶段抛出取消异常，不向 warm query push，也不创建新 query。signal 的入口检查保留其原始 reason（默认 abort 为 AbortError）；已登记轮次的取消或替换抛 AbortError。取消发生在 onSessionId、query 配置构造阶段同样生效。现有 CPA 接口不支持取消底层准备；它可能继续等待完成，但完成后不会启动任务。
- signal 的监听调用现有 `abort()`；显式 `abort(sessionId)` 也标记当前房间轮次已取消。完成、终止、停放或替换轮次时解除监听；成功的压缩自动续跑会重新挂上当前轮次监听。
- PreToolUse 同时校验房间轮次、query 代次、活跃状态及取消 signal；写审批与原 PermissionBroker 的等待结束后再校验，迟到允许不能执行工具。旧 query 的 hook 不能借新房间轮次的 signal 通过。
- 压缩在异步 summarize 完成后先校验原房间轮次，取消或被新轮次替代时不覆盖 transcript，也不自动续跑。
- 每次 continue 显式替换本轮 signal；省略时清除房间取消状态。旧 signal 不影响后续房间轮次或普通会话。原有 roomReadOnly 门禁及其测试全部保留。

### 新增 TDD 红绿证据

先完整读取 `test-driven-development/SKILL.md` 和测试反模式参考；生产修改仅在观察到断言红灯后进行。命令均在 `D:/gitRep/ccDesktop/apps/desktop` 执行。

第一轮命令：

```text
node node_modules/vitest/vitest.mjs run electron/main/session-manager.test.ts -t 'room abort signal'
```

- 23:41:16 红灯：`12 failed | 1 passed | 57 skipped (70)`，exit 1。失败为取消后实际 query 仍创建/复用、迟到许可仍执行工具或压缩仍自动续跑；通过项是旧 signal 不影响后续轮次的对照。非导入/语法失败。
- 23:44:26 绿灯：`13 passed | 57 skipped (70)`，exit 0。

补充旧 query 与新可写房间轮次交错：

```text
node node_modules/vitest/vitest.mjs run electron/main/session-manager.test.ts -t 'denies stale query hooks'
```

- 23:48:57 红灯：`1 failed | 72 skipped (73)`，exit 1。旧 query 的 Read hook 在新房间轮次活跃时返回 `{}`，应为 deny。
- 增加 query 代次/取消状态复核后，23:49:19 重跑完整取消专项：`16 passed | 57 skipped (73)`，exit 0。另两项补充对照验证 query 配置构造期间取消，以及成功自动续跑仍可取消。

### 最终验证与交付边界

按 `verification-before-completion` 执行有明确目的的相关回归：

```text
node node_modules/vitest/vitest.mjs run electron/main/session-manager.test.ts electron/main/permission-broker.test.ts electron/main/message-stream.test.ts
```

23:50:09：3 个文件全部通过，`88 passed (88)`，exit 0；分别为 SessionManager 73、PermissionBroker 13、MessageStream 2。SessionManager 包含原有 16 项只读门禁和新增 16 项取消测试。

```text
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false
```

最终 exit 0，无类型诊断。中间一次检查发现新增测试的 CPA ready fixture 缺少 `port/managedByApp`，已补全完整响应结构后重新通过。

`git diff --check -- apps/desktop/electron/main/session-manager.ts apps/desktop/electron/main/session-manager.test.ts` 最终 exit 0；仅有 Git 的 LF/CRLF 提示。

仅修改 `session-manager.ts`、`session-manager.test.ts` 和本报告；未修改 Store/UI/service，未提交、推送或部署。测试使用实际 SessionManager 的 start/continue/abort/compressSession，在 CPA、压缩器及 SDK query/权限边界控制时序；未启动模型服务或执行真实工具。主线的本地/远端 signal 接线与实机端到端验证仍由主控整合。

## 同名 MCP 配置与 SDK 实例重绑修复补充

日期：2026-09-06（Asia/Shanghai）。本节为主控确认原 Important 后的独立授权修复；仍只编辑原两个代码文件和本报告，未新增 extras 工具文件。

### 根因与修复

原 `continue()` 的 replace 分支只比较名称集合，merge 分支只检查新名称；两者都漏掉同名 transport 配置和 SDK 实例的变化。新 task 即使传入新的 room-chat SDK 实例 B，也会复用绑定实例 A 的 query，从而继续调用旧 task 闭包。与此同时，PreToolUse 读取已更新的 entry extras，造成权限依据与执行绑定不一致。`syncExtras()` 存在同一名称判断缺陷。

- 打开 query 时保存 `queryExtras` 快照；stdio/http/sse 等可序列化配置复制数据，SDK wrapper 复制但 `instance` 保留引用身份。调用方后续原地修改 args/env 或替换 wrapper.instance，不会反向污染旧 query 的配置。
- `extrasChanged()` 同时比较服务器名、工具名、完整配置及 SDK 实例身份。不同但结构相同的 SDK 实例也必须重开；相同实例与等价配置（对象键和工具顺序变化）保持复用。
- `continue()` 在异步准备通过后，用实际 query 快照对比最终 extras，复用现有 `reopenForExtras` / resume 流程。replace 与 merge 都遵守相同判断；不会覆盖已由 model 变化置位的重开标志。
- 对比基准不使用上一次尝试写入的 entry extras：CPA 准备失败后，即使重试省略 extras，也会将已暂存的新绑定真正附加到 query。
- `syncExtras()` 同样对照 query 快照，绑定变化时通过现有 abort 流程使旧 query 失效。终止、停放和 rewind 清理 query 时一并释放快照。
- PreToolUse 的 room-chat 豁免只读取该 query 创建时的 server 和 allowedTools 快照，不能借下轮尚在 CPA 准备中的配置获得豁免。逐轮 readOnly/审批与取消身份仍动态读取当前轮次，既有门禁不删除、不放宽。
- 普通无 extras 会话继续使用同一 warm query；不改变其权限流程。主控已告知本地/远端 `roomAbortSignal` 接线与其 typecheck 通过，本次未审查或修改 RoomService。

### TDD 红绿证据

按 `systematic-debugging` 确认实际 query 生命周期，再按 `test-driven-development` 先补 18 个回归；生产修改只在断言红灯后开始。下列命令工作目录均为 `D:/gitRep/ccDesktop/apps/desktop`。

```text
node node_modules/vitest/vitest.mjs run electron/main/session-manager.test.ts -t 'MCP extras binding'
```

- 00:06:05 红灯：`15 failed | 3 passed | 73 skipped (91)`，exit 1。失败来自实际 query 次数/配置与预期不符，以及旧 query 在准备期间错误豁免；没有用导入或类型错误充当红灯。三个已通过项是等价配置复用（replace/merge）和普通无 extras 对照。
- 00:12:42 绿灯：相同命令 `18 passed | 73 skipped (91)`，exit 0。

新增场景包括：stdio→SDK、SDK A→SDK B（均覆盖 replace/merge），同名 stdio command/args/env 变更、相同绑定复用、保留 model 重开标志、CPA 暂存 server/allowedTools 不授予旧 query 豁免、准备失败重试、syncExtras、调用方原地修改配置，以及普通无 extras 对照。测试检查实际 SessionManager 交给注入 queryFn 的 options 和 hooks，不只测试比较辅助函数。

### 验证与审查结论

```text
node node_modules/vitest/vitest.mjs run electron/main/session-manager.test.ts electron/main/permission-broker.test.ts electron/main/message-stream.test.ts
```

00:13:02：三个文件全部通过，`106 passed (106)`，exit 0。最终局部排版整理后，00:17:20 使用相同命令再次得到 `106 passed (106)`，exit 0。SessionManager 91 项全部运行，包含原有 16 项 readOnly、16 项取消测试和新增 18 项 extras 测试；PermissionBroker 13、MessageStream 2。不重跑整个工作区测试集。

```text
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --pretty false
```

00:13 与上述回归并行执行时 exit 0，无类型诊断。00:17 最后一次执行为 exit 1，出现未由本任务编辑、且明确排除在审查范围外的 `room-service.ts` 两条诊断：

```text
electron/main/room-service.ts(4032,5): error TS2322:
Type 'RoomFilePolicy | "skip"' is not assignable to type 'RoomFilePolicy'.
Type '"skip"' is not assignable to type 'RoomFilePolicy'.

electron/main/room-service.ts(7449,13): error TS7022:
'source' implicitly has type 'any' because it does not have a type annotation
and is referenced directly or indirectly in its own initializer.
```

本次两个代码文件均无类型诊断；不将先前通过描述为整个最终工作区通过。范围外问题只报告给主控，不展开诊断或修复。最终两个代码文件的 `git diff --check` exit 0，仅 Git 的 LF/CRLF 提示。

按 `requesting-code-review` 复核本次 `git diff HEAD` 与 query 创建、复用、替换和清理生命周期：原 MCP 绑定 Important 已修复，授权范围内未发现剩余 Critical/Important。原审批 FIFO 只读审查结论保持不变，本次未重新审查或编辑 Store/UI。测试边界仍为实际 SessionManager 的注入 SDK query 边界；未启动模型/MCP 服务或执行真实危险工具，未验证实机端到端接线。
