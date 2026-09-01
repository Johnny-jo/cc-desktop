import React, { useEffect, useState } from "react";
import type { ChatItem, ModelQuotaInfo, PermissionMode } from "@claude-desktop/shared";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { ThemedSelect } from "./Select";
import { setPermissionMode, useAppStore } from "../state/store";
import { useI18n } from "../i18n/useI18n";
import {
  contextLevel,
  contextMeterTitle,
  formatContextPercent,
  formatContextUsageLine,
  formatTokens,
} from "../lib/format-usage";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";

const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
];

const EMPTY_ITEMS: ChatItem[] = [];

export type ChatPanelProps = {
  onOpenSettings: () => void;
  /** Open a project-relative file in the in-app editor column. */
  onOpenFile?: (rel: string) => void;
};

export function ChatPanel({ onOpenSettings, onOpenFile }: ChatPanelProps) {
  const { t } = useI18n();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const items = useAppStore((s) =>
    s.activeSessionId ? (s.itemsBySession[s.activeSessionId] ?? EMPTY_ITEMS) : EMPTY_ITEMS,
  );
  const hasMore = useAppStore((s) =>
    s.activeSessionId ? Boolean(s.hasMoreBySession[s.activeSessionId]) : false,
  );
  const hasNewer = useAppStore((s) =>
    s.activeSessionId ? Boolean(s.hasNewerBySession[s.activeSessionId]) : false,
  );
  const transcriptLoading = useAppStore(
    (s) => s.loadingSessionId !== null && s.loadingSessionId === s.activeSessionId,
  );
  const sessions = useAppStore((s) => s.sessions);
  const running = useAppStore((s) =>
    s.activeSessionId
      ? s.sessions.some((x) => x.id === s.activeSessionId && x.status === "running")
      : false,
  );
  const settings = useAppStore((s) => s.settings);

  const [bannerDismissed, setBannerDismissed] = useState<Record<string, true>>(
    {},
  );
  const [modelQuota, setModelQuota] = useState<ModelQuotaInfo | null>(null);

  const active = sessions.find((s) => s.id === activeSessionId);
  const ctx = active?.contextUsage;
  const level = ctx ? contextLevel(ctx.ratio) : "ok";
  const fillPct = ctx ? Math.max(0, Math.min(100, ctx.ratio * 100)) : 0;
  const quotaModel = ctx?.modelId ?? settings?.defaultModel ?? "";
  const showBanner =
    Boolean(activeSessionId) &&
    Boolean(ctx) &&
    ctx!.ratio >= 0.8 &&
    !bannerDismissed[activeSessionId!];

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (!quotaModel || !hasDesktopApi("getModelQuota")) {
        setModelQuota(null);
        return;
      }
      void getDesktop().getModelQuota(quotaModel).then(
        (quota) => { if (!cancelled) setModelQuota(quota); },
        () => { if (!cancelled) setModelQuota(null); },
      );
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [quotaModel, active?.updatedAt]);

  return (
    <div className="chat-panel">
      <header className="chat-header">
        <div className="chat-header-left">
          <span className="chat-title">
            {active ? active.title : "New chat"}
          </span>
          {running ? <span className="badge running">running</span> : null}
          {ctx ? (
            <span
              className={`context-meter context-meter-${level}`}
              title={contextMeterTitle(ctx)}
            >
              <span className="context-meter-bar" aria-hidden>
                <span className="context-meter-fill" style={{ width: `${fillPct}%` }} />
              </span>
              <span className="context-meter-label">{formatContextUsageLine(ctx)}</span>
            </span>
          ) : null}
        </div>
        <div className="chat-header-right">
          <label className="chat-header-field">
            <ThemedSelect
              className="select-ghost-wrap"
              value={settings?.permissionMode ?? "default"}
              disabled={!settings}
              onChange={(v) => void setPermissionMode(v as PermissionMode)}
              title="Permission mode"
              options={PERMISSION_MODES.map((m) => ({ value: m }))}
            />
          </label>
        </div>
      </header>

      <div className="chat-body">
        <div className="chat-inner">
          {showBanner && ctx ? (
            <div
              className={`context-banner context-banner-${level}`}
              role="status"
            >
              <div className="context-banner-text">
                {t.common.ok === "OK"
                  ? `Context used ${formatContextPercent(ctx.ratio)} (${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.limitTokens)}). Near the window limit — start a new chat or compact history.`
                  : `上下文已用 ${formatContextPercent(ctx.ratio)}（${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.limitTokens)}）。 接近窗口上限，建议新开对话或压缩历史。`}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  if (!activeSessionId) return;
                  setBannerDismissed((prev) => ({
                    ...prev,
                    [activeSessionId]: true,
                  }));
                }}
              >
                {t.common.ok}
              </button>
            </div>
          ) : null}
          <MessageList
            items={items}
            sessionId={activeSessionId}
            hasMore={hasMore}
            hasNewer={hasNewer}
            loading={transcriptLoading}
            modelQuota={modelQuota}
            onOpenFile={onOpenFile}
          />
        </div>
      </div>

      <div className="chat-composer">
        <div className="chat-inner">
          <Composer onOpenSettings={onOpenSettings} />
        </div>
      </div>
    </div>
  );
}
