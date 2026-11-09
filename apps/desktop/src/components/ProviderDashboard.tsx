import React, { useEffect, useState } from "react";
import type { ProviderConfig, ProviderStatus } from "@claude-desktop/shared";
import styles from "./ProviderDashboard.module.css";

/**
 * 仪表盘只展示真实存在的量：
 * - 已配置 / 已启用 / 已认证的 provider 数量
 * - 每个 provider 的模型目录与上下文窗口（窗口可能是「查不到」，那就显示「未知」）
 *
 * 这里不汇总「总上下文窗口」或「已用 token」：不同 provider 的窗口不能相加
 * （相加没有物理意义），而这些上游也没有可查询的用量接口。
 */
interface ProviderRow {
  config: ProviderConfig;
  status: ProviderStatus | null;
}

export function ProviderDashboard() {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadDashboardData = async () => {
    try {
      const configs = (await window.desktop.listProviders()) || [];
      const next: ProviderRow[] = [];
      for (const config of configs) {
        const status = await window.desktop.getProviderStatus(config.id);
        next.push({ config, status });
      }
      setRows(next);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboardData();
    const interval = setInterval(() => void loadDashboardData(), 60000); // 每分钟刷新
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await loadDashboardData();
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return <div className={styles.container}>加载中...</div>;
  }

  const all = rows ?? [];
  const enabled = all.filter((r) => r.config.enabled);
  const authenticated = all.filter((r) => r.status?.authenticated);
  const unknownLimit = enabled.filter((r) => !r.status?.quota?.limitTokens).length;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Provider 仪表盘</h1>
        <button onClick={handleRefresh} disabled={refreshing} className={styles.refreshBtn}>
          {refreshing ? "刷新中..." : "🔄 刷新"}
        </button>
      </div>

      <div className={styles.summary}>
        <div className={styles.card}>
          <h2>已配置</h2>
          <p className={styles.value}>{all.length}</p>
          <p className={styles.subtext}>其中 {enabled.length} 个已启用</p>
        </div>

        <div className={styles.card}>
          <h2>已认证</h2>
          <p className={`${styles.value} ${authenticated.length < enabled.length ? styles.warning : ""}`}>
            {authenticated.length}
          </p>
          <p className={styles.subtext}>
            {enabled.length > 0 && authenticated.length === 0 ? "去「Provider 管理」补凭证" : "凭证可用的 Provider"}
          </p>
        </div>

        <div className={styles.card}>
          <h2>窗口未知</h2>
          <p className={styles.value}>{unknownLimit}</p>
          <p className={styles.subtext}>同步一次配额以获取模型窗口</p>
        </div>
      </div>

      <div className={styles.providersSection}>
        <h2>各 Provider 详情</h2>
        <div className={styles.providersList}>
          {all.map(({ config, status }) => {
            const quota = status?.quota;
            const models = status?.availableModels ?? [];
            return (
              <div key={config.id} className={styles.providerCard}>
                <div className={styles.providerHeader}>
                  <div>
                    <h4>{config.name}</h4>
                    <p className={styles.type}>{config.type}</p>
                  </div>
                  <span className={status?.authenticated ? styles.authenticated : styles.notAuthenticated}>
                    {status?.authenticated ? "✓" : "✗"}
                  </span>
                </div>

                <div className={styles.providerBody}>
                  <div className={styles.quotaRow}>
                    <span>上下文窗口:</span>
                    <strong>
                      {quota?.limitTokens ? `${quota.limitTokens.toLocaleString()} tokens` : "未知"}
                    </strong>
                  </div>
                  <div className={styles.quotaRow}>
                    <span>可见模型:</span>
                    <strong>{models.length > 0 ? `${models.length} 个` : "未同步"}</strong>
                  </div>
                  {quota?.source && (
                    <div className={styles.quotaRow}>
                      <span>来源:</span>
                      <strong>{quota.source === "api" ? "上游 /models" : quota.source === "manual" ? "手动设置" : "内置表"}</strong>
                    </div>
                  )}
                  {quota?.syncedAt && (
                    <p className={styles.syncedTime}>Last synced: {new Date(quota.syncedAt).toLocaleString()}</p>
                  )}
                </div>

                {status?.lastError && <div className={styles.error}>{status.lastError}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {all.length === 0 && <div className={styles.empty}>未添加任何 Provider</div>}
    </div>
  );
}
