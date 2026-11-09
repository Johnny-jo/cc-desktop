# 第二阶段实现总结（Provider 认证与配额）

**分支**：`agentos-provider-auth`（基于 `agentos-foundation`）  
**完成日期**：2026-11-09

## 已完成任务

### 任务 2.1 - 类型定义与 IPC 接口
- `packages/shared/src/provider-types.ts`：`ProviderType`、`ProviderAuthConfig`、`ProviderConfig`、
  `QuotaInfo`、`ProviderModel`、`ProviderStatus`，以及 `OAuthConfigs`、`ProviderEndpoints`、
  `supportsOAuth()`、`providerAuthHeaders()`。
- `packages/shared/src/ipc.ts`：`provider:*` 通道与 `IpcInvokeMap` 类型。

### 任务 2.2 - 主进程管理器
- `provider-manager.ts`：配置 CRUD、原子写盘、凭证文件管理、状态快照。
- `credential-manager.ts`：凭证加密（Electron `safeStorage` / Windows DPAPI）。

### 任务 2.3 - 模型目录与上下文窗口
- `provider-quota-manager.ts`：拉取各 provider 的模型列表，解析上下文窗口，1 小时缓存。

### 任务 2.4 - OAuth 2.0（PKCE，公共客户端）
- `oauth-handler.ts`：授权 URL 生成、环回回调、token 交换、refresh、加密持久化。

### 任务 2.5 - Provider 设置页
- `ProviderSettings.tsx` + `ProviderSettings.module.css`

### 任务 2.6 - 仪表盘
- `ProviderDashboard.tsx` + `ProviderDashboard.module.css`

### 任务 2.7 - Provider 选择器
- `ProviderSelector.tsx` + `ProviderSelector.module.css`

### 任务 2.8 - 集成指南
- `docs/PROVIDER-INTEGRATION.md`

## 支持的 Providers

| Provider | API Key | OAuth | 窗口来源 |
|---|---|---|---|
| Claude | ✓ | — | 内置表 / 用户设置 |
| OpenAI | ✓ | — | 内置表 / 用户设置 |
| DeepSeek | ✓ | — | 内置表 / 用户设置 |
| Kimi | ✓ | — | 内置表 / 用户设置 |
| xAI | ✓ | — | 内置表 / 用户设置 |
| Gemini | ✓ | ✓ | `inputTokenLimit`（`/v1beta/models`） |
| OpenAI 兼容 | ✓ | — | 网关返回 / 用户手输 |

> Claude 与 OpenAI 没有供第三方桌面应用使用的公开 OAuth 授权码端点，因此只支持 API Key。
> OAuth 部分只对登记了真实授权端点的 provider 生效（目前是 Gemini，用户自备 Google OAuth 客户端 ID）。

## 核心 IPC 接口

```
providerListConfigs()
providerAddConfig(config)
providerUpdateConfig(id, config)
providerDeleteConfig(id)
providerTestAuth(id)                      → 拉一次模型列表验证凭证
providerStartOAuth(id)                    → 打开系统浏览器；回调由环回服务器接收
providerCancelOAuth(state)
providerGetStatus(id)
providerSyncQuota(id)                     → 模型目录 + 上下文窗口
providerSetDefaultContextLimit(providerId, limit)
providerUpdated（主进程 → 渲染进程推送）
```

## 与最初设计的三处更正

1. **凭证加密**：不再用 PowerShell 命令串调用 DPAPI，改用 Electron `safeStorage`。
   存储带 `enc:` / `b64:` 前缀，降级为明文 base64 时 UI 可以看见。
2. **OAuth 端点**：删除并没有公开实现的 `api.anthropic.com/oauth/*`、
   `platform.openai.com/oauth/*`；回调地址从 Vite 开发端口改为 `127.0.0.1` 随机端口。
3. **配额语义**：不再虚构 `/billing/usage` 调用和默认窗口值；拿不到窗口就返回
   `undefined` 并标注来源，由 `builtinContextLimit()` 或用户设置补足。
