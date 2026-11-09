import React, { useEffect, useState } from "react";
import type { ProviderConfig, ProviderStatus, QuotaInfo } from "@claude-desktop/shared";
import styles from "./ProviderDashboard.module.css";

interface DashboardData {
  providers: Array<ProviderConfig & { status: ProviderStatus }>;
  totalQuota: number;
  usedQuota: number;
  totalCost?: number;
}

export function ProviderDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadDashboardData();
    const interval = setInterval(() => loadDashboardData(), 60000); // 每分钟刷新
    return () => clearInterval(interval);
  }, []);

  const loadDashboardData = async () => {
    try {
      const configs = (await window.desktop.invoke("provider:list-configs", {})) || [];

      let totalQuota = 0;
      let usedQuota = 0;
      const providerData: Array<ProviderConfig & { status: ProviderStatus }> = [];

      for (const config of configs) {
        const status = (await window.desktop.invoke("provider:get-status", { id: config.id })) as ProviderStatus;
        if (status && config.enabled) {
          providerData.push({ ...config, status });
          if (status.quota?.limitTokens) {
            totalQuota += status.quota.limitTokens;
          }
          if (status.quota?.usedQuota) {
            usedQuota += status.quota.usedQuota;
          }
        }
      }

      setData({
        providers: providerData,
        totalQuota,
        usedQuota,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadDashboardData();
    setRefreshing(false);
  };

  if (loading) {
    return <div className={styles.container}>加载中...</div>;
  }

  if (!data) {
    return <div className={styles.container}>无数据</div>;
  }

  const usagePercent = data.totalQuota > 0 ? (data.usedQuota / data.totalQuota) * 100 : 0;
  const isWarning = usagePercent >= 80;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Provider 仪表盘</h1>
        <button onClick={handleRefresh} disabled={refreshing} className={styles.refreshBtn}>
          {refreshing ? "刷新中..." : "🔄 刷新"}
        </button>
      </div>

      {/* 总体概览 */}
      <div className={styles.summary}>
        <div className={styles.card}>
          <h2>总上下文窗口</h2>
          <p className={styles.value}>{(data.totalQuota / 1e6).toFixed(1)}M tokens</p>
          <p className={styles.subtext}>跨所有 Providers</p>
        </div>

        <div className={styles.card}>
          <h2>已使用</h2>
          <p className={`${styles.value} ${isWarning ? styles.warning : ""}`}>{(data.usedQuota / 1e6).toFixed(1)}M tokens</p>
          <p className={styles.subtext}>{usagePercent.toFixed(1)}% 使用率</p>
        </div>

        <div className={styles.card}>
          <h2>剩余</h2>
          <p className={styles.value}>{((data.totalQuota - data.usedQuota) / 1e6).toFixed(1)}M tokens</p>
          <p className={styles.subtext}>可用</p>
        </div>
      </div>

      {/* 使用率进度条 */}
      <div className={styles.progressSection}>
        <div className={styles.progressHeader}>
          <h3>总体使用率</h3>
          <span className={`${styles.percent} ${isWarning ? styles.warning : ""}`}>{usagePercent.toFixed(1)}%</span>
        </div>
        <div className={styles.progressBar}>
          <div
            className={`${styles.progressFill} ${isWarning ? styles.warning : ""}`}
            style={{ width: `${Math.min(usagePercent, 100)}%` }}
          />
        </div>
        {isWarning && <div className={styles.alert}>⚠️ 使用率已达 80%，建议关注配额消耗</div>}
      </div>

      {/* Provider 详情 */}
      <div className={styles.providersSection}>
        <h2>各 Provider 详情</h2>
        <div className={styles.providersList}>
          {data.providers.map((prov) => {
            const quota = prov.status.quota;
            const provUsagePercent = quota?.limitTokens ? (quota.usedQuota || 0) / quota.limitTokens : 0;
            const provWarning = provUsagePercent >= 0.8;

            return (
              <div key={prov.id} className={styles.providerCard}>
                <div className={styles.providerHeader}>
                  <div>
                    <h4>{prov.name}</h4>
                    <p className={styles.type}>{prov.type}</p>
                  </div>
                  <span className={prov.status.authenticated ? styles.authenticated : styles.notAuthenticated}>
                    {prov.status.authenticated ? "✓" : "✗"}
                  </span>
                </div>

                {quota && (
                  <div className={styles.providerBody}>
                    <div className={styles.quotaRow}>
                      <span>Limit:</span>
                      <strong>{(quota.limitTokens! / 1e6).toFixed(1)}M tokens</strong>
                    </div>
                    <div className={styles.quotaRow}>
                      <span>Used:</span>
                      <strong>{((quota.usedQuota || 0) / 1e6).toFixed(1)}M tokens</strong>
                    </div>

                    <div className={styles.miniProgressBar}>
                      <div
                        className={`${styles.miniProgressFill} ${provWarning ? styles.warning : ""}`}
                        style={{ width: `${Math.min(provUsagePercent * 100, 100)}%` }}
                      />
                    </div>
                    <p className={styles.usagePercent}>{(provUsagePercent * 100).toFixed(1)}% 使用</p>

                    {quota.syncedAt && (
                      <p className={styles.syncedTime}>Last synced: {new Date(quota.syncedAt).toLocaleString()}</p>
                    )}
                  </div>
                )}

                {prov.status.lastError && <div className={styles.error}>{prov.status.lastError}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {data.providers.length === 0 && <div className={styles.empty}>未添加任何 Provider</div>}
    </div>
  );
}
