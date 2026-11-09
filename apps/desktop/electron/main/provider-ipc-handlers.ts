/**
 * Provider IPC 处理器（集成到 ipc-handlers.ts）
 */

import { IPC } from "@claude-desktop/shared";
import type { ProviderConfig } from "@claude-desktop/shared";
import { ProviderManager } from "./provider-manager";
import { CredentialManager } from "./credential-manager";
import { QuotaManager } from "./provider-quota-manager";
import { OAuthHandler } from "./oauth-handler";

export function registerProviderHandlers(
  ipcMain: any,
  providerManager: ProviderManager,
  quotaManager: QuotaManager,
  oauthHandler: OAuthHandler,
) {
  // 列出所有 Provider 配置
  ipcMain.handle(IPC.providerListConfigs, async () => {
    return providerManager.listConfigs();
  });

  // 添加新 Provider
  ipcMain.handle(IPC.providerAddConfig, async (_e: any, { config }: { config: ProviderConfig }) => {
    try {
      const finalConfig = { ...config };
      if (config.auth.apiKey) {
        const encrypted = CredentialManager.encrypt(config.auth.apiKey);
        providerManager.saveApiKey(config.id, encrypted);
        finalConfig.auth.apiKey = undefined;
      }
      const id = providerManager.addConfig(finalConfig);
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // 更新 Provider
  ipcMain.handle(IPC.providerUpdateConfig, async (_e: any, { id, config }: { id: string; config: Partial<ProviderConfig> }) => {
    try {
      if (config.auth?.apiKey) {
        const encrypted = CredentialManager.encrypt(config.auth.apiKey);
        providerManager.saveApiKey(id, encrypted);
        if (config.auth) {
          config.auth.apiKey = undefined;
        }
      }
      const success = providerManager.updateConfig(id, config);
      return { ok: success };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // 删除 Provider
  ipcMain.handle(IPC.providerDeleteConfig, async (_e: any, { id }: { id: string }) => {
    try {
      providerManager.deleteApiKey(id);
      oauthHandler.deleteOAuthToken(id);
      providerManager.deleteConfig(id);
      quotaManager.invalidateCache(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // 获取 Provider 状态
  ipcMain.handle(IPC.providerGetStatus, async (_e: any, { id }: { id: string }) => {
    const status = providerManager.getStatus(id);
    return status;
  });

  // 同步配额
  ipcMain.handle(IPC.providerSyncQuota, async (_e: any, { id }: { id: string }) => {
    try {
      const config = providerManager.getConfig(id);
      if (!config) {
        return { ok: false, error: "Provider not found" };
      }

      // 读取加密的 API Key 或 OAuth token
      let apiKey: string | undefined;
      const encrypted = providerManager.loadApiKey(id);
      if (encrypted) {
        apiKey = CredentialManager.decrypt(encrypted);
      }

      // 如果没有 API Key，尝试使用 OAuth token
      if (!apiKey) {
        const oauthToken = oauthHandler.loadOAuthToken(id);
        if (oauthToken?.access_token) {
          apiKey = oauthToken.access_token;
        }
      }

      const result = await quotaManager.syncQuota(config, apiKey);
      if (result.error) {
        return { ok: false, error: result.error };
      }
      return { ok: true, quota: result.quota };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // 测试认证
  ipcMain.handle(IPC.providerTestAuth, async (_e: any, { id }: { id: string }) => {
    try {
      const config = providerManager.getConfig(id);
      if (!config) {
        return { ok: false, message: "Provider not found" };
      }

      let apiKey = config.auth.apiKey;
      if (!apiKey) {
        const encrypted = providerManager.loadApiKey(id);
        if (encrypted) {
          apiKey = CredentialManager.decrypt(encrypted);
        }
      }

      if (!apiKey) {
        return { ok: false, message: "No API key configured" };
      }

      const endpoint = providerManager.getEndpoint(config.type);
      if (!endpoint) {
        return { ok: false, message: "Unsupported provider type" };
      }

      const response = await fetch(`${endpoint.baseUrl}${endpoint.modelsEndpoint}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (response.ok) {
        return { ok: true, message: "Authentication successful" };
      } else if (response.status === 401) {
        return { ok: false, message: "Invalid API key" };
      } else {
        return { ok: false, message: `API error: ${response.statusText}` };
      }
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  });

  // OAuth 流程：生成授权 URL
  ipcMain.handle(IPC.providerStartOAuth, async (_e: any, { type, clientId }: { type: string; clientId?: string }) => {
    try {
      const result = oauthHandler.generateAuthorizationUrl(type, clientId || "");
      if (!result) {
        return { error: `${type} does not support OAuth` };
      }
      return result;
    } catch (err) {
      return { error: String(err) };
    }
  });

  // OAuth 流程：完成授权回调
  ipcMain.handle(
    IPC.providerCompleteOAuth,
    async (_e: any, { type, code, state, codeVerifier }: { type: string; code: string; state: string; codeVerifier?: string }) => {
      try {
        // 这里需要从配置中读取 clientId 和 clientSecret
        // 实际实现时应该从环境变量或安全存储读取
        const clientId = process.env.PROVIDER_OAUTH_CLIENT_ID || "";
        const clientSecret = process.env.PROVIDER_OAUTH_CLIENT_SECRET || "";

        const tokenResponse = await oauthHandler.exchangeCode(type, code, clientId, clientSecret, state);
        return { ok: true, token: tokenResponse.access_token };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  // 设置默认 context limit
  ipcMain.handle(IPC.providerSetDefaultContextLimit, async (_e: any, { providerId, limit }: { providerId: string; limit: number }) => {
    try {
      providerManager.updateConfig(providerId, { contextLimitOverride: limit });
      quotaManager.invalidateCache(providerId);
      return { ok: true };
    } catch (err) {
      return { ok: false };
    }
  });
}


