/**
 * Provider IPC 处理器（集成到 ipc-handlers.ts）
 */

import { IPC } from "@claude-desktop/shared";
import type { ProviderConfig } from "@claude-desktop/shared";
import { ProviderManager } from "./provider-manager";
import { CredentialManager } from "./credential-manager";
import { QuotaManager } from "./provider-quota-manager";

export function registerProviderHandlers(
  ipcMain: any,
  providerManager: ProviderManager,
  quotaManager: QuotaManager,
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

      // 读取加密的 API Key
      let apiKey: string | undefined;
      const encrypted = providerManager.loadApiKey(id);
      if (encrypted) {
        apiKey = CredentialManager.decrypt(encrypted);
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
      const oauthConfig = providerManager.getOAuthConfig(type);
      if (!oauthConfig.authorizationUrl) {
        return { error: `${type} does not support OAuth` };
      }
      const state = providerManager.generateOAuthState();
      const params = new URLSearchParams({
        client_id: clientId || "",
        redirect_uri: "http://localhost:5173/oauth-callback",
        response_type: "code",
        scope: oauthConfig.scope || "",
        state,
      });
      const authorizationUrl = `${oauthConfig.authorizationUrl}?${params.toString()}`;
      return { authorizationUrl, state };
    } catch (err) {
      return { error: String(err) };
    }
  });

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

