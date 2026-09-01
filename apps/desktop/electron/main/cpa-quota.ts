import type { ModelQuotaWindow } from "@claude-desktop/shared";

export type ParsedQuota = {
  observedAt?: number;
  windows: ModelQuotaWindow[];
  plan?: string;
  creditsBalance?: number;
};

type Observation = { observed_at?: unknown; signals?: unknown };

function finite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : undefined;
}

function epochMs(value: unknown): number | undefined {
  const n = finite(value);
  if (n != null) return n < 10_000_000_000 ? n * 1000 : n;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedSignals(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
}

function labelForMinutes(minutes: number | undefined, fallback: string): string {
  if (minutes == null) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function parseCpaQuotaObservation(
  provider: string,
  observation: Observation | null | undefined,
): ParsedQuota | null {
  const signals = normalizedSignals(observation?.signals);
  if (Object.keys(signals).length === 0) return null;
  const observedAt = epochMs(observation?.observed_at);
  const normalizedProvider = provider.trim().toLowerCase();

  if (normalizedProvider === "claude") {
    const windows: ModelQuotaWindow[] = [];
    for (const [suffix, label] of [["5h", "5h"], ["7d", "7d"]] as const) {
      const utilization = finite(signals[`anthropic-ratelimit-unified-${suffix}-utilization`]);
      if (utilization == null) continue;
      windows.push({
        label,
        usedPercent: Math.max(0, Math.min(100, utilization * 100)),
        resetAt: epochMs(signals[`anthropic-ratelimit-unified-${suffix}-reset`]),
      });
    }
    return windows.length ? { observedAt, windows } : null;
  }

  if (normalizedProvider === "codex") {
    const active = (signals["x-codex-active-limit"] ?? "")
      .toLowerCase()
      .replace(/^codex[_-]/, "");
    type Acc = Partial<Record<"used" | "minutes" | "resetAt" | "resetAfter", number>>;
    const groups = new Map<string, Acc>();
    const pattern = /^x-codex-(?:(.+)-)?(primary|secondary)-(used-percent|window-minutes|reset-at|reset-after-seconds)$/;
    for (const [key, value] of Object.entries(signals)) {
      const match = key.match(pattern);
      if (!match) continue;
      const namespace = (match[1] ?? "").replace(/^codex[_-]/, "");
      if (namespace && active && namespace !== active) continue;
      const id = `${namespace}:${match[2]}`;
      const acc = groups.get(id) ?? {};
      const n = finite(value);
      if (n == null) continue;
      const field = match[3];
      if (field === "used-percent") acc.used = n;
      else if (field === "window-minutes") acc.minutes = n;
      else if (field === "reset-at") acc.resetAt = n;
      else acc.resetAfter = n;
      groups.set(id, acc);
    }
    const preferredNamespace = active && [...groups.keys()].some((key) => key.startsWith(`${active}:`))
      ? active
      : "";
    const windows: ModelQuotaWindow[] = [];
    for (const kind of ["primary", "secondary"] as const) {
      const acc = groups.get(`${preferredNamespace}:${kind}`);
      if (acc?.used == null) continue;
      windows.push({
        label: labelForMinutes(acc.minutes, kind === "primary" ? "Primary" : "Secondary"),
        usedPercent: Math.max(0, Math.min(100, acc.used)),
        windowMinutes: acc.minutes,
        resetAt: acc.resetAt != null
          ? epochMs(acc.resetAt)
          : acc.resetAfter != null
            ? Date.now() + acc.resetAfter * 1000
            : undefined,
      });
    }
    if (!windows.length) return null;
    return {
      observedAt,
      windows,
      plan: signals["x-codex-plan-type"],
      creditsBalance: finite(signals["x-codex-credits-balance"]),
    };
  }

  return null;
}
