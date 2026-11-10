import { ipcMain, shell } from "electron";
import type { ProviderConfig } from "@claude-desktop/shared";
import { IPC, supportsOAuth, normalizeProviderBaseUrl } from "@claude-desktop/shared";
import type { ProviderManager } from "./provider-manager";
import { isValidProviderId } from "./provider-manager";
import type { CredentialManager } from "./credential-manager";
import type { QuotaManager } from "./provider-quota-manager";
import type { OAuthHandler } from "./oauth-handler";
import type { ProviderRuntime } from "./provider-runtime";

export interface ProviderHandlerDeps {
  providerManager: ProviderManager;
  credentials: CredentialManager;
  quotaManager: QuotaManager;
  oauthHandler: OAuthHandler;
  runtime: ProviderRuntime;
  sendToRenderer: (channel: string, payload: unknown) => void;
}

/** Validate at the process boundary as well as in the form. */
export function validateProviderConfig(config: ProviderConfig): void {
  if (!config || !isValidProviderId(config.id)) throw new Error("Provider ID 无效");
  if (!config.auth || config.auth.type !== config.type) throw new Error("Provider 类型与认证配置不一致");
  if (!["claude", "openai", "deepseek", "kimi", "xai", "gemini", "openai-compatible"].includes(config.type)) throw new Error("Provider 类型无效");
  if (config.auth.authMethod !== "api-key" && config.auth.authMethod !== "oauth2") throw new Error("认证方式无效");
  const apiKeyAuth = (config.auth as { apiKeyAuth?: unknown }).apiKeyAuth;
  if (apiKeyAuth !== undefined && (config.type !== "claude" || !["auto", "x-api-key", "bearer"].includes(apiKeyAuth as string))) throw new Error("Claude 服务鉴权方式无效");
  if (config.auth.authMethod === "oauth2" && !supportsOAuth(config.type)) throw new Error("此 Provider 不支持 OAuth");
  if (config.contextLimitOverride != null && (!Number.isInteger(config.contextLimitOverride) || config.contextLimitOverride < 1024 || config.contextLimitOverride > 10_000_000)) throw new Error("Context Limit 必须是 1024 到 10000000 之间的整数");
  if (config.auth.baseUrl != null && typeof config.auth.baseUrl !== "string") throw new Error("Base URL 必须是字符串");
  if (config.auth.authMethod === "oauth2" && config.auth.baseUrl?.trim()) throw new Error("OAuth 使用官方账号后端，不支持自定义 API Base URL");
  if (config.type === "openai-compatible" || config.auth.baseUrl?.trim()) normalizeProviderBaseUrl(config.auth.baseUrl);
}

export function registerProviderHandlers(deps: ProviderHandlerDeps): void {
  const { providerManager, credentials, quotaManager, oauthHandler, runtime } = deps;
  const pending = new Map<string, string>();
  const launching = new Map<string, symbol>();
  const generations = new Map<string, number>();
  const errorText = (error: unknown) => error instanceof Error ? error.message : "Provider 操作失败";
  const status = async (id: string) => {
    const snapshot = await runtime.providerStatus(id);
    return snapshot ? { ...snapshot, oauthPending: pending.has(id), oauthState: pending.get(id) } : null;
  };
  const notify = async (id: string) => deps.sendToRenderer(IPC.providerUpdated, { providerId: id, status: await status(id) });
  const cancelForProvider = (id: string) => {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    const state = pending.get(id);
    pending.delete(id);
    if (state) oauthHandler.cancel(state);
  };
  ipcMain.handle(IPC.providerListConfigs, async () => providerManager.listConfigs());
  ipcMain.handle(IPC.providerAddConfig, async (_e, { config }: { config: ProviderConfig }) => {
    let wroteKey = false;
    try {
      validateProviderConfig(config);
      if (providerManager.getConfig(config.id)) throw new Error("Provider ID 已存在");
      const key = config.auth.apiKey?.trim();
      if (config.auth.authMethod === "api-key" && !key) throw new Error("请输入 API Key");
      if (key && config.auth.authMethod === "api-key") { providerManager.saveApiKey(config.id, credentials.encrypt(key)); wroteKey = true; }
      providerManager.addConfig({ ...config, lastAuthenticatedAt: undefined, lastQuotaSyncAt: undefined, auth: { ...config.auth, apiKey: undefined } });
      if (config.auth.authMethod === "api-key") await runtime.syncProvider(config.id);
      await notify(config.id);
      return { ok: true, id: config.id };
    } catch (error) {
      if (wroteKey && !providerManager.getConfig(config.id)) providerManager.deleteApiKey(config.id);
      return { ok: false, error: errorText(error) };
    }
  });
  ipcMain.handle(IPC.providerUpdateConfig, async (_e, { id, config }: { id: string; config: Partial<ProviderConfig> }) => {
    try {
      const existing = providerManager.getConfig(id);
      if (!existing) throw new Error("Provider 不存在");
      const next = { ...existing, ...config, id, auth: { ...existing.auth, ...config.auth } } as ProviderConfig;
      if (next.type !== existing.type) throw new Error("修改 Provider 类型需要重新添加");
      validateProviderConfig(next);
      const key = config.auth?.apiKey?.trim();
      if (key) providerManager.saveApiKey(id, credentials.encrypt(key));
      cancelForProvider(id);
      providerManager.updateConfig(id, { ...next, lastAuthenticatedAt: undefined, auth: { ...next.auth, apiKey: undefined } });
      runtime.invalidate(id); await notify(id);
      return { ok: true };
    } catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle(IPC.providerDeleteConfig, async (_e, { id }: { id: string }) => {
    try {
      if (!isValidProviderId(id)) throw new Error("Provider ID 无效");
      cancelForProvider(id); providerManager.deleteConfig(id);
      providerManager.deleteApiKey(id); oauthHandler.deleteOAuthToken(id);
      runtime.invalidate(id); await notify(id);
      return { ok: true };
    } catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle(IPC.providerGetStatus, async (_e, { id }: { id: string }) => status(id));
  ipcMain.handle(IPC.providerGetUsage, async (_e, request: { range: import("@claude-desktop/shared").ProviderUsageRange; providerId?: string }) => {
    if (!request || !["24h", "7d", "30d"].includes(request.range)) throw new Error("统计时间范围无效");
    if (request.providerId != null && !isValidProviderId(request.providerId)) throw new Error("Provider ID 无效");
    return runtime.getUsage(request.range, request.providerId);
  });
  ipcMain.handle(IPC.providerSyncQuota, async (_e, { id }: { id: string }) => {
    const result = await runtime.syncProvider(id); await notify(id);
    return result.error ? { ok: false, error: result.error } : { ok: true, quota: result.quota ?? undefined };
  });
  ipcMain.handle(IPC.providerTestAuth, async (_e, { id }: { id: string }) => {
    const result = await runtime.syncProvider(id); await notify(id);
    return result.error ? { ok: false, message: result.error } : { ok: true, message: `连接成功，可见 ${result.models?.length ?? 0} 个模型` };
  });
  ipcMain.handle(IPC.providerStartOAuth, async (_e, { id }: { id: string }) => {
    let started: string | undefined;
    let launch: symbol | undefined;
    try {
      const config = providerManager.getConfig(id);
      if (!config || !isValidProviderId(id)) throw new Error("Provider 不存在");
      if (pending.has(id) || launching.has(id)) throw new Error("此 Provider 正在等待授权，请先取消或完成登录");
      launch = Symbol(id);
      launching.set(id, launch);
      const generation = generations.get(id) ?? 0;
      const { authorizationUrl, state, completion } = await oauthHandler.start(id);
      if ((generations.get(id) ?? 0) !== generation || !providerManager.getConfig(id)) {
        oauthHandler.cancel(state);
        throw new Error("Provider 配置已变更，请重新发起授权");
      }
      started = state;
      pending.set(id, state); runtime.setError(id);
      void completion.then(async token => {
        if (pending.get(id) !== state || !providerManager.getConfig(id)) return;
        oauthHandler.saveOAuthToken(id, token);
        providerManager.updateConfig(id, { lastAuthenticatedAt: undefined, auth: { ...config.auth, authMethod: "oauth2", baseUrl: undefined } as ProviderConfig["auth"] });
        pending.delete(id); runtime.invalidate(id);
        await runtime.syncProvider(id); await notify(id);
      }).catch(async error => {
        if (pending.get(id) !== state) return;
        pending.delete(id); runtime.setError(id, errorText(error)); await notify(id);
      });
      await shell.openExternal(authorizationUrl); await notify(id);
      return { ok: true, authorizationUrl, state };
    } catch (error) {
      if (started) cancelForProvider(id);
      runtime.setError(id, errorText(error)); await notify(id);
      return { ok: false, error: errorText(error) };
    } finally { if (launch && launching.get(id) === launch) launching.delete(id); }
  });
  ipcMain.handle(IPC.providerCancelOAuth, async (_e, { state }: { state: string }) => {
    const entry = [...pending].find(([, value]) => value === state);
    if (entry) { cancelForProvider(entry[0]); runtime.setError(entry[0], "授权已取消"); await notify(entry[0]); }
    return { ok: true };
  });
  ipcMain.handle(IPC.providerSubmitOAuthCallback, async (_e, { state, redirectUrl }: { state: string; redirectUrl: string }) => {
    try {
      if (![...pending.values()].includes(state)) throw new Error("授权流程已结束，请重新登录");
      await oauthHandler.submitCallback(state, redirectUrl);
      return { ok: true };
    } catch (error) { return { ok: false, error: errorText(error) }; }
  });
  ipcMain.handle(IPC.providerSetDefaultContextLimit, async (_e, { providerId, limit }: { providerId: string; limit: number }) => {
    try {
      const config = providerManager.getConfig(providerId);
      if (!config) throw new Error("Provider 不存在");
      validateProviderConfig({ ...config, contextLimitOverride: limit });
      providerManager.updateConfig(providerId, { contextLimitOverride: limit }); quotaManager.invalidateCache(providerId);
      await runtime.syncProvider(providerId); await notify(providerId);
      return { ok: true };
    } catch (error) { return { ok: false, error: errorText(error) }; }
  });
}
