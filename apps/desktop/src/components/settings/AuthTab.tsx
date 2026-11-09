import React, { useEffect, useState } from "react";
import type { AuthFileEntry } from "@claude-desktop/shared";
import { getDesktop } from "../../lib/desktop-api";
import { useI18n } from "../../i18n/useI18n";
import { ToggleSwitch } from "../ToggleSwitch";
import "./AuthTab.css";

export function AuthTab() {
  const i18n = useI18n();
  const desktop = getDesktop();
  const [entries, setEntries] = useState<AuthFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAuthEntries();
  }, []);

  async function loadAuthEntries() {
    setLoading(true);
    setError(null);
    try {
      const result = await desktop.authList();
      setEntries(result || []);
    } catch (err) {
      console.error("[AuthTab] failed to load entries:", err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("确定要删除这个认证文件吗？")) {
      return;
    }
    try {
      const result = await desktop.authDelete(id);
      if (!result.ok) {
        setError(result.error || "删除失败");
        return;
      }
      await loadAuthEntries();
    } catch (err) {
      console.error("[AuthTab] delete failed:", err);
      setError(String(err));
    }
  }

  async function handleToggleDisabled(id: string, disabled: boolean) {
    try {
      const result = await desktop.authSetDisabled(id, disabled);
      if (!result.ok) {
        setError(result.error || "更新失败");
        return;
      }
      await loadAuthEntries();
    } catch (err) {
      console.error("[AuthTab] toggle disabled failed:", err);
      setError(String(err));
    }
  }

  async function handleRefreshQuota(id: string) {
    try {
      const result = await desktop.authRefreshQuota(id);
      if (!result.ok) {
        setError(result.error || "刷新失败");
        return;
      }
      await loadAuthEntries();
    } catch (err) {
      console.error("[AuthTab] refresh quota failed:", err);
      setError(String(err));
    }
  }

  if (loading) {
    return (
      <div className="auth-tab loading">
        <p>加载中...</p>
      </div>
    );
  }

  return (
    <div className="auth-tab">
      <div className="auth-tab__header">
        <h2>认证文件</h2>
        <p className="auth-tab__description">
          管理本地保存的 API 密钥和访问令牌。
        </p>
      </div>

      {error && (
        <div className="auth-tab__error">
          <p>{error}</p>
          <button onClick={() => setError(null)}>关闭</button>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="auth-tab__empty">
          <p>还没有保存任何认证文件。</p>
          <p className="auth-tab__empty-hint">
            认证文件将在你通过 OAuth 登录或手动添加后出现在这里。
          </p>
        </div>
      ) : (
        <div className="auth-tab__list">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`auth-tab__item ${entry.disabled ? "disabled" : ""}`}
            >
              <div className="auth-tab__item-header">
                <div className="auth-tab__item-title">
                  <div className="auth-tab__item-name">{entry.name}</div>
                  <div className="auth-tab__item-provider">{entry.provider}</div>
                </div>
                <div className="auth-tab__item-controls">
                  <button
                    className="auth-tab__button auth-tab__button-quota"
                    onClick={() => handleRefreshQuota(entry.id)}
                    title="刷新配额"
                  >
                    ⟳ 刷新
                  </button>
                  <div className="auth-tab__toggle">
                    <ToggleSwitch
                      checked={!entry.disabled}
                      onCheckedChange={(checked) =>
                        handleToggleDisabled(entry.id, !checked)
                      }
                      label={entry.disabled ? "已禁用" : "已启用"}
                    />
                  </div>
                  <button
                    className="auth-tab__button auth-tab__button-delete"
                    onClick={() => handleDelete(entry.id)}
                    title="删除"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {entry.savedAt && (
                <div className="auth-tab__item-meta">
                  <span>保存于: {new Date(entry.savedAt).toLocaleString()}</span>
                </div>
              )}

              {entry.quotaCache && (
                <div className="auth-tab__item-quota">
                  <span className="auth-tab__quota-label">配额缓存:</span>
                  <span className="auth-tab__quota-time">
                    {new Date(entry.quotaCache.observedAt).toLocaleString()}
                  </span>
                  {entry.quotaCache.windows.length > 0 && (
                    <ul className="auth-tab__quota-windows">
                      {entry.quotaCache.windows.map((w, idx) => (
                        <li key={idx}>
                          {w.label}: {Math.round(w.usedPercent)}%
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
