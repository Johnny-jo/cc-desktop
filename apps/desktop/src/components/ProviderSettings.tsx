import React, { useEffect, useState } from "react";
import type { ProviderConfig, ProviderStatus } from "@claude-desktop/shared";
import { ProviderType } from "@claude-desktop/shared";
import styles from "./ProviderSettings.module.css";

interface ProviderCardProps {
  config: ProviderConfig;
  status?: ProviderStatus;
  onEdit: (config: ProviderConfig) => void;
  onDelete: (id: string) => void;
  onTestAuth: (id: string) => void;
  onSyncQuota: (id: string) => void;
}

function ProviderCard({ config, status, onEdit, onDelete, onTestAuth, onSyncQuota }: ProviderCardProps) {
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    await onTestAuth(config.id);
    setTesting(false);
  };

  const handleSync = async () => {
    setSyncing(true);
    await onSyncQuota(config.id);
    setSyncing(false);
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <h3>{config.name}</h3>
          <p className={styles.type}>{config.type}</p>
        </div>
        <div className={styles.actions}>
          <button onClick={() => onEdit(config)} className={styles.btn}>
            编辑
          </button>
          <button onClick={() => onDelete(config.id)} className={`${styles.btn} ${styles.btnDanger}`}>
            删除
          </button>
        </div>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.status}>
          <span className={status?.authenticated ? styles.statusOk : styles.statusError}>
            {status?.authenticated ? "✓ 已认证" : "✗ 未认证"}
          </span>
          {config.enabled ? <span className={styles.enabled}>已启用</span> : <span className={styles.disabled}>已禁用</span>}
        </div>

        {status?.quota && (
          <div className={styles.quota}>
            <div className={styles.quotaItem}>
              <span>Context Limit: {status.quota.limitTokens?.toLocaleString() || "N/A"} tokens</span>
            </div>
            {status.quota.usedQuota !== undefined && (
              <div className={styles.quotaItem}>
                <span>Used: {status.quota.usedQuota?.toLocaleString() || "0"} tokens</span>
              </div>
            )}
            {status.quota.syncedAt && (
              <div className={styles.quotaItem}>
                <span className={styles.small}>Last synced: {new Date(status.quota.syncedAt).toLocaleString()}</span>
              </div>
            )}
          </div>
        )}

        {status?.lastError && <div className={styles.error}>{status.lastError}</div>}
      </div>

      <div className={styles.cardFooter}>
        <button onClick={handleTest} disabled={testing} className={styles.btn}>
          {testing ? "测试中..." : "测试认证"}
        </button>
        <button onClick={handleSync} disabled={syncing} className={styles.btn}>
          {syncing ? "同步中..." : "同步配额"}
        </button>
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
  const [contextLimit, setContextLimit] = useState(200000);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const config: ProviderConfig = {
        id: `${providerType}-${Date.now()}`,
        name: name || providerType,
        type: providerType,
        enabled: true,
        auth: {
          type: providerType,
          authMethod,
        } as any,
        contextLimitOverride: contextLimit,
      };

      if (authMethod === "api-key" && apiKey) {
        config.auth.apiKey = apiKey;
      }

      if (providerType === "openai-compatible") {
        (config.auth as any).baseUrl = baseUrl;
      }

      await onSubmit(config);
      // 重置表单
      setName("");
      setApiKey("");
      setBaseUrl("");
      setContextLimit(200000);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.modal}>
      <div className={styles.modalContent}>
        <h2>添加 Provider</h2>
        <form onSubmit={handleSubmit}>
          <div className={styles.formGroup}>
            <label>Provider 类型</label>
            <select value={providerType} onChange={(e) => setProviderType(e.target.value as ProviderType)}>
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
            <label>显示名称</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={providerType} />
          </div>

          {providerType !== "openai-compatible" && (
            <>
              <div className={styles.formGroup}>
                <label>认证方式</label>
                <select value={authMethod} onChange={(e) => setAuthMethod(e.target.value as any)}>
                  <option value="api-key">API Key</option>
                  <option value="oauth2">OAuth 2.0</option>
                </select>
              </div>

              {authMethod === "api-key" && (
                <div className={styles.formGroup}>
                  <label>API Key</label>
                  <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="输入 API Key" />
                </div>
              )}
            </>
          )}

          {providerType === "openai-compatible" && (
            <div className={styles.formGroup}>
              <label>Base URL</label>
              <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8317" />
            </div>
          )}

          <div className={styles.formGroup}>
            <label>Context Limit (tokens)</label>
            <input type="number" value={contextLimit} onChange={(e) => setContextLimit(parseInt(e.target.value))} min={1024} step={1024} />
          </div>

          <div className={styles.modalFooter}>
            <button type="button" onClick={onClose} className={styles.btnSecondary}>
              取消
            </button>
            <button type="submit" disabled={loading} className={styles.btnPrimary}>
              {loading ? "添加中..." : "添加"}
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
    loadProviders();
    const interval = setInterval(() => loadProviders(), 30000); // 每 30 秒刷新
    return () => clearInterval(interval);
  }, []);

  const loadProviders = async () => {
    try {
      const result = await window.desktop.invoke("provider:list-configs", {});
      setConfigs(result || []);

      // 加载每个 Provider 的状态
      const newStatuses = new Map<string, ProviderStatus>();
      for (const config of result || []) {
        const status = await window.desktop.invoke("provider:get-status", { id: config.id });
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
    try {
      await window.desktop.invoke("provider:add-config", { config });
      await loadProviders();
    } catch (err) {
      console.error("Failed to add provider:", err);
    }
  };

  const handleDeleteProvider = async (id: string) => {
    if (!confirm("确定要删除此 Provider 吗？")) return;
    try {
      await window.desktop.invoke("provider:delete-config", { id });
      await loadProviders();
    } catch (err) {
      console.error("Failed to delete provider:", err);
    }
  };

  const handleTestAuth = async (id: string) => {
    try {
      const result = await window.desktop.invoke("provider:test-auth", { id });
      alert(result.message || (result.ok ? "认证成功" : "认证失败"));
      if (result.ok) {
        await loadProviders();
      }
    } catch (err) {
      alert(`认证错误: ${err}`);
    }
  };

  const handleSyncQuota = async (id: string) => {
    try {
      const result = await window.desktop.invoke("provider:sync-quota", { id });
      if (result.ok) {
        await loadProviders();
      } else {
        alert(`配额同步失败: ${result.error}`);
      }
    } catch (err) {
      alert(`配额同步错误: ${err}`);
    }
  };

  if (loading) {
    return <div className={styles.container}>加载中...</div>;
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Provider 管理</h1>
        <button onClick={() => setShowModal(true)} className={styles.btnPrimary}>
          + 添加 Provider
        </button>
      </div>

      <div className={styles.grid}>
        {configs.map((config) => (
          <ProviderCard
            key={config.id}
            config={config}
            status={statuses.get(config.id)}
            onEdit={() => {}} // TODO: 实现编辑
            onDelete={handleDeleteProvider}
            onTestAuth={handleTestAuth}
            onSyncQuota={handleSyncQuota}
          />
        ))}
      </div>

      {configs.length === 0 && <div className={styles.empty}>未添加任何 Provider</div>}

      <AddProviderModal isOpen={showModal} onClose={() => setShowModal(false)} onSubmit={handleAddProvider} />
    </div>
  );
}
