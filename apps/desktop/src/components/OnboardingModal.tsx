import React, { useState } from "react";
import { completeOnboarding } from "../state/store";
import { useI18n } from "../i18n/useI18n";
import { ProviderSettings } from "./ProviderSettings";

/** First-run account setup; service credentials are managed by ProviderSettings. */
export function OnboardingModal({ open }: { open: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await completeOnboarding("", false);
      if (!result.ok) setError(result.error || "设置保存失败，请重试");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay onboarding-overlay">
      <div className="modal onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="modal-header">
          <span className="modal-title" id="onboarding-title">{t.onboarding.title}</span>
        </div>
        <div className="modal-body">
          <p className="onboarding-lead">{t.onboarding.welcomeLead}</p>
          <ProviderSettings />
          <p className="settings-hint">使用 API Key 或 OAuth 登录模型服务账号。你也可以完成设置后再到「Provider 管理」添加账号。</p>
          {error && <p className="settings-error" role="alert">{error}</p>}
        </div>
        <div className="modal-actions onboarding-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onConfirm}>
            {busy ? "保存设置中…" : "完成设置"}
          </button>
        </div>
      </div>
    </div>
  );
}
