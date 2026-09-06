# 群聊结构化提及与任务面板 UI 报告

日期：2026-09-05。工作区：`D:/gitRep/ccDesktop`。依据：`docs/superpowers/specs/2026-09-05-room-task-controls-design.md`。

## 实现

- 候选选择、头像和“提及”菜单创建 `RoomMention { seatId, start, end }`，`end` 不含尾部普通空格。输入草稿同时保存正文与记录，使用 beforeinput 的真实编辑区间调整偏移；覆盖名称或尾空格使原记录失效。同文粘贴也清除覆盖记录。手打、粘贴及引用内容不会自行获得记录，引用菜单仅设置引用。
- 候选以光标前的文本匹配，选中时保留光标后的正文及其他标记。发送前使用共享 `validateRoomMentions` 校验，发送原始正文，不 trim。重复 Agent 目标去重；重复位置由共享校验处理。
- 普通消息始终从本人 human 席位发送，Store 层也不允许用传入 Agent 或历史选中 Agent 冒充发送者；缺少本人席位则拒绝发送。默认席位不回退到 Agent。
- `/stop` 优先有效 Agent 提及，否则使用已选 Agent。human 提及不遮蔽 stop 目标，点击 human 头像也保留既有 Agent 选择。停止的最终任务权限仍由后台校验。
- 消息作者头像与提及菜单按实际 human `authorUserId` 找席位；assistant 使用其 Agent 席位。高亮、本人高亮和桌面通知使用 metadata，普通字符串不解析为提及。assistant 工具产生的 `authorUserId=null` 提及可以通知；普通 assistant 输出不额外刷提醒。通知仍保留焦点、免打扰、撤回和消息游标去重规则。
- 任务面板放在席位栏下方，局部 CSS，显示当前任务与最近 10 个终态任务、8 种状态、原始发起人、读写模式、后台父任务 ID、审批说明和错误。父子、根任务归属均来自后台，没有在 UI 推断或创建。
- 仅当前原发起人可以操作 `awaiting-approval` 且包含 `approvalKind`/`approvalRequestId` 的审批，逐条提交 `taskId + requestId + allow`。发起人或当前成员角色为 host/admin 时显示停止；终态和 stopping 不显示操作，断连/结束/请求进行中禁用操作。
- 个人转交策略来自当前成员 `delegationPolicy`，缺省 ask，支持 ask/read-only/auto，仅提交个人 policy。停止成功不在本地直接改为 cancelled，状态等待后台快照更新。

## 文件与红绿结果

下列源文件路径均相对 `apps/desktop/`。已有文件上的并发前置改动予以保留。

| 实现文件 | 行为测试 | 红灯证据 | 最终绿灯 |
| --- | --- | --- | --- |
| `src/lib/room-compose.ts` | `src/lib/room-compose.test.ts` | 4 项失败：历史 Agent 发送者回退、human 遮蔽 stop、文本扫描误识别、缺少本人席位仍回退 | 6/6 |
| `src/lib/room-mention-draft.ts`（新增） | `src/lib/room-mention-draft.test.ts`（新增） | 测试先创建并运行，初次因待实现模块不存在而失败 | 11/11：显式插入、UTF-16 偏移、正文前后编辑、尾空格、同文替换、失效不复活、候选替换、beforeinput |
| `src/lib/room-notify.ts` | `src/lib/room-notify.test.ts` | 4 项失败：metadata 提及、免打扰提及、普通 assistant 刷通知、空作者工具提及被过滤 | 13/13 |
| `src/state/room-store.ts` | `src/state/room-store.test.ts`（新增） | 首轮 5 项失败：发送身份/参数、任务控制入口、快照通知接线；后补缺少 human 时隐式选 Agent 的用例先失败再修复 | 6/6 |
| `src/components/RoomTimeline.tsx` | `src/components/RoomTimeline.test.ts` | 4 项失败：扫描额外字符串、assistant metadata 高亮、实际作者解析、左键回调 | 18/18，包含原有气泡、Markdown、流式行、引用、撤回和 80 行上限回归 |
| `src/components/RoomTaskPanel.tsx`、`src/components/RoomTaskPanel.css`（新增） | `src/components/RoomTaskPanel.test.ts`（新增） | 测试先创建并运行，修正测试语法后因待实现组件不存在而失败 | 8/8：渲染状态/归属、逐条 requestId、角色限制、终态/断连、个人策略 |
| `src/components/RoomStage.tsx` | `src/components/RoomStage.test.ts`（新增） | 修正测试 fixture 后 3 项失败：缺少 metadata 参数、trim 破坏尾空格、没有同文粘贴处理；后续 human 头像遮蔽 stop 与引用自动创建提及分别红灯后修复 | 8/8，执行真实组件事件处理器 |

测试是纯逻辑、真实 Store（只隔离主 Store/IPC 等边界）、React 实际渲染与组件事件回调；没有使用静态源码字符串断言作为行为验证。RoomStage 在 Node 环境使用小型 hook runner，未挂载浏览器 DOM。

## 最终验证

在 `apps/desktop` 执行（本机 `pnpm exec vitest` 的 bin shim 不可用，改为直接调用已安装的 CLI）：

```powershell
node node_modules/vitest/vitest.mjs run src/lib/room-compose.test.ts src/lib/room-mention-draft.test.ts src/lib/room-notify.test.ts src/state/room-store.test.ts src/components/RoomStage.test.ts src/components/RoomTimeline.test.ts src/components/RoomTaskPanel.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

- 22:05:56（Asia/Shanghai）相关 Vitest：**7 个文件、70 项全部通过**，退出码 0。
- 22:05:56 启动的最终 typecheck：**退出码 1，仅范围外错误**：`electron/main/room-service.ts(4786,12): TS2339: Property 'rememberNodeTurn' does not exist on type 'RoomService'.` 未修改该文件。
- typecheck 并发记录：21:59 首轮曾出现主控 `room-chat-agent` 缺失、`input` 隐式 any、调用参数数量问题；本次测试自身的 memo 类型错误已修正。22:01:43 的完整 typecheck 曾退出 0；上述最终并发错误取代此前通过结果，不能据此前一轮声称最终全量类型检查通过。
- 正常仓库配置下，限定已跟踪目标文件的 `git diff --check` 退出 0，仅提示已有 LF/CRLF 转换警告。一次临时关闭 autocrlf 的检查把 CRLF 误报为尾空白，已恢复使用仓库配置检查，没有为此重写文件换行。

## 范围与待主控验证

本次只编辑上表实现/测试文件及本报告。未修改 `src/state/store.ts`、shared、preload、main、全局 `styles.css`、已有 `RoomTimeline.css` 或 Mod 自主权设置。未提交、推送、部署，也未启动或操作真实群聊任务。

没有进行 Electron 实机 DOM/输入法、真实系统通知、局域网/中继和跨窗口审批联调；这些不由 Node 行为测试证明。后台授权、任务派生和远端停止确认由主控实现及集成验证。

## 2026-09-06 审查修复追加（TDD）

按本轮授权修复选区替换、同文替换和 Markdown 实体/转义提及高亮。实际仅改动 `src/components/RoomStage.tsx`、`RoomStage.test.ts`、`RoomTimeline.tsx`、`RoomTimeline.test.ts` 及本报告；没有改动 `room-mention-draft.ts` 或其测试，也没有新增依赖。

- 候选点击、Tab、Enter 均使用输入框的 `selectionEnd` 替换完整选区，保留选区后的正文，光标落在新提及的尾空格之后。
- 草稿编辑只在 `onInput` 消费 beforeinput 保存的替换区间，不再依赖 React 的 `onChange` 同值事件门禁。相同尾空格、相同中文字符和整段同文替换均使被覆盖的记录失效；尾空格删除后重输不恢复记录。
- Markdown 高亮先用现有解析器解码文本节点中的实体和反斜杠转义，再把 metadata 的原文 UTF-16 偏移映射到解码后的文本位置。仍只标注有有效记录的位置，同名普通正文不会被额外标注；未知实体保持原样。

### 红绿证据

时间均为 Asia/Shanghai。输入修复发生在 09-05，Markdown 修复及最终回归跨至 09-06。

| 修复 | 修改实现前的红灯 | 修改实现后的绿灯 |
| --- | --- | --- |
| 候选替换选区 | 23:45:10，定向运行 `RoomStage.test.ts -t 'replaces the selected candidate suffix'`，3 项失败；实际发送 `@开发 X后文`，期望 `@开发 后文` | 23:45:38，RoomStage 11/11 |
| 同文替换 input 路径 | 23:47:52，RoomStage 3 项失败、15 项通过；同文编辑没有触发 change，发送仍携带旧记录 | 23:48:26，RoomStage 18/18、room-mention-draft 11/11，共 29/29 |
| Markdown 实体/转义高亮 | 00:05:27，定向运行 `RoomTimeline.test.ts -t 'entities\|recorded occurrence'`，新增 7 项全部失败，缺少提及高亮 | 00:07:04，RoomTimeline 25/25 |

RoomStage 的事件测试现在总是分派 `onInput`，只在模拟 DOM 值变化时分派 `onChange`；同文用例不调用 `onChange`，避免掩盖原缺陷。同时覆盖 IME Enter 不选候选/不发送、未选择的中文输入不产生记录、已选提及后方的中文组合输入、引用、同文粘贴和尾空格规则。Markdown 新用例覆盖命名/数字实体、代理对与多码点实体、转义、未知实体和重复同名位置。

### 本轮最终验证与限制

- 00:08:09，复用上文列出的 7 文件 UI 测试命令，**87/87 通过，退出码 0**：RoomStage 18、RoomTimeline 25、RoomTaskPanel 8、room-compose 6、room-mention-draft 11、room-notify 13、room-store 6。
- 同轮 `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` **退出码 0**。这是本轮最新验证结果；前轮并发类型错误记录保留供追溯。
- 限定本轮已跟踪源码/测试的 `git diff --check HEAD -- ...` 退出码 0，仅有仓库既有 LF/CRLF 转换提示。
- 全局 `styles.css`、`src/state/room-store.ts` 和 `RoomTaskPanel.tsx` 的 SHA-256 与本轮修复前一致。未编辑其他样式、权限 store 或后台文件；未提交、推送、部署。
- 没有可用浏览器连接。RoomStage 仍为 Node hook runner，`useEffect` 未挂载；本轮验证的是组件 input 事件路径模型，不证明原生 beforeinput 监听、真实 DOM 事件顺序或真实中文输入法完全可靠。Markdown 使用实际 React 静态渲染验证。Electron 实机输入、真实审批点击、跨窗口/网络行为继续由主控最终集成验证。
