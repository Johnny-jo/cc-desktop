import type { ModelQuotaWindow } from "@claude-desktop/shared";

export type ParsedQuota = {
  observedAt?: number;
  windows: ModelQuotaWindow[];
  plan?: string;
  creditsBalance?: number;
};

type Observation = {
  observed_at?: unknown;
  signals?: unknown;
  [key: string]: unknown;
};

type UnknownRecord = Record<string, unknown>;

function finite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : undefined;
}

function epochMs(value: unknown): number | undefined {
  // Numeric epoch (seconds or ms). parseFloat must not be used here: it would
  // read the leading year out of an ISO string like "2026-09-01T05:00:00Z"
  // and turn it into 2026s after the Unix epoch — i.e. a 1970 date.
  const n = typeof value === "number"
    ? value
    : /^-?\d+(?:\.\d+)?$/.test(String(value ?? "").trim())
      ? Number(String(value).trim())
      : undefined;
  if (n != null && Number.isFinite(n)) return n < 10_000_000_000 ? n * 1000 : n;
  if (typeof value === "number") return undefined;
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

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function text(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function firstValue(source: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function relativeResetAt(source: UnknownRecord, now: number): number | undefined {
  const absolute = firstValue(source, ["reset_at", "resetAt", "reset_time", "resetTime"]);
  const parsedAbsolute = epochMs(absolute);
  if (parsedAbsolute != null) return parsedAbsolute;
  const seconds = finite(firstValue(source, ["reset_in", "resetIn", "ttl"]));
  return seconds != null && seconds > 0 ? now + seconds * 1000 : undefined;
}

function minutesFromDuration(duration: unknown, unit: unknown): number | undefined {
  const amount = finite(duration);
  if (amount == null || amount <= 0) return undefined;
  const normalized = String(unit ?? "minute")
    .trim()
    .toLowerCase()
    .replace(/^time_unit_/, "")
    .replace(/s$/, "");
  if (normalized === "second") return amount / 60;
  if (normalized === "hour") return amount * 60;
  if (normalized === "day") return amount * 1440;
  if (normalized === "week") return amount * 10080;
  return amount;
}

function inferredMinutes(label: string): number | undefined {
  const normalized = label.toLowerCase();
  if (normalized.includes("weekly") || normalized.includes("week")) return 10080;
  if (normalized.includes("monthly") || normalized.includes("month")) return 43200;
  if (normalized.includes("daily") || normalized.includes("day")) return 1440;
  const hours = normalized.match(/(?:^|\D)(\d+(?:\.\d+)?)\s*h(?:our)?/);
  if (hours) return Number(hours[1]) * 60;
  return undefined;
}

export function normalizeQuotaProvider(provider: unknown): string {
  const normalized = String(provider ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "x-ai" || normalized === "grok") return "xai";
  return normalized;
}

function parseKimiQuota(payload: UnknownRecord, now: number): ParsedQuota | null {
  const windows: ModelQuotaWindow[] = [];
  const append = (
    source: UnknownRecord,
    fallbackLabel: string,
    duration?: unknown,
    unit?: unknown,
  ) => {
    const limit = finite(source.limit);
    let used = finite(source.used);
    const remaining = finite(source.remaining);
    if (used == null && limit != null && remaining != null) used = limit - remaining;
    if (limit == null || limit <= 0 || used == null) return;
    const label = text(source.name) ?? text(source.title) ?? fallbackLabel;
    const windowMinutes = minutesFromDuration(duration, unit) ?? inferredMinutes(label);
    windows.push({
      label,
      usedPercent: clampPercent(used / limit * 100),
      resetAt: relativeResetAt(source, now),
      ...(windowMinutes != null ? { windowMinutes } : {}),
    });
  };

  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  limits.forEach((raw, index) => {
    const item = record(raw);
    if (!item) return;
    const detail = record(item.detail) ?? item;
    const window = record(item.window) ?? {};
    const duration = firstValue(window, ["duration"])
      ?? firstValue(item, ["duration"])
      ?? firstValue(detail, ["duration"]);
    const unit = firstValue(window, ["timeUnit", "time_unit"])
      ?? firstValue(item, ["timeUnit", "time_unit"])
      ?? firstValue(detail, ["timeUnit", "time_unit"]);
    const label = text(item.name) ?? text(item.title) ?? text(item.scope)
      ?? labelForMinutes(minutesFromDuration(duration, unit), `Limit ${index + 1}`);
    append(detail, label, duration, unit);
  });

  const usage = record(payload.usage);
  if (usage) append(usage, "Weekly");
  return windows.length ? { observedAt: now, windows } : null;
}

function parseXaiQuota(payload: UnknownRecord, now: number): ParsedQuota | null {
  const billing = record(payload.billing) ?? payload;
  if (billing.mode === "paid-health") return null;
  const config = record(billing.config) ?? billing;
  const period = record(firstValue(config, ["currentPeriod", "current_period"]));
  const periodType = text(period?.type)?.toLowerCase() ?? text(config.periodType)?.toLowerCase();
  const label = periodType?.includes("week")
    ? "Weekly"
    : periodType?.includes("month") ? "Monthly" : "Billing";
  const resetAt = epochMs(period?.end ?? config.periodEnd ?? config.billingPeriodEnd
    ?? config.billing_period_end ?? config.resetAtMs);
  const startAt = epochMs(period?.start ?? config.periodStart ?? config.billingPeriodStart
    ?? config.billing_period_start);
  const windowMinutes = resetAt != null && startAt != null && resetAt > startAt
    ? (resetAt - startAt) / 60_000
    : inferredMinutes(label);
  const windows: ModelQuotaWindow[] = [];
  const overall = finite(firstValue(config, [
    "creditUsagePercent",
    "credit_usage_percent",
    "usagePercent",
    "usedPercent",
  ]));
  if (overall != null) {
    windows.push({
      label,
      usedPercent: clampPercent(overall),
      resetAt,
      ...(windowMinutes != null ? { windowMinutes } : {}),
    });
  }

  const products = firstValue(config, ["productUsage", "product_usage"]);
  if (Array.isArray(products)) {
    products.forEach((raw, index) => {
      const item = record(raw);
      if (!item) return;
      const usedPercent = finite(firstValue(item, ["usagePercent", "usage_percent"]));
      if (usedPercent == null) return;
      windows.push({
        label: text(item.product) ?? `Product ${index + 1}`,
        usedPercent: clampPercent(usedPercent),
        resetAt,
        ...(windowMinutes != null ? { windowMinutes } : {}),
      });
    });
  }

  if (!windows.length) {
    const limitValue = firstValue(config, ["monthlyLimit", "monthly_limit"]);
    const usedValue = config.used;
    const limit = finite(record(limitValue)?.val ?? limitValue);
    const used = finite(record(usedValue)?.val ?? usedValue);
    if (limit != null && limit > 0 && used != null) {
      windows.push({
        label,
        usedPercent: clampPercent(used / limit * 100),
        resetAt,
        ...(windowMinutes != null ? { windowMinutes } : {}),
      });
    }
  }
  return windows.length ? { observedAt: now, windows, plan: text(config.planType) } : null;
}

function parseAntigravityQuota(payload: UnknownRecord, now: number): ParsedQuota | null {
  const windows: ModelQuotaWindow[] = [];
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  groups.forEach((rawGroup, groupIndex) => {
    const group = record(rawGroup);
    if (!group) return;
    const groupLabel = text(group.displayName) ?? text(group.display_name)
      ?? `Quota Group ${groupIndex + 1}`;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    buckets.forEach((rawBucket, bucketIndex) => {
      const bucket = record(rawBucket);
      if (!bucket) return;
      const remaining = finite(firstValue(bucket, ["remainingFraction", "remaining_fraction"]));
      if (remaining == null) return;
      const bucketLabel = text(bucket.displayName) ?? text(bucket.display_name)
        ?? text(bucket.window) ?? `Limit ${bucketIndex + 1}`;
      const rawWindow = text(bucket.window);
      const windowMinutes = rawWindow ? inferredMinutes(rawWindow) : undefined;
      windows.push({
        label: `${groupLabel} · ${bucketLabel}`,
        usedPercent: clampPercent((1 - remaining) * 100),
        resetAt: epochMs(firstValue(bucket, ["resetTime", "reset_time"])),
        ...(windowMinutes != null ? { windowMinutes } : {}),
      });
    });
  });

  // Older Antigravity endpoints expose model quota directly instead of groups.
  const models = record(payload.models);
  if (!windows.length && models) {
    for (const [model, raw] of Object.entries(models)) {
      const info = record(raw);
      const quota = record(info?.quotaInfo ?? info?.quota_info);
      if (!quota) continue;
      const remaining = finite(firstValue(quota, ["remainingFraction", "remaining_fraction"]));
      if (remaining == null) continue;
      windows.push({
        label: text(info?.displayName) ?? text(info?.display_name) ?? model,
        usedPercent: clampPercent((1 - remaining) * 100),
        resetAt: epochMs(firstValue(quota, ["resetTime", "reset_time"])),
      });
    }
  }
  const subscription = record(payload.subscription);
  return windows.length
    ? { observedAt: now, windows, plan: text(subscription?.plan ?? payload.plan) }
    : null;
}

/** Parse provider quota returned by CPA's allowlisted management api-call proxy. */
export function parseCpaQuotaPayload(
  provider: string,
  payload: unknown,
  now = Date.now(),
): ParsedQuota | null {
  const parsed = typeof payload === "string"
    ? (() => {
        try { return record(JSON.parse(payload)); } catch { return null; }
      })()
    : record(payload);
  if (!parsed) return null;
  const normalizedProvider = normalizeQuotaProvider(provider);
  if (normalizedProvider === "kimi") return parseKimiQuota(parsed, now);
  if (normalizedProvider === "xai") return parseXaiQuota(parsed, now);
  if (normalizedProvider === "antigravity") return parseAntigravityQuota(parsed, now);
  return null;
}

export function parseCpaQuotaObservation(
  provider: string,
  observation: Observation | null | undefined,
): ParsedQuota | null {
  const signals = normalizedSignals(observation?.signals);
  const observedAt = epochMs(observation?.observed_at);
  const normalizedProvider = normalizeQuotaProvider(provider);

  if (
    normalizedProvider === "kimi" ||
    normalizedProvider === "xai" ||
    normalizedProvider === "antigravity"
  ) {
    const activeShape = parseCpaQuotaPayload(normalizedProvider, observation, observedAt ?? Date.now());
    if (activeShape) return activeShape;
  }

  if (Object.keys(signals).length === 0) return null;

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
