# Provider 表单交互与 Base URL 修复计划

**目标：** 删除后立即添加 Provider 时可以正常选择和输入；API Key Provider 可填写自定义 Base URL，模型同步和生成请求使用同一地址。

**设计：** 删除改为卡片内确认，保留取消和删除中的禁用状态，去掉同步系统确认框。添加表单保持独立状态，后台删除、状态刷新不会锁定新表单。API Key 认证显示 Base URL，官方类型留空走原有默认地址，兼容类型必填；OAuth 使用原有账号后端，不提交自定义地址。

**实现边界：** 在 shared 中集中校验和拼接 API URL，保留自定义路径和版本前缀，避免模型同步与生成请求采用不同规则。主进程在 IPC 和请求出口同时验证地址。既有 API Key 加密存储和 OAuth 流程保持原有行为。

- [x] 添加删除确认、删除后立即编辑表单、自定义 Base URL 的失败回归测试。
- [x] 实现卡片内删除确认，取消操作不访问后端；删除失败仍可重试。
- [x] 补齐 shared 配置类型、URL 解析和测试；官方地址、版本前缀、自定义路径、无效地址、OAuth 防回传均覆盖。
- [x] 添加 API Key 表单字段和主进程校验，生成与模型发现统一使用地址解析器。
- [x] 执行相关测试、真实浏览器删除后立即添加流程、类型检查和构建；进行只读代码审查。

**验证：** desktop Vitest 的 ProviderSettings、provider-protocol、provider-quota-manager、provider-ipc-handlers、provider-runtime 与相关 OAuth 测试；shared URL 单元测试。隔离浏览器中反复删除并立即添加，验证类型、名称、API Key、Base URL、上下文均能编辑和提交；不使用真实账号或凭证。

**结果：** 最终 desktop 相关 162 项和 shared URL 26 项通过，两个包类型检查与桌面构建通过。隐藏且隔离的真实 Electron 窗口中，7 种类型删除尚未完成时即可选择和输入，随后正确提交；取消删除不访问后端，没有调用原生 confirm。真实 SDK 的本地思考与工具续轮回归仍返回两轮成功。只读审查发现的根路径完整端点兼容问题已修复，并额外保留名称恰为 models/messages/responses 的自定义 API 前缀。
