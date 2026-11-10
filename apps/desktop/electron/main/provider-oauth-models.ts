import type { ProviderConfig, ProviderModel, ProviderType } from "@claude-desktop/shared";
import { getOAuthAccountId, type OAuthTokenResponse } from "./oauth-handler";
import { modelReasoningCapabilities } from "./provider-model-capabilities";

/** Account-backed routes are deliberately separate from the API-key routes. */
export const ProviderOAuthEndpoints = {
  openai: { baseUrl: "https://chatgpt.com/backend-api/codex", modelsEndpoint: "/models", chatEndpoint: "/responses" },
  claude: { baseUrl: "https://api.anthropic.com", modelsEndpoint: "/v1/models", chatEndpoint: "/v1/messages" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", modelsEndpoint: "/v1beta/models", chatEndpoint: "/v1beta/models" },
} as const;

/** Codex protocol baseline whose catalog shape this adapter implements; not an entitlement claim. */
export const CODEX_CATALOG_PROTOCOL_VERSION = "0.163.0";

export function providerOAuthRequestHeaders(type: ProviderType, token: OAuthTokenResponse, config?: Pick<ProviderConfig, "oauthProjectId">): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token.access_token}` };
  switch (type) {
    case "openai": {
      headers.originator = "codex_cli_rs";
      const accountId = getOAuthAccountId(token);
      if (accountId) headers["ChatGPT-Account-Id"] = accountId;
      return headers;
    }
    case "claude":
      return { ...headers, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" };
    case "gemini": {
      const project = config?.oauthProjectId?.trim();
      if (project) headers["x-goog-user-project"] = project;
      return headers;
    }
    default: throw new Error(`OAuth is not supported for ${type}`);
  }
}

type JsonObject = Record<string, unknown>;
function record(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function model(id: string, name: unknown, contextLimit: unknown): ProviderModel {
  const result: ProviderModel = { id, name: typeof name === "string" && name ? name : id };
  const limit = positiveNumber(contextLimit);
  if (limit !== undefined) result.contextLimit = limit;
  return result;
}

/**
 * Read the real account catalog. Failures are surfaced so a caller may retain a marked stale cache;
 * an empty/failed response never turns into a fabricated authenticated model list.
 * Codex: openai/codex codex-api/src/endpoint/models.rs and model-provider/src/models_endpoint.rs.
 * Claude: SDK 0.3.318 models.list({betas:['oauth-2025-04-20']}).
 * Google: Generative Language discovery document, models.list.
 */
export async function listOAuthModels(config: ProviderConfig, token: OAuthTokenResponse): Promise<ProviderModel[]> {
  if (config.auth.authMethod !== "oauth2") throw new Error("OAuth model discovery requires an OAuth account");
  if (!(config.type in ProviderOAuthEndpoints)) throw new Error(`OAuth is not supported for ${config.type}`);
  const type = config.type as keyof typeof ProviderOAuthEndpoints;
  const endpoint = ProviderOAuthEndpoints[type];
  const url = new URL(endpoint.baseUrl + endpoint.modelsEndpoint);
  if (type === "openai") url.searchParams.set("client_version", CODEX_CATALOG_PROTOCOL_VERSION);
  if (type === "claude") url.searchParams.set("limit", "1000");
  if (type === "gemini") url.searchParams.set("pageSize", "1000");
  const headers = { ...providerOAuthRequestHeaders(type, token, config), accept: "application/json" };
  const result = new Map<string, ProviderModel>();
  const pages = new Set<string>();
  for (let count = 0; count < 100; count++) {
    const pageUrl = url.toString();
    if (pages.has(pageUrl)) throw new Error("OAuth model catalog repeated a pagination token");
    pages.add(pageUrl);
    const response = await fetch(pageUrl, { headers, signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!response.ok) throw new Error(`OAuth model catalog failed: HTTP ${response.status}`);
    const body = record(await response.json());
    const entries = body?.[type === "claude" ? "data" : "models"];
    if (!Array.isArray(entries)) throw new Error("OAuth model catalog response has an invalid shape");
    for (const entry of entries) {
      const item = record(entry);
      if (!item) continue;
      let parsed: ProviderModel | undefined;
      if (type === "openai" && typeof item.slug === "string" && item.slug && item.visibility !== "hidden" && item.visibility !== "hide") {
        parsed = model(item.slug, item.display_name, item.context_window);
      } else if (type === "claude" && typeof item.id === "string" && item.id) {
        parsed = model(item.id, item.display_name, item.max_input_tokens);
      } else if (type === "gemini" && typeof item.name === "string" && item.name) {
        if (Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes("generateContent")) continue;
        parsed = model(item.name.replace(/^models\//, ""), item.displayName, item.inputTokenLimit);
      }
      if (parsed) result.set(parsed.id, { ...parsed, ...modelReasoningCapabilities(item) });
    }
    if (type === "claude" && body?.has_more === true) {
      if (typeof body.last_id !== "string" || !body.last_id) throw new Error("OAuth model catalog is missing its pagination cursor");
      url.searchParams.set("after_id", body.last_id);
    } else if (type === "gemini" && typeof body?.nextPageToken === "string" && body.nextPageToken) {
      url.searchParams.set("pageToken", body.nextPageToken);
    } else return [...result.values()];
  }
  throw new Error("OAuth model catalog exceeded the pagination limit");
}
