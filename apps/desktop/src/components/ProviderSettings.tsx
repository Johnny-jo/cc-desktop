import React, { useEffect, useState } from "react";
import type { ProviderConfig, ProviderStatus, ProviderType } from "@claude-desktop/shared";
import { supportsOAuth } from "@claude-desktop/shared";
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
  onDelete: (id: string) => void;
  onTestAuth: (id: string) => void;
  onSyncQuota: (id: string) => void;
  onOAuthLogin: (id: string) => void;
}

function ProviderCard({ config, status, onDelete, onTestAuth, onSyncQuota, onOAuthLogin }: ProviderCardProps) {
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    try {
      await onTestAuth(config.id);
    } finally {
      setTesting(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await onSyncQuota(config.id);
    } finally {
      setSyncing(false);
    }
  };

  const handleSignIn = async () => {
    setSigningIn(true);
    try {
      await onOAuthLogin(config.id);
    } finally {
      setSigningIn(false);
    }
  };

  const quota = status?.quota;
  const modelCount = status?.availableModels?.length ?? 0;

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
          onClick={() => onDelete(config.id)}
        >
          ×
        </button>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.pills}>
          <span className={`${styles.pill} ${status?.authenticated ? styles.pillOk : styles.pillWarn}`}>
            {status?.authenticated ? "已认证" : "未认证"}
          </span>
          <span className={`${styles.pill} ${config.enabled ? styles.pillMuted : styles.pillWarn}`}>
            {config.enabled ? "已启用" : "已停用"}
          </span>
          {supportsOAuth(config.type) && <span className={`${styles.pill} ${styles.pillMuted}`}>OAuth 可用</span>}
        </div>

        <dl className={styles.meta}>
          <div className={styles.metaRow}>
            <dt>上下文窗口</dt>
            <dd>{formatTokens(quota?.limitTokens)}</dd>
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

        {status?.lastError && <p className={styles.error}>{status.lastError}</p>}
      </div>

      <div className={styles.cardFooter}>
        <button type="button" onClick={handleTest} disabled={testing} className={styles.btn}>
          {testing ? "测试中…" : "测试认证"}
        </button>
        <button type="button" onClick={handleSync} disabled={syncing} className={styles.btn}>
          {syncing ? "同步中…" : "同步配额"}
        </button>
        {supportsOAuth(config.type) && (
          <button type="button" onClick={handleSignIn} disabled={signingIn} className={styles.btn}>
            {signingIn ? "已开浏览器…" : "OAuth 登录"}
          </button>
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
  const [baseUrl, setBaseUrl] = useState("");
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
    setError(null);

    const limit = Number(contextLimit);
    if (!Number.isFinite(limit) || limit < 1024 || limit > 10_000_000) {
      setError("Context Limit 必须是 1024 到 10000000 之间的整数");
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
            : ({ type: providerType, authMethod } as ProviderConfig["auth"]),
        contextLimitOverride: Math.floor(limit),
      };

      if (authMethod === "api-key" && apiKey) {
        config.auth.apiKey = apiKey;
      }

      await onSubmit(config);
      setName("");
      setApiKey("");
      setBaseUrl("");
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
        <form onSubmit={handleSubmit}>
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

          {providerType !== "openai-compatible" && authMethod === "api-key" && (
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

          {providerType !== "openai-compatible" && authMethod === "oauth2" && (
            <p className={styles.hint}>
              添加后点「OAuth 登录」用系统浏览器完成授权。需要先在 provider 配置里填好 OAuth 客户端 ID。
            </p>
          )}

          {providerType === "openai-compatible" && (
            <div className={styles.formGroup}>
              <label htmlFor="provider-base-url">Base URL</label>
              <input
                id="provider-base-url"
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:8317"
              />
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
              step={1024}
            />
          </div>

          {error && <p className={styles.error}>{error}</p>}

          <div className={styles.modalFooter}>
            <button type="button" onClick={onClose} className={styles.btnSecondary}>
              取消
            </button>
            <button type="submit" disabled={loading} className={styles.btnPrimary}>
              {loading ? "添加中…" : "添加"}
            </button>
          </div>
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

  useEffect(() => {
    void loadProviders();
    const interval = setInterval(() => void loadProviders(), 30000); // 每 30 秒刷新
    return () => clearInterval(interval);
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
    } finally {
      setLoading(false);
    }
  };

  const handleAddProvider = async (config: ProviderConfig) => {
    // 后端返回 ok:false 而不是抛错，这里必须检查，否则添加失败会被吞掉。
    const result = await window.desktop.addProvider(config);
    if (!result.ok) {
      throw new Error(result.error || "添加 Provider 失败");
    }
    await loadProviders();
  };

  const handleDeleteProvider = async (id: string) => {
    if (!confirm("确定要删除此 Provider 吗？其凭证也会一并删除。")) return;
    try {
      const result = await window.desktop.deleteProvider(id);
      if (!result.ok) {
        alert(`删除失败: ${result.error}`);
        return;
      }
      await loadProviders();
    } catch (err) {
      alert(`删除失败: ${err}`);
    }
  };

  const handleTestAuth = async (id: string) => {
    try {
      const result = await window.desktop.testProviderAuth(id);
      alert(result.message || (result.ok ? "认证成功" : "认证失败"));
      if (result.ok) await loadProviders();
    } catch (err) {
      alert(`认证错误: ${err}`);
    }
  };

  const handleSyncQuota = async (id: string) => {
    try {
      const result = await window.desktop.syncProviderQuota(id);
      if (result.ok) {
        await loadProviders();
      } else {
        alert(`配额同步失败: ${result.error}`);
      }
    } catch (err) {
      alert(`配额同步错误: ${err}`);
    }
  };

  const handleOAuthLogin = async (id: string) => {
    const result = await window.desktop.startProviderOAuth(id);
    if (!result.ok) {
      alert(`OAuth 登录失败: ${result.error}`);
      return;
    }
    // 授权在系统浏览器里完成，成功后主进程会推送 provider:updated。
    alert("已打开浏览器，完成授权后返回本窗口即可。");
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div>
          <h3>Provider 管理</h3>
          <p>添加模型服务凭证后可在这里测试、同步上下文窗口。密钥使用系统安全存储加密保存。</p>
        </div>
        <button type="button" onClick={() => setShowModal(true)} className={styles.btnPrimary}>
          + 添加 Provider
        </button>
      </div>

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
              onDelete={handleDeleteProvider}
              onTestAuth={handleTestAuth}
              onSyncQuota={handleSyncQuota}
              onOAuthLogin={handleOAuthLogin}
            />
          ))}
        </div>
      )}

      <AddProviderModal isOpen={showModal} onClose={() => setShowModal(false)} onSubmit={handleAddProvider} />
    </section>
  );
}
