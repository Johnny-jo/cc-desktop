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

### 5. OAuth 客户端配置

OAuth 客户端 ID 不通过环境变量下发，而是随 provider 配置保存
（`ProviderConfig.oauthClientId`，添加后可在设置里修改）。这样多账号 / 多 provider
不会互相串用同一个 client ID。

桌面应用属于**公共客户端**：走 PKCE，不保存也不发送 `client_secret`。

目前只有登记了真实授权码端点的 provider 支持 OAuth：

| Provider | 授权端点 | 备注 |
|---|---|---|
| Gemini | `accounts.google.com/o/oauth2/v2/auth` | 用户自备 Google Cloud OAuth 客户端 |
| Claude | — | 无公开端点，仅 API Key |
| OpenAI | — | 无公开端点，仅 API Key |

回调由主进程在 `127.0.0.1` 的随机端口上临时监听（RFC 8252），
不占用固定端口，也不需要渲染进程回传授权码。

### 6. 日志和监控

```typescript
console.log(`[Provider] Adding config for ${type} as ${id}`);
console.log(`[Provider] Syncing quota for ${providerId}`);
console.log(`[Provider] Models visible: ${models.length}`);
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

1. **密钥加密**：API Key 与 OAuth token 用 Electron `safeStorage` 加密
   （Windows 上是 DPAPI），再单独写入 `<id>.key` / `<id>.oauth`。
2. **不落明文**：`configs.json` 只存非敏感字段，API Key 写入前就被剥离。
3. **文件名校验**：provider id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，
   防止渲染进程用 `../` 把凭证写到 userData 之外。
4. **OAuth**：PKCE（S256）+ state 校验；不携带 client_secret。
5. **Token 刷新**：过期前 60 秒内自动用 refresh_token 续期，失败则视为未认证。

## 降级行为

系统加密不可用（极少见，例如无密钥环的 Linux 桌面）时：

- 凭证以 `b64:` 前缀存 base64 明文；
- `CredentialManager.encryptionAvailable` 返回 `false`，UI 应提示用户；
- 已存在的 `enc:` 凭证此时**无法解密**，会显式报错要求重新输入，
  而不是把乱码当成密钥去请求上游。

## 测试检查清单

- [ ] 添加 API Key Provider，点「测试认证」应返回可见模型数
- [ ] OAuth Provider 点「OAuth 登录」应打开系统浏览器，完成后状态变为已认证
- [ ] 同步配额，确认窗口来源显示为「上游 /models」「手动设置」或「内置表」
- [ ] 手设 context limit，验证保存并在同步后仍生效
- [ ] 删除 Provider，确认 `<id>.key` / `<id>.oauth` 被清除
- [ ] 重启应用，验证配置与凭证持久化
- [ ] 检查 Provider 选择器是否在 Composer 中正常工作
