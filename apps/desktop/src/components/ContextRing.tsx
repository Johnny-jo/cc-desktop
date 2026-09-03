import type { ContextUsage } from "@claude-desktop/shared";
import { formatContextUsageLine } from "../lib/format-usage";
import { useI18n } from "../i18n/useI18n";

const RING_R = 7;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Composer 里的上下文用量圆环：灰轨道 + 黑色进度弧（-90° 起笔）。
 * hover 弹出用量明细；无数据时只显示空环。
 */
export function ContextRing({ usage }: { usage?: ContextUsage | null }) {
  const { t } = useI18n();
  const ratio = usage ? Math.max(0, Math.min(1, usage.ratio)) : 0;
  return (
    <span
      className="context-ring"
      tabIndex={0}
      role="img"
      aria-label={t.chat.contextUsage}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle className="context-ring-track" cx="9" cy="9" r={RING_R} />
        <circle
          className="context-ring-fill"
          cx="9"
          cy="9"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - ratio)}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="context-ring-popover">
        <strong>{usage ? formatContextUsageLine(usage) : "—"}</strong>
        {usage ? <span>{usage.modelId}</span> : null}
      </span>
    </span>
  );
}
