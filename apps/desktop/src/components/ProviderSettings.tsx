import React, { useEffect, useState } from "react";
import type { ClaudeApiKeyAuth, ProviderConfig, ProviderStatus, ProviderType } from "@claude-desktop/shared";
import { IPC, supportsOAuth, ProviderEndpoints, normalizeProviderBaseUrl } from "@claude-desktop/shared";
import styles from "./ProviderSettings.module.css";

function formatTokens(n?: number): string {
  if (!n || !Number.isFinite(n)) return "未知";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

interface ProviderCardProps {
  config: ProviderConfig;
  status?: ProviderStatus;
  notice?: { error?: string; message?: string };
  onDelete: (id: string) => Promise<void>;
  onTestAuth: (id: string) => Promise<void>;
  onSyncQuota: (id: string) => Promise<void>;
  onOAuthLogin: (id: string) => Promise<void>;
  onCancelOAuth: (id: string, state: string) => Promise<void>;
  onOAuthCallback: (id: string, state: string, redirectUrl: string) => Promise<void>;
}

function ProviderCard({ config, status, notice, onDelete, onTestAuth, onSyncQuota, onOAuthLogin, onCancelOAuth, onOAuthCallback }: ProviderCardProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [redirectUrl, setRedirectUrl] = useState("");
  const run = async (action: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    try { await operation(); } finally { setBusy(null); }
  };

  const quota = status?.quota;
  const contextLimit = quota?.limitTokens ?? config.contextLimitOverride;
  const modelCount = status?.availableModels?.length ?? 0;
  const pending = Boolean(status?.oauthPending);
  const error = notice?.error || status?.lastError;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.cardIdentity}>
          <h4 className={styles.cardTitle} title={config.name}>
            {config.name}
          </h4>
          <p className={styles.cardType}>{config.type}</p>
        </div>
        <button
          type="button"
          className={styles.cardDelete}
          title="删除"
          aria-label={`删除 ${config.name}`}
          disabled={Boolean(busy)}
          onClick={() => setConfirmingDelete(true)}
        >
          ×
        </button>
      </div>

      {confirmingDelete && (
        <div className={styles.deleteConfirm} role="group" aria-label={`删除确认 ${config.name}`}>
          <p>确定删除「{config.name}」？其凭证也会一并删除。</p>
          <div className={styles.deleteActions}>
            <button type="button" className={styles.btnSecondary} disabled={Boolean(busy)} onClick={() => setConfirmingDelete(false)} autoFocus>取消</button>
            <button type="button" className={styles.btnDanger} aria-label={`确认删除 ${config.name}`} disabled={Boolean(busy)} onClick={() => void run("delete", () => onDelete(config.id))}>
              {busy === "delete" ? "删除中…" : "确认删除"}
            </button>
          </div>
        </div>
      )}

      <div className={styles.cardBody}>
        <div className={styles.pills}>
          <span className={`${styles.pill} ${status?.authenticated ? styles.pillOk : styles.pillWarn}`}>
            {pending ? "等待授权" : status?.authenticated ? "已认证" : "未认证"}
          </span>
          <span className={`${styles.pill} ${config.enabled ? styles.pillMuted : styles.pillWarn}`}>
            {config.enabled ? "已启用" : "已停用"}
          </span>
          {supportsOAuth(config.type) && <span className={`${styles.pill} ${styles.pillMuted}`}>OAuth 可用</span>}
        </div>

        <dl className={styles.meta}>
          <div className={styles.metaRow}>
            <dt>上下文窗口</dt>
            <dd>{formatTokens(contextLimit)}{!quota?.limitTokens && contextLimit ? "（手动设置）" : ""}</dd>
          </div>
          <div className={styles.metaRow}>
            <dt>可见模型</dt>
            <dd>{modelCount > 0 ? modelCount : "未同步"}</dd>
          </div>
          {quota?.syncedAt && (
            <div className={styles.metaRow}>
              <dt>上次同步</dt>
              <dd>{new Date(quota.syncedAt).toLocaleString()}</dd>
            </div>
          )}
        </dl>

        {pending && <p className={styles.hint} role="status">已打开系统浏览器，正在等待授权。完成后会自动刷新。</p>}
        {pending && config.type === "claude" && status?.oauthState && (
          <form className={styles.callbackForm} onSubmit={e => {
            e.preventDefault();
            if (redirectUrl.trim()) void run("callback", () => onOAuthCallback(config.id, status.oauthState!, redirectUrl.trim()));
          }}>
            <label htmlFor={`oauth-callback-${config.id}`}>Claude 授权回调</label>
            <input id={`oauth-callback-${config.id}`} value={redirectUrl} onChange={e => setRedirectUrl(e.target.value)}
              disabled={Boolean(busy)} autoComplete="off" placeholder="粘贴 code#state 或完整回调链接" />
            <p className={styles.hint}>完成 Claude 授权后，粘贴页面提供的 code#state 或完整回调链接。</p>
            <button type="submit" className={styles.btn} disabled={Boolean(busy) || !redirectUrl.trim()}>
              {busy === "callback" ? "验证中…" : "完成授权"}
            </button>
          </form>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {!error && notice?.message && <p className={styles.hint} role="status">{notice.message}</p>}
      </div>

      <div className={styles.cardFooter}>
        <button type="button" onClick={() => void run("test", () => onTestAuth(config.id))} disabled={Boolean(busy) || pending} className={styles.btn}>
          {busy === "test" ? "测试中…" : "测试认证"}
        </button>
        <button type="button" onClick={() => void run("sync", () => onSyncQuota(config.id))} disabled={Boolean(busy) || pending} className={styles.btn}>
          {busy === "sync" ? "同步中…" : "同步模型 / 窗口"}
        </button>
        {supportsOAuth(config.type) && (
          pending && status?.oauthState ? (
            <button type="button" onClick={() => void run("cancel", () => onCancelOAuth(config.id, status.oauthState!))} disabled={Boolean(busy)} className={styles.btn}>
              {busy === "cancel" ? "取消中…" : "取消授权"}
            </button>
          ) : (
            <button type="button" onClick={() => void run("oauth", () => onOAuthLogin(config.id))} disabled={Boolean(busy) || pending} className={styles.btn}>
              {busy === "oauth" ? "打开浏览器…" : "OAuth 登录"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

interface AddProviderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (config: ProviderConfig) => Promise<void>;
}

function AddProviderModal({ isOpen, onClose, onSubmit }: AddProviderModalProps) {
  const [providerType, setProviderType] = useState<ProviderType>("claude");
  const [authMethod, setAuthMethod] = useState<"api-key" | "oauth2">("api-key");
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyAuth, setApiKeyAuth] = useState<ClaudeApiKeyAuth>("auto");
  const [baseUrl, setBaseUrl] = useState("");
  const [oauthClientId, setOAuthClientId] = useState("");
  const [oauthProjectId, setOAuthProjectId] = useState("");
  const [contextLimit, setContextLimit] = useState("200000");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const oauthAvailable = supportsOAuth(providerType);

  const handleProviderTypeChange = (next: ProviderType) => {
    setProviderType(next);
    // 切到不支持 OAuth 的 provider 时，别把一个不可用的认证方式留在表单里。
    if (!supportsOAuth(next)) setAuthMethod("api-key");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);

    const limit = Number(contextLimit);
    if (!Number.isInteger(limit) || limit < 1024 || limit > 10_000_000) {
      setError("Context Limit 必须是 1024 到 10000000 之间的整数");
      return;
    }
    if (authMethod === "api-key" && (providerType === "openai-compatible" || baseUrl.trim())) {
      try {
        normalizeProviderBaseUrl(baseUrl);
      } catch {
        setError("Base URL 必须是有效的 HTTP 或 HTTPS 地址，且不包含账号密码、查询参数或片段");
        return;
      }
    }
    if (authMethod === "api-key" && !apiKey.trim()) {
      setError("请输入 API Key");
      return;
    }
    if (authMethod === "oauth2" && providerType === "gemini" && !oauthClientId.trim()) {
      setError("请输入你在 Google Cloud 创建的桌面应用 OAuth Client ID");
      return;
    }

    setLoading(true);
    try {
      const config: ProviderConfig = {
        id: `${providerType}-${Date.now()}`,
        name: name.trim() || providerType,
        type: providerType,
        enabled: true,
        auth:
          providerType === "openai-compatible"
            ? { type: "openai-compatible", authMethod: "api-key", baseUrl: baseUrl.trim() }
            : ({ type: providerType, authMethod,
              ...(authMethod === "api-key" && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
              ...(providerType === "claude" && authMethod === "api-key" && apiKeyAuth !== "auto" ? { apiKeyAuth } : {}),
            } as ProviderConfig["auth"]),
        contextLimitOverride: limit,
      };

      if (authMethod === "api-key" && apiKey.trim()) {
        config.auth.apiKey = apiKey.trim();
      }
      if (authMethod === "oauth2" && providerType === "gemini") {
        config.oauthClientId = oauthClientId.trim();
        if (oauthProjectId.trim()) config.oauthProjectId = oauthProjectId.trim();
      }

      await onSubmit(config);
      setName("");
      setApiKey("");
      setApiKeyAuth("auto");
      setBaseUrl("");
      setOAuthClientId("");
      setOAuthProjectId("");
      setContextLimit("200000");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.modal} role="dialog" aria-modal="true" aria-label="添加 Provider">
      <div className={styles.modalContent}>
        <h2>添加 Provider</h2>
        <form onSubmit={handleSubmit} noValidate>
          <fieldset disabled={loading} className={styles.formFields}>
          <div className={styles.formGroup}>
            <label htmlFor="provider-type">Provider 类型</label>
            <select
              id="provider-type"
              value={providerType}
              onChange={(e) => handleProviderTypeChange(e.target.value as ProviderType)}
            >
              <option value="claude">Claude (Anthropic)</option>
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="kimi">Kimi (Moonshot)</option>
              <option value="xai">xAI (Grok)</option>
              <option value="gemini">Gemini (Google)</option>
              <option value="openai-compatible">OpenAI 兼容</option>
            </select>
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="provider-name">显示名称</label>
            <input
              id="provider-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={providerType}
            />
          </div>

          {providerType !== "openai-compatible" && oauthAvailable && (
            <div className={styles.formGroup}>
              <label htmlFor="provider-auth">认证方式</label>
              <select
                id="provider-auth"
                value={authMethod}
                onChange={(e) => setAuthMethod(e.target.value as "api-key" | "oauth2")}
              >
                <option value="api-key">API Key</option>
                <option value="oauth2">OAuth 2.0</option>
              </select>
            </div>
          )}

          {authMethod === "api-key" && (
            <div className={styles.formGroup}>
              <label htmlFor="provider-key">API Key</label>
              <input
                id="provider-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
              />
            </div>
          )}

          {providerType === "claude" && authMethod === "api-key" && (
            <div className={styles.formGroup}>
              <label htmlFor="provider-key-auth">服务鉴权</label>
              <select id="provider-key-auth" value={apiKeyAuth} onChange={e => setApiKeyAuth(e.target.value as ClaudeApiKeyAuth)}>
                <option value="auto">自动（官方 API Key，中转服务 Bearer）</option>
                <option value="x-api-key">API Key（x-api-key）</option>
                <option value="bearer">Bearer / Auth Token</option>
              </select>
              <p className={styles.hint}>中转服务生成的 API Key 通常选择自动；如服务商指定鉴权方式，可在此切换。调用仍使用 Claude Messages 协议。</p>
            </div>
          )}

          {providerType !== "openai-compatible" && authMethod === "oauth2" && (
            <p className={styles.hint}>
              保存后将打开系统浏览器，直接向 {providerType === "claude" ? "Claude" : providerType === "openai" ? "OpenAI" : "Google"} 授权登录。账号凭证仅加密保存在本机。
            </p>
          )}

          {providerType === "gemini" && authMethod === "oauth2" && (
            <>
            <div className={styles.formGroup}>
              <label htmlFor="provider-oauth-client-id">Google OAuth Client ID</label>
              <input id="provider-oauth-client-id" type="text" value={oauthClientId}
                onChange={e => setOAuthClientId(e.target.value)} placeholder="…apps.googleusercontent.com" autoComplete="off" />
              <p className={styles.hint}>使用你在 Google Cloud 创建的桌面应用客户端 ID，无需客户端密钥。</p>
            </div>
            <div className={styles.formGroup}>
              <label htmlFor="provider-oauth-project-id">Google Cloud Project ID（可选）</label>
              <input id="provider-oauth-project-id" type="text" value={oauthProjectId}
                onChange={e => setOAuthProjectId(e.target.value)} placeholder="my-cloud-project" autoComplete="off" />
              <p className={styles.hint}>在自有项目中启用 Generative Language API；调用使用项目配额，并非 Gemini CLI 个人免费额度。</p>
            </div>
            </>
          )}

          {authMethod === "api-key" && (
            <div className={styles.formGroup}>
              <label htmlFor="provider-base-url">Base URL{providerType === "openai-compatible" ? "" : "（可选）"}</label>
              <input
                id="provider-base-url"
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={providerType === "openai-compatible" ? "http://localhost:8080/v1" : `${ProviderEndpoints[providerType].baseUrl}${ProviderEndpoints[providerType].modelsEndpoint.replace(/\/models$/, "")}`}
                autoComplete="off"
              />
              <p className={styles.hint}>{providerType === "openai-compatible" ? "填写兼容服务的 API 地址。" : "留空使用官方地址；填写后，模型同步与调用均使用此地址。"}</p>
            </div>
          )}

          <div className={styles.formGroup}>
            <label htmlFor="provider-limit">Context Limit (tokens)</label>
            <input
              id="provider-limit"
              type="number"
              value={contextLimit}
              onChange={(e) => setContextLimit(e.target.value)}
              min={1024}
              max={10000000}
              step={1}
            />
          </div>

          {error && <p className={styles.error} role="alert">{error}</p>}

          <div className={styles.modalFooter}>
            <button type="button" onClick={onClose} disabled={loading} className={styles.btnSecondary}>
              取消
            </button>
            <button type="submit" disabled={loading} className={styles.btnPrimary}>
              {loading ? "保存中…" : authMethod === "oauth2" ? "保存并登录" : "添加"}
            </button>
          </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}

export function ProviderSettings() {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [statuses, setStatuses] = useState<Map<string, ProviderStatus>>(new Map());
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Map<string, { error?: string; message?: string }>>(new Map());

  useEffect(() => {
    void loadProviders();
    const interval = setInterval(() => void loadProviders(), 30000); // 每 30 秒刷新
    const unsubscribe = window.desktop.on(IPC.providerUpdated, () => void loadProviders());
    return () => { clearInterval(interval); unsubscribe(); };
  }, []);

  const loadProviders = async () => {
    try {
      const result = await window.desktop.listProviders();
      setConfigs(result || []);

      const newStatuses = new Map<string, ProviderStatus>();
      for (const config of result || []) {
        const status = await window.desktop.getProviderStatus(config.id);
        if (status) {
          newStatuses.set(config.id, status);
        }
      }
      setStatuses(newStatuses);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const setNotice = (id: string, notice: { error?: string; message?: string }) => {
    setNotices(prev => new Map(prev).set(id, notice));
  };

  const providerAction = async (id: string, operation: () => Promise<string | void>) => {
    setNotice(id, {});
    try {
      const message = await operation();
      if (message) setNotice(id, { message });
    } catch (err) {
      setNotice(id, { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleAddProvider = async (config: ProviderConfig) => {
    // 后端返回 ok:false 而不是抛错，这里必须检查，否则添加失败会被吞掉。
    const result = await window.desktop.addProvider(config);
    if (!result.ok) {
      throw new Error(result.error || "添加 Provider 失败");
    }
    // 已保存的账号先留在列表中；浏览器打开失败时可直接从卡片重试，不再重复添加。
    setConfigs(prev => [...prev.filter(item => item.id !== config.id), config]);
    await loadProviders();
    if (config.auth.authMethod === "oauth2") await handleOAuthLogin(config.id);
  };

  const handleDeleteProvider = async (id: string) => {
    await providerAction(id, async () => {
      const result = await window.desktop.deleteProvider(id);
      if (!result.ok) throw new Error(result.error || "删除失败");
      await loadProviders();
    });
  };

  const handleTestAuth = async (id: string) => {
    await providerAction(id, async () => {
      const result = await window.desktop.testProviderAuth(id);
      await loadProviders();
      if (!result.ok) throw new Error(result.message || "认证失败");
      return result.message || "认证成功";
    });
  };

  const handleSyncQuota = async (id: string) => {
    await providerAction(id, async () => {
      const result = await window.desktop.syncProviderQuota(id);
      await loadProviders();
      if (!result.ok) throw new Error(result.error || "模型与上下文窗口同步失败");
      return "模型与上下文窗口已同步";
    });
  };

  const handleOAuthLogin = async (id: string) => {
    await providerAction(id, async () => {
      const result = await window.desktop.startProviderOAuth(id);
      if (!result.ok) throw new Error(result.error || "OAuth 登录失败");
      await loadProviders();
    });
  };

  const handleCancelOAuth = async (id: string, state: string) => {
    await providerAction(id, async () => {
      const result = await window.desktop.cancelProviderOAuth(state);
      if (!result.ok) throw new Error("取消授权失败，请重试");
      await loadProviders();
      return "已取消授权，可重新登录";
    });
  };

  const handleOAuthCallback = async (id: string, state: string, redirectUrl: string) => {
    await providerAction(id, async () => {
      const result = await window.desktop.submitProviderOAuthCallback(state, redirectUrl);
      if (!result.ok) throw new Error(result.error || "授权回调验证失败");
      await loadProviders();
    });
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div>
          <h3>Provider 管理</h3>
          <p>管理模型服务账号，使用 API Key 或 OAuth 直接连接服务商。凭证使用系统安全存储加密保存。</p>
        </div>
        <button type="button" onClick={() => setShowModal(true)} className={styles.btnPrimary}>
          + 添加 Provider
        </button>
      </div>

      {loadError && <p className={styles.error} role="alert">加载 Provider 失败：{loadError} <button type="button" className={styles.btn} onClick={() => void loadProviders()}>重试</button></p>}
      {loading ? (
        <p className={styles.hint}>加载中…</p>
      ) : configs.length === 0 ? (
        <div className={styles.empty}>
          <strong>还没有配置任何 Provider</strong>
          <span className={styles.hint}>点右上角「添加 Provider」开始</span>
        </div>
      ) : (
        <div className={styles.grid}>
          {configs.map((config) => (
            <ProviderCard
              key={config.id}
              config={config}
              status={statuses.get(config.id)}
              notice={notices.get(config.id)}
              onDelete={handleDeleteProvider}
              onTestAuth={handleTestAuth}
              onSyncQuota={handleSyncQuota}
              onOAuthLogin={handleOAuthLogin}
              onCancelOAuth={handleCancelOAuth}
              onOAuthCallback={handleOAuthCallback}
            />
          ))}
        </div>
      )}

      <AddProviderModal isOpen={showModal} onClose={() => setShowModal(false)} onSubmit={handleAddProvider} />
    </section>
  );
}
