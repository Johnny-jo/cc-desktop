import React, { useEffect, useState } from "react";
import type { SessionSummary } from "@claude-desktop/shared";
import { useI18n } from "../i18n/useI18n";
import { getDesktop } from "../lib/desktop-api";

export function ContextCompressionNotice({ sessionId, status, running }: {
  sessionId: string;
  status?: SessionSummary["contextCompression"];
  running: boolean;
}) {
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  useEffect(() => { setError(null); setDismissedAt(null); }, [sessionId, status?.updatedAt]);
  if (!status || status.updatedAt === dismissedAt) return null;
  const busy = retrying || status.state === "running";
  const retry = async () => {
    if (running || busy) return;
    setRetrying(true); setError(null);
    try {
      const result = await getDesktop().compressSession(sessionId, undefined, { autoContinue: false });
      if (!result.ok) setError(result.message ?? t.common.error);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setRetrying(false); }
  };
  return (
    <div className={`context-banner context-compression-notice${status.state === "failed" ? " context-banner-warn" : ""}`} role="status" aria-live="polite">
      <div className="context-banner-text">
        {busy ? t.chat.contextCompressing : status.state === "completed" ? t.chat.contextCompressed : t.chat.contextCompressionFailed}
        {busy && status.batch && <span className="context-compression-reason">{t.chat.contextCompressionBatch.replace("{batch}", String(status.batch))}</span>}
        {(error || status.message) && <span className="context-compression-reason">{error || status.message}</span>}
      </div>
      {status.state === "failed" && <button type="button" className="btn btn-ghost btn-sm" disabled={running || busy} onClick={() => void retry()}>{t.chat.contextCompressionRetry}</button>}
      {!busy && <button type="button" className="btn btn-ghost btn-sm" aria-label={t.common.close} onClick={() => setDismissedAt(status.updatedAt)}>×</button>}
    </div>
  );
}
