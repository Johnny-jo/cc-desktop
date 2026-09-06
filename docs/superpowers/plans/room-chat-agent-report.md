# room-chat Agent MCP 实现报告

日期：2026-09-05。工作区：`D:/gitRep/ccDesktop`。

## 文件与接口

本次仅新增以下三个文件，未安装依赖，未提交或推送：

| 文件 | 内容 |
| --- | --- |
| `apps/desktop/electron/main/room-chat-agent.ts` | `RoomAgentMessage`、`createRoomChatMcp(handlers): SessionRunOpts`、SDK 加载、schema、MCP 工具注册与错误处理 |
| `apps/desktop/electron/main/room-chat-agent.test.ts` | 55 项测试，其中 52 项走真实 SDK server／内存 MCP client，3 项模拟依赖加载失败 |
| `docs/superpowers/plans/room-chat-agent-report.md` | 本报告 |

实现使用 mcp-builder 与 test-driven-development 技能。沿用 `room-mod-agent.ts` 的 `createRequire` 以及从 Agent SDK 路径加载 Zod 的模式。`room-service` 及其余协作中的文件未由本次修改。

- MCP server 名称为 `room-chat`，版本 `1.0.0`，工具保持 alwaysLoad。
- `extraAllowedTools` 精确包含 `mcp__room-chat__room_members`、`mcp__room-chat__room_message`。
- `room_members` 不接受参数，逐次调用绑定的 handler，JSON 原样返回当前成员数据；支持同步及异步 handler。
- `room_message` 要求 `requestId`、`mode`、`targetSeatId`、`text`。`mode` 仅支持 `notify`、`delegate`；`readOnly` 可省略，实际交给 handler 时默认为 `false`。
- ID 和 requestId 均限制 1–128，文本限制 1–8000；拒绝空白值、类型错误、超长值及所有未知字段。长度按 JavaScript/Zod 字符串长度计量，不截断或 trim。
- `roomId`、`sourceSeatId`、`initiatorUserId` 等字段在调用 handler 前被拒绝。文本中的 `@` 和 JSON 代码块保持原文，不解析为额外调用。
- 成功返回单条 JSON text；业务拒绝设置 `isError: true` 并保留 handler 的结果。参数错误、异常、无法 JSON 序列化的结果返回 `{ok:false,error}` 和 `isError: true`。
- SDK、Zod 或 MCP 依赖加载失败会抛出带 `room-chat` 上下文和原始 cause 的初始化错误，不返回空配置或声称发送成功。

## 真实 SDK 兼容处理

本地验证环境：Node `24.18.1`、Agent SDK `0.3.220`、MCP SDK `1.30.0`、Zod `4.4.3`、Vitest `3.2.7`。

真实 SDK 测试发现两个兼容问题：

1. 默认 raw-shape 校验会去掉未知参数，默认工具校验错误是纯文本。这无法保证来源字段明确拒绝以及错误 JSON 格式。
2. SDK 内置 JSON Schema 转换会丢失当前 Zod schema 的 `minLength`、`maxLength`、pattern 和字段 description；空参数 schema 也没有声明 `additionalProperties: false`。

实现仍通过 SDK 的 `tool`／`createSdkMcpServer` 注册工具，再用公开的 `instance.server.setRequestHandler` 设置 `tools/call`、`tools/list`：前者校验原始参数并统一 JSON 错误，后者使用实际加载的 Zod `toJSONSchema(..., {io: "input"})` 发布同一份严格 schema。MCP 请求 schema 也通过 `createRequire` 从 Agent SDK 依赖路径加载。未修改 SDK 私有字段或安装依赖。

## 红灯与绿灯

命令运行目录为 `apps/desktop`。

```powershell
node node_modules/vitest/vitest.mjs run electron/main/room-chat-agent.test.ts --reporter=dot
```

| 阶段 | 实际结果 |
| --- | --- |
| 先写测试，尚无实现文件 | suite 无法导入 `./room-chat-agent`；此时不算行为红灯 |
| 加入仅返回 `{}` 的接口骨架 | 55 failed：缺少 SDK server，以及依赖缺失时没有抛错，确认行为红灯 |
| 实现工具及严格输入校验 | 54 passed / 1 failed：工具列表没有完整严格 schema |
| 尝试让 SDK 注册完整 strict object schema | 54 passed / 1 failed：SDK 仍丢失字符串长度限制，真实测试捕获兼容问题 |
| 使用同版本 Zod 生成工具列表 schema | 55 passed / 0 failed |
| 扩大回归时再次运行该文件 | 55 passed / 0 failed |

覆盖成员列表更新、两种模式 × readOnly 默认/true/false、长度边界、原文保留、重试键透传、缺字段/空白/错误类型/超长/额外来源字段、业务拒绝、同步/异步异常、非 Error 异常、序列化失败、未知工具和依赖缺失。

## 类型检查及相关回归

定向 TypeScript 检查通过（0 diagnostics）：以这两个文件为入口，读取现有 tsconfig，并加入 `electron` 的真实环境类型声明以保留 `process.resourcesPath` 等定义，不修改配置文件。

```powershell
node -e "const ts=require('typescript'); const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile); const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd()); const roots=['electron/main/room-chat-agent.ts','electron/main/room-chat-agent.test.ts']; const program=ts.createProgram(roots,{...parsed.options,noEmit:true,types:[...parsed.options.types,'electron']}); const diagnostics=ts.getPreEmitDiagnostics(program); console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:ts.sys.getCurrentDirectory,getCanonicalFileName:p=>p,getNewLine:()=>String.fromCharCode(10)})); console.log('Scoped room-chat TypeScript diagnostics:',diagnostics.length); process.exitCode=diagnostics.length?1:0;"
```

完整 desktop 类型检查：`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`。检查时唯一错误为 `room-service.ts(4786,12): TS2339 Property 'rememberNodeTurn' does not exist on type 'RoomService'`，属于主控仍在集成的文件；未修改。

相关回归命令：

```powershell
node node_modules/vitest/vitest.mjs run electron/main/room-chat-agent.test.ts electron/main/session-extras.test.ts electron/main/room-mod.test.ts --reporter=dot
```

结果：2 个文件通过、1 个文件失败；83 passed / 14 failed，总耗时约 73 秒。`room-chat-agent.test.ts` 和 `session-extras.test.ts` 通过。14 项失败全部位于 `room-mod.test.ts`，为握手、参与状态、bundle、玩法视图等 WebSocket 场景的 5000ms 超时。此次未确定这些超时的根因，不声称全量集成回归通过。

本地 `pnpm --filter @claude-desktop/desktop exec vitest ...` 返回找不到 `vitest` 命令，因此直接执行已安装的 Vitest JS 入口，无需安装或修改依赖。

## 限制与主控集成边界

- 身份、授权、成员数据可见范围、目标类型、来源任务有效性和 requestId 幂等去重由绑定的 handlers 负责。此模块不缓存业务结果；同一 requestId 的重试会原样传入 handler，避免在不同任务间混用结果。
- 不校验 handler 提供的成员记录形状，也不执行真实消息落库或调度；这些由 `room-service` 集成。
- 工具参数的业务校验失败使用 JSON text + isError；非法 JSON-RPC/MCP 请求封包仍由 MCP 协议层处理。
- 已验证真实 SDK server、真实内存 transport 和 client；未调用付费模型，未进行打包后的 Electron／跨设备端到端验证。
- schema 列表生成需要本地 Zod 4 的 `toJSONSchema`，缺失时显式初始化失败。SDK 升级后应重跑本测试，尤其是公开请求处理接口和 schema 发布检查。
