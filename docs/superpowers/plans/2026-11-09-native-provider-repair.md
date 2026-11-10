# 自有 Provider 运行时修复计划

**目标：** 修复 Provider 表单，并以自有账号、OAuth、API 协议适配和模型路由取代聊天对 CPA 的依赖。

**架构：** ProviderManager 保存元数据、CredentialManager 加密凭证、OAuthHandler 处理各上游真实授权与刷新。ProviderRuntime 监听受随机令牌保护的本机环回端口，接收 Claude Agent SDK Messages 请求；provider-protocol 负责各上游请求与流式响应转换。聊天、群聊共享和模型目录调用相同运行时。保留原 CPA 文件和历史设置以便兼容读取，但新运行时不调用或启动 CPA。

**技术栈：** TypeScript、Electron、React、Node HTTP/fetch/ReadableStream、Vitest。

- [x] 表单：整数上下文、兼容网关密钥与 URL、Claude/OpenAI/Google 原生 OAuth、Google Client ID、授权等待/取消/手动回调与可重试错误。
- [x] OAuth：核对第一方实现，测试 PKCE/state、交换/刷新参数、固定回调、取消竞态与加密存取，不真实登录账号。
- [x] 协议：Messages 到 Chat Completions/Responses/Gemini 转换，工具与图片、分片 SSE、usage、abort 与上游错误测试。
- [x] 运行时：按 Provider/model 路由、凭据隔离、模型目录和状态，提供 SDK 环境、环回鉴权和生命周期测试。
- [x] 集成：Provider IPC 管理与聊天运行时连通，移除 CPA 启动依赖；设置和首次启动引导进入 Provider 管理。
- [x] 验证：新旧相关测试、desktop/shared TypeScript、Electron 构建及独立代码审查；实际账号登录由用户完成，不把单测称作真实授权验收。

测试使用可用的 Codex runtime Node，运行 `apps/desktop/node_modules/vitest/vitest.mjs run --root apps/desktop` 并指定相关测试。文件重命名/环回连接遭沙盒限制时，使用受审查的提权验证命令。已有未跟踪 `docs/1.txt` 不属于本次修改。

## 验证结果

- 最终在 `apps/desktop` 工作目录运行全量 Vitest，排除下述已单独复现的 Windows 管道测试：141 个测试文件、2120 项测试通过。
- shared：19 个测试文件、261 项测试通过。
- desktop/shared TypeScript、OCR 模型完整性检查、Electron 主进程/preload/renderer 构建通过。
- 真实捆绑 CLI + SDK 0.3.318 使用隔离配置和本机假上游：空工具与默认工具两种真实请求均返回 `OK`，没有调用真实上游或用户账号。
- `windows-computer-scoped-broker.test.ts` 在全量及单独复跑时均出现 `IOException: 管道已中断`。该测试及其 C# 实现未改动，保留此失败记录，没有通过修改断言掩盖。
- OAuth/UI/协议与运行时经过独立审查；补齐实际 SDK 的 system 消息、默认上下文策略和 beta 请求头，修复启动/删除授权竞态、环境路由污染和目录同步选择竞态。

真实账号授权与推理尚未验证。Google 需要用户自有客户端和 Cloud 项目；OpenAI/Claude 当前使用第一方原生客户端兼容身份。非 Claude 协议的文档块和部分服务端工具仍明确报不支持；没有把这些能力冒充为完整 CPA 功能对等。未生成或安装新的发布安装包。
