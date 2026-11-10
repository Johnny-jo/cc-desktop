import { normalizeProviderBaseUrl } from "./provider-api-url";
import { ProviderEndpoints, type ProviderConfig } from "./provider-types";

/** Claude Messages gateways can use Bearer credentials without using OAuth. */
export function claudeApiKeyHeaders(config: Pick<ProviderConfig, "auth">, credential: string): Record<string, string> {
  const auth = config.auth;
  if (auth.type !== "claude") throw new Error("Claude 服务鉴权配置无效");
  const mode = auth.apiKeyAuth ?? "auto";
  if (!["auto", "x-api-key", "bearer"].includes(mode)) throw new Error("Claude 服务鉴权方式无效");
  const base = normalizeProviderBaseUrl(auth.baseUrl?.trim() || ProviderEndpoints.claude.baseUrl);
  const official = new URL(base).hostname === "api.anthropic.com";
  const bearer = mode === "bearer" || (mode === "auto" && !official);
  const headers: Record<string, string> = {
    [bearer ? "authorization" : "x-api-key"]: bearer ? `Bearer ${credential}` : credential,
    "anthropic-version": "2023-06-01",
  };
  // A gateway API key sent as Bearer is still an API key. Only a recognized
  // Anthropic subscription token needs the OAuth/Claude Code beta contract.
  if (bearer && /^sk-ant-oat\d+-/.test(credential)) headers["anthropic-beta"] = "oauth-2025-04-20,claude-code-20250219";
  return headers;
}
