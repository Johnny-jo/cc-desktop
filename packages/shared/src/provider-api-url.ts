import { ProviderEndpoints, type ProviderConfig } from "./provider-types";

/** Validate in both renderer/IPC and at the request boundary. Never accept URL credentials. */
export function normalizeProviderBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Base URL is required");
  const base = value.trim();
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("Base URL must be a valid HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL must be an HTTP(S) URL without credentials, query or fragment");
  }
  return base;
}

/** Models and generation share the same version/custom prefix. OAuth overrides are ignored. */
export function providerApiUrl(config: Pick<ProviderConfig, "type" | "auth">, resource: string): string {
  const override = config.auth.authMethod === "api-key" ? config.auth.baseUrl : undefined;
  const hasOverride = typeof override === "string" ? Boolean(override.trim()) : override != null;
  const defaultBase = config.type === "openai-compatible" ? "" : ProviderEndpoints[config.type].baseUrl;
  const base = normalizeProviderBaseUrl(hasOverride ? override : defaultBase);
  const url = new URL(base);
  // Legacy compatible configurations may store the complete Chat endpoint.
  // All other custom path segments are API prefixes and must stay intact.
  const basePath = url.pathname.replace(/\/+$/, "");
  let prefix = config.type === "openai-compatible" ? basePath.replace(/\/chat\/completions$/, "") : basePath;
  if (!basePath) prefix = config.type === "gemini" ? "/v1beta" : "/v1";
  // The Gemini streaming suffix has a trusted query supplied by the caller.
  const queryAt = resource.indexOf("?");
  url.pathname = `${prefix}/${queryAt >= 0 ? resource.slice(0, queryAt) : resource}`;
  if (queryAt >= 0) url.search = resource.slice(queryAt + 1);
  return url.toString();
}
