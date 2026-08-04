import type { ContextUsage, SessionUsage, TurnUsage } from "@claude-desktop/shared";

export type ContextLevel = "ok" | "warn" | "danger";

export function contextLevel(ratio: number): ContextLevel {
  if (ratio >= 0.95) return "danger";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

export function formatContextPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return "—";
  const pct = ratio * 100;
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

export function formatContextUsageLine(u: ContextUsage): string {
  return `${formatContextPercent(u.ratio)} · ${formatTokens(u.usedTokens)}/${formatTokens(u.limitTokens)}`;
}

export function contextMeterTitle(u: ContextUsage): string {
  return [
    u.modelId,
    `source=${u.source}`,
    `${u.usedTokens} / ${u.limitTokens}`,
    `ratio=${u.ratio.toFixed(3)}`,
  ].join(" · ");
}

export function formatDuration(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function formatTokens(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatCost(usd?: number): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function formatTurnUsageLine(u: TurnUsage): string {
  const parts: string[] = [];
  if (u.durationMs != null) parts.push(formatDuration(u.durationMs));
  const inT = u.inputTokens;
  const outT = u.outputTokens;
  if (inT != null || outT != null) {
    parts.push(
      `↑${formatTokens(inT ?? 0)} ↓${formatTokens(outT ?? 0)} tok`,
    );
  }
  if (u.costUsd != null && u.costUsd > 0) {
    parts.push(formatCost(u.costUsd));
  }
  return parts.join(" · ") || "—";
}

export function formatSessionUsageLine(u?: SessionUsage): string | null {
  if (!u || u.turns === 0) return null;
  const parts: string[] = [];
  parts.push(`${u.turns} turn${u.turns === 1 ? "" : "s"}`);
  if (u.durationMs > 0) parts.push(formatDuration(u.durationMs));
  if (u.inputTokens > 0 || u.outputTokens > 0) {
    parts.push(
      `↑${formatTokens(u.inputTokens)} ↓${formatTokens(u.outputTokens)}`,
    );
  }
  if (u.costUsd > 0) parts.push(formatCost(u.costUsd));
  return parts.join(" · ");
}
