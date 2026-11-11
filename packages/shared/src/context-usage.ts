import type {
  ContextLimitSource,
  ContextUsage,
  ModelInfo,
  ReasoningEffort,
} from "./models";

export type ContextLimitSettings = {
  defaultContextLimit: number;
  modelContextLimits: Record<string, number>;
};

type TokenFields = {
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
};

/** Input fields normalized to the disjoint Messages API categories. */
export function extractUsedTokens(source?: TokenFields): number | undefined {
  if (!source) return undefined;
  const counts = [source.inputTokens, source.cacheReadTokens, source.cacheCreationTokens]
    .filter((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  return counts.length ? counts.reduce((sum, count) => sum + count, 0) : undefined;
}

function positiveInt(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n > 0 ? n : undefined;
}

function reasoningEffort(v: unknown): ReasoningEffort | undefined {
  const normalized = typeof v === "string" ? v.trim().toLowerCase() : "";
  return normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "max"
    ? normalized
    : undefined;
}

function reasoningEffortEntry(v: unknown): ReasoningEffort | undefined {
  const direct = reasoningEffort(v);
  if (direct) return direct;
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  return (
    reasoningEffort(o.value) ??
    reasoningEffort(o.effort) ??
    reasoningEffort(o.level) ??
    reasoningEffort(o.name)
  );
}

/** Parse model-specific reasoning capabilities exposed by CPA/OpenAI-style catalogs. */
export function parseModelReasoningEfforts(raw: unknown): ReasoningEffort[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  for (const key of [
    "reasoning_efforts",
    "supported_reasoning_efforts",
    "reasoning_levels",
    "supported_reasoning_levels",
    "reasoningEfforts",
    "supportedReasoningEfforts",
    "reasoningLevels",
    "supportedReasoningLevels",
    "effort_levels",
    "supported_effort_levels",
    "effortLevels",
    "supportedEffortLevels",
    "levels",
  ]) {
    const value = o[key];
    const values = Array.isArray(value) ? value : [value];
    const parsed = values
      .map(reasoningEffortEntry)
      .filter((effort): effort is ReasoningEffort => effort != null);
    if (parsed.length) return [...new Set(parsed)];
  }
  for (const nestKey of ["thinking", "capabilities", "meta", "metadata", "info"]) {
    const parsed = parseModelReasoningEfforts(o[nestKey]);
    if (parsed?.length) return parsed;
  }
  return undefined;
}

/** Parse the model's default reasoning strength from CPA/OpenAI-style catalogs. */
export function parseModelDefaultReasoningEffort(
  raw: unknown,
): ReasoningEffort | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  for (const key of [
    "default_reasoning_effort",
    "default_reasoning_level",
    "reasoning_effort",
    "defaultReasoningEffort",
    "defaultReasoningLevel",
    "reasoningEffort",
  ]) {
    const parsed = reasoningEffort(o[key]);
    if (parsed) return parsed;
  }
  for (const nestKey of ["thinking", "capabilities", "meta", "metadata", "info"]) {
    const parsed = parseModelDefaultReasoningEffort(o[nestKey]);
    if (parsed) return parsed;
  }
  return undefined;
}

/** Pull context window from a CPA / OpenAI-style model object. */
export function parseModelContextLimit(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const direct =
    positiveInt(o.context_length) ??
    positiveInt(o.context_window) ??
    positiveInt(o.max_model_len) ??
    positiveInt(o.contextLength) ??
    positiveInt(o.contextWindow);
  if (direct != null) return direct;

  const maxTok = positiveInt(o.max_tokens) ?? positiveInt(o.maxTokens);
  if (maxTok != null && maxTok >= 1024) return maxTok;

  for (const nestKey of ["meta", "metadata", "info"]) {
    const nested = o[nestKey];
    if (nested && typeof nested === "object") {
      const n = parseModelContextLimit(nested);
      if (n != null) return n;
    }
  }
  return undefined;
}

/** Builtin table — first matching rule wins (case-insensitive substring). */
const BUILTIN_RULES: Array<{ match: RegExp; limit: number }> = [
  { match: /claude|opus|sonnet|haiku|fable/i, limit: 200_000 },
  { match: /gemini/i, limit: 1_000_000 },
  { match: /gpt-4|gpt-5|\bo1\b|\bo3\b|codex/i, limit: 128_000 },
  { match: /k3|moonshot/i, limit: 256_000 },
  { match: /kimi-k\d/i, limit: 256_000 },
  { match: /deepseek/i, limit: 128_000 },
  { match: /grok/i, limit: 128_000 },
];

export function builtinContextLimit(modelId: string): number | undefined {
  for (const rule of BUILTIN_RULES) {
    if (rule.match.test(modelId)) return rule.limit;
  }
  return undefined;
}

export function resolveContextLimit(
  modelId: string,
  settings: ContextLimitSettings,
  catalog: ModelInfo[],
): { limitTokens: number; source: ContextLimitSource } {
  const override = settings.modelContextLimits?.[modelId];
  if (override != null && Number.isFinite(override) && override > 0) {
    return { limitTokens: Math.floor(override), source: "override" };
  }

  const fromCpa = catalog.find((m) => m.id === modelId)?.contextLimit;
  if (fromCpa != null && fromCpa > 0) {
    return { limitTokens: Math.floor(fromCpa), source: "cpa" };
  }

  const built = builtinContextLimit(modelId);
  if (built != null) {
    return { limitTokens: built, source: "builtin" };
  }

  const def =
    settings.defaultContextLimit > 0
      ? Math.floor(settings.defaultContextLimit)
      : 200_000;
  return { limitTokens: def, source: "default" };
}

export function computeContextUsage(args: {
  request?: TokenFields;
  sdk?: { totalTokens: number; rawMaxTokens?: number };
  modelId: string;
  selectedModelId?: string;
  settings: ContextLimitSettings;
  catalog: ModelInfo[];
  now?: number;
}): ContextUsage | undefined {
  const used = args.sdk?.totalTokens ?? extractUsedTokens(args.request);
  if (used == null) return undefined;
  let { limitTokens, source } = resolveContextLimit(
    args.modelId,
    args.settings,
    args.catalog,
  );
  if (args.selectedModelId && args.selectedModelId !== args.modelId) {
    const selected = resolveContextLimit(args.selectedModelId, args.settings, args.catalog);
    if (selected.source === "override" || (selected.source === "cpa" && source !== "override")) {
      ({ limitTokens, source } = selected);
    }
  }
  const sdkWindow = positiveInt(args.sdk?.rawMaxTokens);
  if (sdkWindow && (source === "builtin" || source === "default" || sdkWindow < limitTokens)) {
    limitTokens = sdkWindow;
    source = "sdk";
  }
  if (limitTokens <= 0) return undefined;
  return {
    estimated: true,
    occupancySource: args.sdk ? "sdk" : "request",
    ...(sdkWindow ? { sdkPolicyWindow: sdkWindow } : {}),
    usedTokens: used,
    limitTokens,
    ratio: used / limitTokens,
    source,
    modelId: args.modelId,
    ...(args.selectedModelId && args.selectedModelId !== args.modelId ? { selectedModelId: args.selectedModelId } : {}),
    updatedAt: args.now ?? Date.now(),
  };
}
