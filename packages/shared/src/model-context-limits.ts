export const CONTEXT_LIMIT_MIN = 1024;
export const CONTEXT_LIMIT_MAX = 10_000_000;

export type ParseContextLimitResult =
  | { kind: "clear" }
  | { kind: "value"; value: number }
  | { kind: "error"; message: string };

export function parseContextLimitInput(raw: string): ParseContextLimitResult {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "clear" };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { kind: "error", message: "must be a number" };
  }
  const value = Math.floor(n);
  if (value < CONTEXT_LIMIT_MIN || value > CONTEXT_LIMIT_MAX) {
    return {
      kind: "error",
      message: `must be between ${CONTEXT_LIMIT_MIN} and ${CONTEXT_LIMIT_MAX}`,
    };
  }
  return { kind: "value", value };
}

export type BuildModelContextLimitsResult =
  | { ok: true; modelContextLimits: Record<string, number> }
  | { ok: false; error: string };

/**
 * Merge user draft overrides for visible model rows into existing map.
 * - Starts from a copy of `existing` (preserves orphan keys not in visibleIds)
 * - For each visible id: clear deletes key; value sets floor(int); error aborts
 */
export function buildModelContextLimitsPatch(args: {
  existing: Record<string, number>;
  visibleIds: string[];
  draft: Record<string, string>;
}): BuildModelContextLimitsResult {
  const next: Record<string, number> = { ...args.existing };
  for (const id of args.visibleIds) {
    const raw = args.draft[id] ?? "";
    const parsed = parseContextLimitInput(raw);
    if (parsed.kind === "error") {
      return {
        ok: false,
        error: `Model "${id}" context limit ${parsed.message}`,
      };
    }
    if (parsed.kind === "clear") {
      delete next[id];
    } else {
      next[id] = parsed.value;
    }
  }
  return { ok: true, modelContextLimits: next };
}
