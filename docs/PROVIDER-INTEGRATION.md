/**
 * Provider 集成指南
 * 如何将 Provider 管理功能集成到 CC Desktop 主进程
 */

## 集成步骤

### 1. 主进程初始化（apps/desktop/electron/main/index.ts）

```typescript
import { ProviderManager } from "./provider-manager";
import { QuotaManager } from "./provider-quota-manager";
import { OAuthHandler } from "./oauth-handler";
import { registerProviderHandlers } from "./provider-ipc-handlers";

// 在 createWindow 或初始化时添加：
const providerManager = new ProviderManager({
  userDataDir: app.getPath("userData"),
});

const quotaManager = new QuotaManager();
const oauthHandler = new OAuthHandler(providerManager);

// 注册 IPC 处理器
registerProviderHandlers(ipcMain, providerManager, quotaManager, oauthHandler);

// 启动后台配额同步
startQuotaSyncLoop(providerManager, quotaManager);
```

### 2. 后台配额同步

```typescript
function startQuotaSyncLoop(
  providerManager: ProviderManager,
  quotaManager: QuotaManager,
) {
  // 定期同步（1 小时一次）
  setInterval(async () => {
    const configs = providerManager.listConfigs();
    for (const config of configs) {
      if (!config.enabled) continue;

      const encrypted = providerManager.loadApiKey(config.id);
      if (!encrypted) continue;

      try {
        const apiKey = CredentialManager.decrypt(encrypted);
        const result = await quotaManager.syncQuota(config, apiKey);
        
        if (result.quota) {
          // 检查 80% 告警
          const ratio = result.quota.usedQuota
            ? result.quota.usedQuota / result.quota.limitTokens!
            : 0;
          if (ratio >= 0.8) {
            // 发送通知或广播事件
            mainWindow?.webContents.send("provider:quota-warning", {
              providerId: config.id,
              usage: ratio,
            });
          }
        }
      } catch (err) {
        console.warn(`Quota sync failed for ${config.id}:`, err);
      }
    }
  }, 3600000); // 1 小时
}
```

### 3. 会话中使用 Provider

在会话启动时，允许从 Provider 中选择认证：

```typescript
// 在 SessionManager.start() 中
const sessionConfig = {
  model: session.model || settings.defaultModel,
  provider: session.providerId, // 使用指定的 Provider
  // ... 其他配置
};
```

### 4. React 集成

#### 4.1 在设置页中添加 Provider 管理标签

```typescript
// apps/desktop/src/components/SettingsDrawer.tsx

import { ProviderSettings } from "./ProviderSettings";
import { ProviderDashboard } from "./ProviderDashboard";

<Tabs>
  <TabPanel label="Provider 管理">
    <ProviderSettings />
  </TabPanel>
  <TabPanel label="配额仪表盘">
    <ProviderDashboard />
  </TabPanel>
  {/* 其他标签 */}
</Tabs>
```

#### 4.2 在 Composer 中集成 Provider 选择器

```typescript
// apps/desktop/src/components/Composer.tsx

import { ProviderSelector } from "./ProviderSelector";

<div className={styles.composerBar}>
  <ProviderSelector
    currentProviderId={selectedProviderId}
    onProviderSelected={(id) => setSelectedProviderId(id)}
  />
  {/* 其他控件 */}
</div>
```

### 5. 环境变量配置

在 `.env` 或系统环境中设置 OAuth 客户端信息：

```bash
# Claude OAuth
PROVIDER_OAUTH_CLAUDE_CLIENT_ID=your-client-id
PROVIDER_OAUTH_CLAUDE_CLIENT_SECRET=your-secret

# OpenAI OAuth
PROVIDER_OAUTH_OPENAI_CLIENT_ID=your-client-id
PROVIDER_OAUTH_OPENAI_CLIENT_SECRET=your-secret

# Gemini OAuth
PROVIDER_OAUTH_GEMINI_CLIENT_ID=your-client-id
PROVIDER_OAUTH_GEMINI_CLIENT_SECRET=your-secret
```

### 6. 日志和监控

在 IPC 处理器中添加日志：

```typescript
console.log(`[Provider] Adding config for ${type} as ${id}`);
console.log(`[Provider] Syncing quota for ${providerId}`);
console.log(`[Provider] Usage: ${usedQuota}/${limitTokens} (${usagePercent}%)`);
```

## 数据流

```
User → ProviderSettings UI
         ↓
      addConfig IPC
         ↓
   ProviderManager (save)
   CredentialManager (encrypt)
         ↓
   ~/.cc-desktop/providers/configs.json
   ~/.cc-desktop/providers/<id>.key
         ↓
      Backend Ready
         ↓
   Quota Sync Loop → QuotaManager → Provider API
         ↓
      ProviderStatus Event
         ↓
   Dashboard / Selector UI
```

## 安全考虑

1. **密钥加密**：所有 API Key 和 OAuth token 都使用 DPAPI（Windows）加密存储
2. **文件权限**：确保 `~/.cc-desktop/providers/` 只有当前用户可读写
3. **内存清理**：解密后的密钥不应长期保存在内存中
4. **OAuth**：使用 PKCE 防止授权码拦截
5. **Token 刷新**：定期验证 token 有效性，过期时自动刷新

## 故障恢复

如果密钥加密失败：

```typescript
// 降级到 base64 编码（提示用户风险）
console.warn("Failed to use DPAPI, using base64 fallback");
```

## 测试检查清单

- [ ] 添加 API Key Provider，测试认证
- [ ] 添加 OAuth Provider，测试授权流程
- [ ] 同步配额，检查是否正确解析 context_window
- [ ] 手设置 context limit，验证保存和应用
- [ ] 删除 Provider，确认密钥被清除
- [ ] 配额达到 80% 时，检查告警是否显示
- [ ] 重启应用，验证配置持久化
- [ ] 检查 Provider 选择器是否在 Composer 中正常工作
