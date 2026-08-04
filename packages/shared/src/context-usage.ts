import type {
  ContextLimitSource,
  ContextUsage,
  ModelInfo,
  TurnUsage,
} from "./models";

export type ContextLimitSettings = {
  defaultContextLimit: number;
  modelContextLimits: Record<string, number>;
};

/** Prefer input_tokens; else sum of cache fields. */
export function extractUsedTokens(turn?: TurnUsage): number | undefined {
  if (!turn) return undefined;
  if (
    turn.inputTokens != null &&
    Number.isFinite(turn.inputTokens) &&
    turn.inputTokens >= 0
  ) {
    return turn.inputTokens;
  }
  const cacheRead = turn.cacheReadTokens;
  const cacheCreation = turn.cacheCreationTokens;
  const hasCache =
    (cacheRead != null && Number.isFinite(cacheRead)) ||
    (cacheCreation != null && Number.isFinite(cacheCreation));
  if (!hasCache) return undefined;
  const sum = (cacheRead ?? 0) + (cacheCreation ?? 0);
  return sum >= 0 && Number.isFinite(sum) ? sum : undefined;
}

function positiveInt(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n > 0 ? n : undefined;
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
  { match: /kimi|k3|moonshot/i, limit: 128_000 },
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
  turn?: TurnUsage;
  modelId: string;
  settings: ContextLimitSettings;
  catalog: ModelInfo[];
  now?: number;
}): ContextUsage | undefined {
  const used = extractUsedTokens(args.turn);
  if (used == null) return undefined;
  const { limitTokens, source } = resolveContextLimit(
    args.modelId,
    args.settings,
    args.catalog,
  );
  if (limitTokens <= 0) return undefined;
  return {
    usedTokens: used,
    limitTokens,
    ratio: used / limitTokens,
    source,
    modelId: args.modelId,
    updatedAt: args.now ?? Date.now(),
  };
}
