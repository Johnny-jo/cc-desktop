/**
 * Provider IPC 处理器
 */

import { ipcMain, shell } from "electron";
import type { ProviderConfig } from "@claude-desktop/shared";
import { IPC } from "@claude-desktop/shared";
import type { ProviderManager } from "./provider-manager";
import { isValidProviderId } from "./provider-manager";
import type { CredentialManager } from "./credential-manager";
import type { QuotaManager } from "./provider-quota-manager";
import type { OAuthHandler } from "./oauth-handler";

export interface ProviderHandlerDeps {
  providerManager: ProviderManager;
  credentials: CredentialManager;
  quotaManager: QuotaManager;
  oauthHandler: OAuthHandler;
  /** 用于把 OAuth 完成 / 配额告警推给渲染进程 */
  sendToRenderer: (channel: string, payload: unknown) => void;
}

export function registerProviderHandlers(deps: ProviderHandlerDeps): void {
  const { providerManager, credentials, quotaManager, oauthHandler } = deps;

  /** 读取可用于请求上游的凭证：优先 API Key，其次 OAuth access token（必要时刷新）。 */
  const resolveCredential = async (id: string): Promise<string | null> => {
    const encrypted = providerManager.loadApiKey(id);
    if (encrypted) {
      try {
        return credentials.decrypt(encrypted);
      } catch (err) {
        console.warn(`[Provider] Failed to decrypt API key for ${id}:`, err);
      }
    }
    return oauthHandler.ensureFreshToken(id);
  };

  ipcMain.handle(IPC.providerListConfigs, async () => providerManager.listConfigs());

  ipcMain.handle(
    IPC.providerAddConfig,
    async (_e, { config }: { config: ProviderConfig }) => {
      try {
        if (config.auth.type !== config.type) {
          return { ok: false, error: "auth.type must match config.type" };
        }
        // 不在调用方的对象上动刀：UI 传进来的 config 可能还会被复用。
        const stored: ProviderConfig = { ...config, auth: { ...config.auth } };
        const apiKey = stored.auth.apiKey;
        if (apiKey) {
          stored.auth.apiKey = undefined;
        }
        const id = providerManager.addConfig(stored);
        if (apiKey) {
          providerManager.saveApiKey(id, credentials.encrypt(apiKey));
        }
        return { ok: true, id };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    IPC.providerUpdateConfig,
    async (_e, { id, config }: { id: string; config: Partial<ProviderConfig> }) => {
      try {
        if (!isValidProviderId(id)) return { ok: false, error: "Invalid provider id" };
        const patch: Partial<ProviderConfig> = { ...config };
        if (config.auth) patch.auth = { ...config.auth };
        const apiKey = patch.auth?.apiKey;
        if (apiKey) {
          providerManager.saveApiKey(id, credentials.encrypt(apiKey));
          patch.auth = { ...patch.auth!, apiKey: undefined };
        }
        const success = providerManager.updateConfig(id, patch);
        quotaManager.invalidateCache(id);
        return { ok: success, error: success ? undefined : "Provider not found" };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(IPC.providerDeleteConfig, async (_e, { id }: { id: string }) => {
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

  ipcMain.handle(IPC.providerGetStatus, async (_e, { id }: { id: string }) => {
    const status = providerManager.getStatus(id);
    if (!status) return null;

    // ProviderManager 不知道配额缓存，这里把上次同步的结果并进去，
    // 否则 UI 拿到的 quota 永远是 undefined、卡片上一片空白。
    const cached = quotaManager.peek(id);
    if (cached) {
      status.quota = cached.quota ?? undefined;
      status.availableModels = cached.models;
      status.lastError = cached.error;
    }
    return status;
  });

  ipcMain.handle(IPC.providerSyncQuota, async (_e, { id }: { id: string }) => {
    try {
      const config = providerManager.getConfig(id);
      if (!config) return { ok: false, error: "Provider not found" };

      const credential = await resolveCredential(id);
      const result = await quotaManager.syncQuota(config, credential ?? undefined);
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, quota: result.quota };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(IPC.providerTestAuth, async (_e, { id }: { id: string }) => {
    try {
      const config = providerManager.getConfig(id);
      if (!config) return { ok: false, message: "Provider not found" };

      const credential = await resolveCredential(id);
      if (!credential) {
        return { ok: false, message: "未配置凭证（API Key 或 OAuth 登录）" };
      }

      // 复用配额同步的取数逻辑：拉一次模型列表，既验证凭证也刷新窗口信息。
      quotaManager.invalidateCache(id);
      const result = await quotaManager.syncQuota(config, credential);
      if (result.error) {
        return { ok: false, message: result.error };
      }
      const count = result.models?.length ?? 0;
      return { ok: true, message: `认证成功，可见 ${count} 个模型` };
    } catch (err) {
      return { ok: false, message: String(err) };
    }
  });

  // ── OAuth ──────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.providerStartOAuth, async (_e, { id }: { id: string }) => {
    try {
      if (!isValidProviderId(id)) return { ok: false, error: "Invalid provider id" };
      const { authorizationUrl, state, completion } = await oauthHandler.start(id);

      // 在后台等回调：成功则持久化 token 并通知渲染进程，失败则只通知。
      completion
        .then((token) => {
          oauthHandler.saveOAuthToken(id, token);
          quotaManager.invalidateCache(id);
          deps.sendToRenderer(IPC.providerUpdated, {
            providerId: id,
            status: providerManager.getStatus(id),
          });
        })
        .catch((err: unknown) => {
          console.warn(`[Provider] OAuth failed for ${id}:`, err);
        });

      // 授权页必须在系统浏览器里打开：内嵌 webview 会被 Google 等拒绝。
      await shell.openExternal(authorizationUrl);
      return { ok: true, authorizationUrl, state };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(IPC.providerCancelOAuth, async (_e, { state }: { state: string }) => {
    oauthHandler.cancel(state);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.providerSetDefaultContextLimit,
    async (_e, { providerId, limit }: { providerId: string; limit: number }) => {
      try {
        if (!isValidProviderId(providerId)) return { ok: false, error: "Invalid provider id" };
        if (!Number.isFinite(limit) || limit <= 0) {
          return { ok: false, error: "limit must be a positive number" };
        }
        const ok = providerManager.updateConfig(providerId, {
          contextLimitOverride: Math.floor(limit),
        });
        quotaManager.invalidateCache(providerId);
        return { ok, error: ok ? undefined : "Provider not found" };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );
}
