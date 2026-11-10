/** Native account OAuth: per-provider redirects, PKCE, state, refresh and encrypted storage. */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ProviderConfig, ProviderOAuthConfig } from "@claude-desktop/shared";
import { OAuthConfigs, supportsOAuth } from "@claude-desktop/shared";
import type { ProviderManager } from "./provider-manager";
import type { CredentialManager } from "./credential-manager";

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  /** Absolute expiry in milliseconds. */
  expires_at?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
  /** ChatGPT workspace/account routing metadata, never an API key. */
  account_id?: string;
}

export interface StartOAuthResult {
  authorizationUrl: string;
  state: string;
  redirectUri: string;
  callbackMode: "loopback" | "manual";
  completion: Promise<OAuthTokenResponse>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
type FlowResult = { ok: true; token: OAuthTokenResponse } | { ok: false; error: string };
type PendingFlow = {
  providerId: string;
  providerType: ProviderConfig["type"];
  clientId: string;
  endpoints: ProviderOAuthConfig;
  verifier: string;
  redirectUri: string;
  server?: http.Server;
  timer: NodeJS.Timeout;
  abort: AbortController;
  exchanging: boolean;
  settle: (result: FlowResult) => void;
};

/** Decode only for expiry and account routing. The issuing service validates the bearer credential. */
function jwtMetadata(jwt?: string): Record<string, unknown> | null {
  if (!jwt) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(jwt.split(".")[1] || "", "base64url").toString("utf8"));
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch { return null; }
}

export function getOAuthAccountId(token: OAuthTokenResponse): string | undefined {
  if (token.account_id) return token.account_id;
  for (const jwt of [token.id_token, token.access_token]) {
    const auth = jwtMetadata(jwt)?.["https://api.openai.com/auth"];
    if (auth && typeof auth === "object") {
      const id = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof id === "string" && id) return id;
    }
  }
  return undefined;
}

function normalizeToken(token: OAuthTokenResponse): OAuthTokenResponse {
  const normalized = { ...token };
  if (typeof token.expires_in === "number" && Number.isFinite(token.expires_in)) {
    normalized.expires_at = Date.now() + Math.max(0, token.expires_in) * 1000;
  } else if (normalized.expires_at == null) {
    const exp = jwtMetadata(token.access_token)?.exp;
    if (typeof exp === "number" && Number.isFinite(exp)) normalized.expires_at = exp * 1000;
  }
  const accountId = getOAuthAccountId(normalized);
  if (accountId) normalized.account_id = accountId;
  return normalized;
}

function callbackHtml(ok: boolean, message: string): string {
  const escaped = message.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><title>授权${ok ? "完成" : "失败"}</title></head>
<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center"><h2>授权${ok ? "完成" : "失败"}</h2>
<p>${escaped}</p><p>可以关闭此页面返回 CC Desktop。</p></body></html>`;
}

export class OAuthHandler {
  private pending = new Map<string, PendingFlow>();
  private refreshing = new Map<string, Promise<string | null>>();
  private tokenVersions = new Map<string, number>();

  constructor(
    private readonly providerManager: ProviderManager,
    private readonly credentials: CredentialManager,
  ) {}

  static generatePKCE(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  }

  static supportsOAuth(type: string): boolean {
    return supportsOAuth(type as ProviderConfig["type"]);
  }

  private endpoints(config: ProviderConfig): ProviderOAuthConfig {
    return { ...OAuthConfigs[config.type], ...this.providerManager.getOAuthConfig(config.type) };
  }

  private clientId(config: ProviderConfig, endpoints = this.endpoints(config)): string {
    const clientId = config.oauthClientId?.trim() || endpoints.defaultClientId;
    if (!clientId) throw new Error("OAuth client ID is not configured. Register your own Google Desktop app OAuth client and enable the Generative Language API.");
    return clientId;
  }

  async start(providerId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<StartOAuthResult> {
    const config = this.providerManager.getConfig(providerId);
    if (!config) throw new Error(`Unknown provider: ${providerId}`);
    if (!OAuthHandler.supportsOAuth(config.type)) throw new Error(`${config.type} does not support OAuth sign-in`);
    const endpoints = this.endpoints(config);
    const clientId = this.clientId(config, endpoints);
    if (!endpoints.authorizationUrl || !endpoints.tokenUrl) throw new Error(`${config.type} has no OAuth endpoints configured`);

    for (const [state, flow] of this.pending) if (flow.providerId === providerId) this.cancel(state);
    const state = randomBytes(32).toString("hex");
    const { verifier, challenge } = OAuthHandler.generatePKCE();
    const callbackMode = endpoints.callbackMode || "loopback";
    let server: http.Server | undefined;
    let redirectUri: string;
    if (callbackMode === "manual") {
      if (!endpoints.manualRedirectUri) throw new Error("OAuth manual redirect is not configured");
      redirectUri = endpoints.manualRedirectUri;
    } else {
      server = await this.listen(endpoints.callbackPorts || [0]);
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${endpoints.callbackPath || "/oauth/callback"}`;
    }

    let settle!: PendingFlow["settle"];
    const completion = new Promise<OAuthTokenResponse>((resolve, reject) => {
      settle = (result) => result.ok ? resolve(result.token) : reject(new Error(result.error));
    });
    // IPC observes completion after start returns; cancellation must not create an unhandled rejection.
    void completion.catch(() => undefined);
    const timer = setTimeout(() => this.finish(state, { ok: false, error: "OAuth authorization timed out" }), timeoutMs);
    timer.unref?.();
    const flow: PendingFlow = { providerId, providerType: config.type, clientId, endpoints, verifier, redirectUri, server, timer, settle, abort: new AbortController(), exchanging: false };
    this.pending.set(state, flow);
    server?.on("request", (req, res) => { void this.onCallbackRequest(state, req.url || "/", res); });

    const url = new URL(endpoints.authorizationUrl);
    const params = { ...endpoints.authorizationParams, client_id: clientId, redirect_uri: redirectUri, response_type: "code", state, code_challenge: challenge, code_challenge_method: "S256" };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const scope = config.type === "gemini" && config.oauthScopes?.length ? config.oauthScopes.join(" ") : endpoints.scope;
    if (scope) url.searchParams.set("scope", scope);
    return { authorizationUrl: url.toString(), state, redirectUri, callbackMode, completion };
  }

  private async listen(ports: number[]): Promise<http.Server> {
    for (const port of ports) {
      const server = http.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once("error", onError);
          server.listen(port, "127.0.0.1", () => { server.off("error", onError); resolve(); });
        });
        return server;
      } catch (error) {
        server.close();
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error(`OAuth callback ports ${ports.join(", ")} are occupied; close the other account login and retry.`);
  }

  /** Accept a full redirect URL or Claude's displayed code#state. Bare codes cannot validate state. */
  async submitCallback(state: string, redirectUrlOrCode: string): Promise<OAuthTokenResponse> {
    const flow = this.pending.get(state);
    if (!flow) throw new Error("OAuth authorization is not pending");
    if (flow.exchanging) throw new Error("OAuth token exchange is already in progress");
    const value = redirectUrlOrCode.trim();
    let code: string | null;
    let callbackState: string | null;
    let oauthError: string | null = null;
    if (/^https?:\/\//i.test(value)) {
      const callback = new URL(value);
      const expected = new URL(flow.redirectUri);
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) throw new Error("OAuth callback redirect URI does not match this login");
      callbackState = callback.searchParams.get("state");
      code = callback.searchParams.get("code");
      oauthError = callback.searchParams.get("error");
    } else {
      const parts = value.split("#");
      code = parts.length === 2 ? parts[0] : null;
      callbackState = parts.length === 2 ? parts[1] : null;
    }
    if (callbackState !== state) throw new Error("OAuth callback state mismatch; paste the complete callback URL or code#state");
    if (oauthError) {
      const error = `OAuth error: ${/^[a-zA-Z0-9_.-]{1,80}$/.test(oauthError) ? oauthError : "authorization_denied"}`;
      this.finish(state, { ok: false, error });
      throw new Error(error);
    }
    if (!code) {
      this.finish(state, { ok: false, error: "OAuth callback missing code" });
      throw new Error("OAuth callback missing code");
    }

    flow.exchanging = true;
    try {
      const body: Record<string, string> = { grant_type: "authorization_code", code, client_id: flow.clientId, code_verifier: flow.verifier, redirect_uri: flow.redirectUri };
      if (flow.providerType === "claude") body.state = state;
      const token = await this.requestToken(flow.endpoints.tokenUrl!, body, flow.endpoints.tokenEncoding || "form", "OAuth token exchange", flow.abort.signal);
      if (this.pending.get(state) !== flow) throw new Error("OAuth authorization is no longer pending");
      this.finish(state, { ok: true, token });
      return token;
    } catch (error) {
      this.finish(state, { ok: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  cancel(state: string): void { this.finish(state, { ok: false, error: "OAuth authorization cancelled" }); }
  cancelAll(): void { for (const state of this.pending.keys()) this.cancel(state); }
  getPendingState(providerId: string): string | undefined {
    for (const [state, flow] of this.pending) if (flow.providerId === providerId) return state;
    return undefined;
  }

  private async onCallbackRequest(state: string, rawUrl: string, res: http.ServerResponse): Promise<void> {
    const flow = this.pending.get(state);
    const url = new URL(rawUrl, flow?.redirectUri || "http://127.0.0.1");
    if (!flow || url.pathname !== new URL(flow.redirectUri).pathname) {
      res.writeHead(404).end("not found");
      return;
    }
    if (url.searchParams.get("state") !== state || flow.exchanging) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(callbackHtml(false, "state 校验失败或授权正在处理。"));
      return;
    }
    // finish() settles the flow; the browser response must be written before its listener closes.
    const originalServer = flow.server;
    flow.server = undefined;
    try {
      await this.submitCallback(state, url.toString());
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(callbackHtml(true, "登录成功，请返回应用。"));
    } catch (error) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(callbackHtml(false, error instanceof Error ? error.message : "授权失败"));
    } finally { originalServer?.close(); }
  }

  async refresh(config: ProviderConfig, refreshToken: string, scope?: string): Promise<OAuthTokenResponse> {
    const endpoints = this.endpoints(config);
    if (!endpoints.tokenUrl) throw new Error("OAuth token endpoint is missing");
    const body: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.clientId(config, endpoints) };
    if (config.type === "claude" && (scope || endpoints.scope)) body.scope = scope || endpoints.scope!;
    return this.requestToken(endpoints.tokenUrl, body, endpoints.refreshEncoding || endpoints.tokenEncoding || "form", "OAuth token refresh");
  }

  private async requestToken(tokenUrl: string, body: Record<string, string>, encoding: "form" | "json", what: string, signal?: AbortSignal): Promise<OAuthTokenResponse> {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": encoding === "json" ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json" },
      body: encoding === "json" ? JSON.stringify(body) : new URLSearchParams(body).toString(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) {
      // Provider errors can echo credentials. Only expose a bounded OAuth error identifier.
      const detail: unknown = await response.json().catch(() => null);
      const errorCode = detail && typeof detail === "object" ? (detail as Record<string, unknown>).error : null;
      const safeCode = typeof errorCode === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(errorCode) ? ` (${errorCode})` : "";
      throw new Error(`${what} failed: HTTP ${response.status}${safeCode}`);
    }
    const token = await response.json() as OAuthTokenResponse;
    if (typeof token?.access_token !== "string" || !token.access_token) throw new Error(`${what} failed: response has no access_token`);
    return normalizeToken(token);
  }

  private finish(state: string, result: FlowResult): void {
    const flow = this.pending.get(state);
    if (!flow) return;
    this.pending.delete(state);
    clearTimeout(flow.timer);
    flow.abort.abort();
    flow.server?.close();
    flow.server?.closeAllConnections?.();
    flow.settle(result);
  }

  saveOAuthToken(providerId: string, token: OAuthTokenResponse): void {
    this.providerManager.saveOAuthToken(providerId, this.credentials.encrypt(JSON.stringify(token)));
    this.tokenVersions.set(providerId, (this.tokenVersions.get(providerId) || 0) + 1);
  }

  loadOAuthToken(providerId: string): OAuthTokenResponse | null {
    const encrypted = this.providerManager.loadOAuthToken(providerId);
    if (!encrypted) return null;
    try {
      const token = JSON.parse(this.credentials.decrypt(encrypted)) as OAuthTokenResponse;
      return typeof token?.access_token === "string" && token.access_token ? token : null;
    } catch { return null; }
  }

  deleteOAuthToken(providerId: string): void {
    this.providerManager.deleteOAuthToken(providerId);
    this.tokenVersions.set(providerId, (this.tokenVersions.get(providerId) || 0) + 1);
  }

  async ensureFreshToken(providerId: string): Promise<string | null> {
    const config = this.providerManager.getConfig(providerId);
    const storedToken = this.loadOAuthToken(providerId);
    if (!config || !storedToken) return null;
    const token = normalizeToken({ ...storedToken, expires_in: undefined });
    if (token.expires_at == null || token.expires_at - Date.now() >= 60_000) return token.access_token;
    if (!token.refresh_token) return token.expires_at > Date.now() ? token.access_token : null;
    const inFlight = this.refreshing.get(providerId);
    if (inFlight) return inFlight;
    const version = this.tokenVersions.get(providerId) || 0;
    const refreshing = (async () => {
      try {
        const refreshed = await this.refresh(config, token.refresh_token!, token.scope);
        // Logout, reauthentication or provider deletion wins over an in-flight refresh.
        const currentConfig = this.providerManager.getConfig(providerId);
        if ((this.tokenVersions.get(providerId) || 0) !== version || !currentConfig
          || currentConfig.type !== config.type || currentConfig.auth.authMethod !== config.auth.authMethod
          || currentConfig.oauthClientId !== config.oauthClientId) return null;
        const merged = { ...token, ...refreshed, expires_at: refreshed.expires_at };
        this.saveOAuthToken(providerId, merged);
        return merged.access_token;
      } catch { return null; }
    })();
    this.refreshing.set(providerId, refreshing);
    try { return await refreshing; } finally { if (this.refreshing.get(providerId) === refreshing) this.refreshing.delete(providerId); }
  }
}
