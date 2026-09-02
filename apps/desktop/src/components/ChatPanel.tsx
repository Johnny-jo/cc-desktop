import React, { useCallback, useEffect, useRef, useState } from "react";
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
  const activeRunning = active?.status === "running";
  const showBanner =
    Boolean(activeSessionId) &&
    Boolean(ctx) &&
    ctx!.ratio >= 0.8 &&
    !bannerDismissed[activeSessionId!];

  const quotaRequestId = useRef(0);
  const previousRun = useRef<{ sessionId: string | null; running: boolean }>({
    sessionId: null,
    running: false,
  });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const refreshQuota = useCallback(() => {
    const requestId = ++quotaRequestId.current;
    if (!quotaModel || !hasDesktopApi("getModelQuota")) {
      setModelQuota(null);
      return;
    }
    void getDesktop().getModelQuota(quotaModel).then(
      (quota) => {
        if (requestId !== quotaRequestId.current) return;
        setModelQuota(quota);
      },
      () => {
        // A transient CPA/upstream failure must not erase the last good bar.
      },
    );
  }, [quotaModel]);

  useEffect(() => {
    setModelQuota((current) => current?.modelId === quotaModel ? current : null);
    refreshQuota();
    const timer = window.setInterval(refreshQuota, 60_000);
    return () => window.clearInterval(timer);
  }, [quotaModel, refreshQuota]);

  useEffect(() => {
    const previous = previousRun.current;
    if (
      previous.sessionId === activeSessionId &&
      previous.running &&
      !activeRunning
    ) {
      // Generation responses carry the newest provider quota observations.
      // Pull exactly once on the running -> idle/error transition.
      refreshQuota();
    }
    previousRun.current = { sessionId: activeSessionId, running: activeRunning };
  }, [activeRunning, activeSessionId, refreshQuota]);

  // Track composer height so the transcript can scroll full-height behind the
  // frosted composer overlay while keeping bottom room to clear it.
  useEffect(() => {
    const panel = panelRef.current;
    const composer = composerRef.current;
    if (!panel || !composer) return;
    const update = () => {
      panel.style.setProperty("--composer-h", `${composer.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(composer);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="chat-panel" ref={panelRef}>
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

      <div className="chat-composer" ref={composerRef}>
        <div className="chat-inner">
          <Composer onOpenSettings={onOpenSettings} />
        </div>
      </div>
    </div>
  );
}
