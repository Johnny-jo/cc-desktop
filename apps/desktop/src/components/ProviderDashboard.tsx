import React, { useEffect, useState } from "react";
import type { ProviderConfig, ProviderStatus } from "@claude-desktop/shared";
import styles from "./ProviderDashboard.module.css";

/**
 * 仪表盘只展示真实存在的量：
 * - 已配置 / 已启用 / 已认证的 provider 数量
 * - 每个 provider 的上下文窗口与可见模型数（窗口查不到就显示「未知」）
 *
 * 不汇总「总上下文窗口」或「已用 token」：不同 provider 的窗口不能相加，
 * 而这些上游也没有可查询的用量接口。
 */
interface ProviderRow {
  config: ProviderConfig;
  status: ProviderStatus | null;
}

function formatTokens(n?: number): string {
  if (!n || !Number.isFinite(n)) return "未知";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

const SOURCE_LABEL: Record<string, string> = {
  api: "上游 /models",
  manual: "手动设置",
  builtin: "内置表",
};

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

  const all = rows ?? [];
  const enabled = all.filter((r) => r.config.enabled);
  const authenticated = all.filter((r) => r.status?.authenticated);
  const unknownLimit = enabled.filter((r) => !r.status?.quota?.limitTokens).length;

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div>
          <h3>Provider 仪表盘</h3>
          <p>查看各 Provider 的认证状态与上下文窗口。窗口由上游模型列表解析，拿不到时显示「未知」。</p>
        </div>
        <button type="button" onClick={handleRefresh} disabled={refreshing} className={styles.refreshBtn}>
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>

      {loading ? (
        <p className={styles.hint}>加载中…</p>
      ) : (
        <>
          <div className={styles.summary}>
            <div className={styles.stat}>
              <span className={styles.statLabel}>已配置</span>
              <span className={styles.statValue}>{all.length}</span>
              <span className={styles.statSub}>其中 {enabled.length} 个已启用</span>
            </div>

            <div className={styles.stat}>
              <span className={styles.statLabel}>已认证</span>
              <span
                className={`${styles.statValue} ${
                  authenticated.length < enabled.length ? styles.statValueWarn : ""
                }`}
              >
                {authenticated.length}
              </span>
              <span className={styles.statSub}>
                {enabled.length > 0 && authenticated.length === 0
                  ? "去下方补凭证"
                  : "凭证可用的 Provider"}
              </span>
            </div>

            <div className={styles.stat}>
              <span className={styles.statLabel}>窗口未知</span>
              <span className={styles.statValue}>{unknownLimit}</span>
              <span className={styles.statSub}>同步一次配额以获取</span>
            </div>
          </div>

          {all.length === 0 ? (
            <div className={styles.empty}>
              <strong>还没有配置任何 Provider</strong>
            </div>
          ) : (
            <div className={styles.list}>
              {all.map(({ config, status }) => {
                const quota = status?.quota;
                const modelCount = status?.availableModels?.length ?? 0;
                return (
                  <div key={config.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <div className={styles.itemIdentity}>
                        <h4 className={styles.itemName} title={config.name}>
                          {config.name}
                        </h4>
                        <span className={styles.itemType}>{config.type}</span>
                      </div>
                      <span
                        className={`${styles.badge} ${
                          status?.authenticated ? styles.badgeOk : styles.badgeWarn
                        }`}
                      >
                        {status?.authenticated ? "已认证" : "未认证"}
                      </span>
                    </div>

                    <dl className={styles.facts}>
                      <div className={styles.fact}>
                        <dt>上下文窗口</dt>
                        <dd>{formatTokens(quota?.limitTokens)}</dd>
                      </div>
                      <div className={styles.fact}>
                        <dt>可见模型</dt>
                        <dd>{modelCount > 0 ? `${modelCount} 个` : "未同步"}</dd>
                      </div>
                      {quota?.source && (
                        <div className={styles.fact}>
                          <dt>窗口来源</dt>
                          <dd>{SOURCE_LABEL[quota.source] ?? quota.source}</dd>
                        </div>
                      )}
                      {quota?.syncedAt && (
                        <div className={styles.fact}>
                          <dt>上次同步</dt>
                          <dd>{new Date(quota.syncedAt).toLocaleString()}</dd>
                        </div>
                      )}
                    </dl>

                    {status?.lastError && <p className={styles.error}>{status.lastError}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
