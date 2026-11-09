import React, { useEffect, useState } from "react";
import type { ProviderConfig, ProviderStatus } from "@claude-desktop/shared";
import styles from "./ProviderSelector.module.css";

interface ProviderSelectorProps {
  onProviderSelected: (providerId: string) => void;
  currentProviderId?: string;
}

export function ProviderSelector({ onProviderSelected, currentProviderId }: ProviderSelectorProps) {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [statuses, setStatuses] = useState<Map<string, ProviderStatus>>(new Map());
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      const result = (await window.desktop.invoke("provider:list-configs", {})) || [];
      const enabledProviders = result.filter((p) => p.enabled);
      setConfigs(enabledProviders);

      const newStatuses = new Map<string, ProviderStatus>();
      for (const config of enabledProviders) {
        const status = (await window.desktop.invoke("provider:get-status", { id: config.id })) as ProviderStatus;
        if (status) {
          newStatuses.set(config.id, status);
        }
      }
      setStatuses(newStatuses);
    } finally {
      setLoading(false);
    }
  };

  const currentConfig = configs.find((c) => c.id === currentProviderId);
  const currentStatus = currentProviderId ? statuses.get(currentProviderId) : undefined;

  const handleSelect = (providerId: string) => {
    onProviderSelected(providerId);
    setIsOpen(false);
  };

  if (loading) {
    return <div className={styles.selector}>加载 Providers...</div>;
  }

  if (configs.length === 0) {
    return (
      <div className={styles.selector}>
        <div className={styles.empty}>未配置 Provider</div>
      </div>
    );
  }

  return (
    <div className={styles.selectorContainer}>
      <button onClick={() => setIsOpen(!isOpen)} className={styles.trigger}>
        <span className={styles.label}>Provider:</span>
        <span className={styles.selected}>
          {currentConfig?.name || "选择 Provider"}
          <span className={`${styles.auth} ${currentStatus?.authenticated ? styles.ok : styles.error}`}>
            {currentStatus?.authenticated ? "✓" : "✗"}
          </span>
        </span>
        <span className={styles.caret}>{isOpen ? "▼" : "▶"}</span>
      </button>

      {isOpen && (
        <div className={styles.menu}>
          {configs.map((config) => {
            const status = statuses.get(config.id);
            const usagePercent =
              status?.quota?.limitTokens && status.quota.usedQuota
                ? (status.quota.usedQuota / status.quota.limitTokens) * 100
                : 0;
            const isWarning = usagePercent >= 80;

            return (
              <div
                key={config.id}
                className={`${styles.item} ${config.id === currentProviderId ? styles.active : ""} ${
                  !status?.authenticated ? styles.disabled : ""
                }`}
                onClick={() => config.id !== currentProviderId && status?.authenticated && handleSelect(config.id)}
              >
                <div className={styles.itemHeader}>
                  <div>
                    <div className={styles.itemName}>{config.name}</div>
                    <div className={styles.itemType}>{config.type}</div>
                  </div>
                  <span className={`${styles.itemAuth} ${status?.authenticated ? styles.ok : styles.error}`}>
                    {status?.authenticated ? "✓ Auth" : "✗ No Auth"}
                  </span>
                </div>

                {status?.quota && (
                  <div className={styles.itemQuota}>
                    <div className={styles.quotaMini}>
                      <span className={styles.quotaLabel}>Limit:</span>
                      <span className={styles.quotaValue}>{(status.quota.limitTokens! / 1e6).toFixed(1)}M</span>
                    </div>
                    <div className={styles.quotaMini}>
                      <span className={styles.quotaLabel}>Used:</span>
                      <span className={`${styles.quotaValue} ${isWarning ? styles.warning : ""}`}>
                        {((status.quota.usedQuota || 0) / 1e6).toFixed(1)}M ({usagePercent.toFixed(0)}%)
                      </span>
                    </div>
                  </div>
                )}

                {status?.lastError && <div className={styles.itemError}>{status.lastError}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
