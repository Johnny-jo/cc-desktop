# 第二阶段任务规划与进度

**分支**：`agentos-provider-auth`（基于 `agentos-foundation`）  
**目标**：实现替代 CLI proxy API 的 Provider 管理功能

## 已完成任务

### ✅ 任务 2.1：Provider 类型定义与共享模块
- `packages/shared/src/provider-types.ts`：定义 ProviderType、ProviderConfig、QuotaInfo、ProviderStatus
- 支持的 Provider：Claude、OpenAI、DeepSeek、Kimi、xAI、Gemini、OpenAI 兼容协议
- 认证方式：API Key + OAuth 2.0（部分支持）
- IPC 接口定义：list/add/update/delete configs、OAuth 流程、quota sync

### ✅ 任务 2.2：Electron main - Provider 管理
- `provider-manager.ts`：配置持久化、生命周期管理
  - 文件存储在 `~/.cc-desktop/providers/`
  - 支持 CRUD 操作
- `credential-manager.ts`：密钥加密
  - Windows：DPAPI 加密
  - macOS/Linux：Keychain 集成（预留）
- `provider-ipc-handlers.ts`：IPC 处理逻辑
  - 认证测试（调用 `/v1/models` 端点）
  - OAuth 流程初始化
  - 密钥自动加密/解密

## 待完成任务

### ⏳ 任务 2.3：Quota 管理与同步
**文件**：`provider-quota-manager.ts`
**内容**：
- [ ] 对接各 Provider 的 `/v1/models` API，解析 context_window
- [ ] 实现 CPA-style 配额查询（Codex、Claude、Kimi 等专有接口）
- [ ] 支持用户手输限额（OpenAI 兼容协议必需）
- [ ] 后台定时更新配额（1 小时一次）
- [ ] 配额过期/额度不足告警

### ⏳ 任务 2.4：OAuth 完整流程
**文件**：`oauth-handler.ts`
**内容**：
- [ ] 本地回调端口 5173 (Claude Code 开发服务器)
- [ ] 支持 PKCE (Proof Key for Code Exchange)
- [ ] Token 刷新与过期处理
- [ ] 安全存储 refresh token

### ⏳ 任务 2.5：渲染进程 UI - Provider 设置页
**文件**：`apps/desktop/src/components/ProviderSettings.tsx`
**内容**：
- [ ] Provider 列表卡片（启用/禁用、编辑、删除）
- [ ] 添加 Provider 对话框（选择类型 → 填表单 → 认证）
- [ ] API Key 输入框 + 测试按钮
- [ ] OAuth 跳转 + 回调处理
- [ ] 配额显示与手动刷新
- [ ] 默认 context limit 设置

### ⏳ 任务 2.6：仪表盘 - 配额与消费汇总
**文件**：`apps/desktop/src/components/ProviderDashboard.tsx`
**内容**：
- [ ] 多 Provider 配额总览
- [ ] 消费趋势图表（7 天、30 天）
- [ ] 成本估算（基于模型定价）
- [ ] 告警设置（≥80% 时提醒）

### ⏳ 任务 2.7：会话中的 Provider 选择
**修改**：`Composer.tsx`、`MessageList.tsx`
**内容**：
- [ ] 模型选择器集成 Provider 概念
- [ ] 同时展示 Provider + Model + Reasoning Level
- [ ] 切换时自动验证凭证
- [ ] 显示该 Provider 的当前配额

### ⏳ 任务 2.8：集成到主进程启动流程
**修改**：`apps/desktop/electron/main/index.ts`
**内容**：
- [ ] 启动时初始化 ProviderManager
- [ ] 注册 IPC 处理器
- [ ] 启动后台 quota 同步任务
- [ ] 处理加密 key 的错误恢复

## 架构决策

| 决策 | 说明 |
|---|---|
| **密钥存储** | 文件 `~/.cc-desktop/providers/<id>.key`（加密） |
| **配额更新** | 后台每小时一次，用户可手动刷新 |
| **认证方式** | 优先 API Key（简单），OAuth 作为辅助 |
| **OpenAI 兼容** | 仅支持 API Key + 用户手输限额 |
| **会话绑定** | 会话可覆盖全局 Provider，但共用同一个凭证库 |

## 下一步行动

1. **完成 Quota Manager** → 实现各 Provider 的 API 调用
2. **集成到 IPC handlers** → 导出 quota 接口
3. **React UI** → Provider 设置页 + 仪表盘
4. **测试** → 本地 CPA + 真实 OpenAI/DeepSeek 账号验证
5. **文档** → 用户指南：如何添加 Provider、配置 OAuth

## 分支状态

```
agentos-provider-auth
├── 2.1 ✅ Provider types + IPC
├── 2.2 ✅ Manager + Credential
├── 2.3 ⏳ Quota Sync
├── 2.4 ⏳ OAuth Handler
└── 2.5-2.8 ⏳ UI + Integration
```

推送到远端：`git push origin agentos-provider-auth`
