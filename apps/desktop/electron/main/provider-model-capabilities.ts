import { parseModelDefaultReasoningEffort, parseModelReasoningEfforts, ProviderEndpoints, type ModelInfo, type ProviderConfig } from "@claude-desktop/shared";

type ReasoningCapabilities = Pick<ModelInfo, "reasoningEfforts" | "defaultReasoningEffort">;

/** Only exact official API IDs verified on 2026-11-09; never infer from model families. */
const OPENAI_API_REASONING: Record<string, ReasoningCapabilities> = {
  // https://developers.openai.com/api/docs/models/gpt-6.1-sol
  "gpt-6.1-sol": { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
  // https://developers.openai.com/api/docs/models/gpt-6-astra (no documented default).
  "gpt-6-astra": { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  // The following pages also advertise none, which the bundled Agent SDK cannot express.
  // https://developers.openai.com/api/docs/models/gpt-6.1-terra
  "gpt-6.1-terra": { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
  // https://developers.openai.com/api/docs/models/gpt-6-sol
  "gpt-6-sol": { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
  // https://developers.openai.com/api/docs/models/gpt-6-luna
  "gpt-6-luna": { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol
  "gpt-5.6-sol": { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
};

// User-configurable options for custom services, not verified upstream support.
const CUSTOM_API_REASONING: ReasoningCapabilities = {
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
};

export function hasCustomProviderApi(config: Pick<ProviderConfig, "type" | "auth">): boolean {
  if (config.auth.authMethod !== "api-key") return false;
  if (config.type === "openai-compatible") return true;
  const base = config.auth.baseUrl?.trim();
  if (!base) return false;
  try { return new URL(base).origin !== new URL(ProviderEndpoints[config.type].baseUrl).origin; }
  catch { return false; } // Invalid URLs are rejected by the shared request boundary.
}

const REASONING_LEVEL_KEYS = new Set([
  "reasoningefforts", "supportedreasoningefforts", "reasoninglevels", "supportedreasoninglevels",
  "effortlevels", "supportedeffortlevels", "levels",
]);
const REASONING_METADATA_KEYS = new Set([...REASONING_LEVEL_KEYS, "defaultreasoningeffort", "defaultreasoninglevel", "reasoningeffort"]);

function hasReasoningMetadata(raw: unknown, keys = REASONING_METADATA_KEYS): boolean {
  if (!raw || typeof raw !== "object") return false;
  const record = raw as Record<string, unknown>;
  // Explicit empty or unsupported levels are still an upstream statement, not missing data.
  if (Object.keys(record).some(key => keys.has(key.replace(/_/g, "").toLowerCase()))) return true;
  return ["thinking", "capabilities", "meta", "metadata", "info"].some(key => hasReasoningMetadata(record[key], keys));
}

export function modelReasoningCapabilities(raw: unknown, officialApiModelId?: string, customApi = false): ReasoningCapabilities {
  const reasoningEfforts = parseModelReasoningEfforts(raw);
  const defaultReasoningEffort = parseModelDefaultReasoningEffort(raw);
  const builtin = customApi
    ? !hasReasoningMetadata(raw, REASONING_LEVEL_KEYS) ? CUSTOM_API_REASONING : undefined
    : officialApiModelId && !hasReasoningMetadata(raw) ? OPENAI_API_REASONING[officialApiModelId] : undefined;
  return {
    ...(builtin?.reasoningEfforts ? { reasoningEfforts: [...builtin.reasoningEfforts] } : {}),
    ...(builtin?.defaultReasoningEffort ? { defaultReasoningEffort: builtin.defaultReasoningEffort } : {}),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  };
}
