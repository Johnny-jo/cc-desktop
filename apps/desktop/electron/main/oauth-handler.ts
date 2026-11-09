/**
 * OAuth 2.0 授权码流程（PKCE，公共客户端）
 *
 * 约束（都来自上一版踩过的坑）：
 * - 只对真的有公开授权码端点的 provider 生效（见 OAuthConfigs）。上一版凭猜测
 *   写了 api.anthropic.com/oauth/* 和 platform.openai.com/oauth/*，这些端点
 *   并不存在，登录必然失败，已删除。
 * - 桌面应用是公共客户端：走 PKCE，不携带 client_secret，也不用环境变量塞密钥。
 * - 回调不落在 Vite 开发端口（旧代码写死 http://localhost:5173/oauth-callback，
 *   打包后没人监听）。改为临时监听 127.0.0.1 随机端口的环回服务器，符合
 *   RFC 8252 对原生应用的要求，也避免抢占固定端口。
 * - state 必须由本次流程生成并校验；verifier 与流程绑定，用完即删。
 */

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ProviderConfig } from "@claude-desktop/shared";
import { supportsOAuth } from "@claude-desktop/shared";
import type { ProviderManager } from "./provider-manager";
import type { CredentialManager } from "./credential-manager";

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  /** 绝对过期时间（毫秒），由 expires_in 换算后持久化 */
  expires_at?: number;
  token_type?: string;
  scope?: string;
}

export interface StartOAuthResult {
  authorizationUrl: string;
  state: string;
  redirectUri: string;
  /** 浏览器回调并完成交换后 resolve；超时 / 取消 / 失败时 reject。 */
  completion: Promise<OAuthTokenResponse>;
}

const CALLBACK_PATH = "/oauth/callback";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

type PendingFlow = {
  providerId: string;
  providerType: string;
  verifier: string;
  redirectUri: string;
  server: http.Server;
  timer: NodeJS.Timeout;
  settle: (result: { ok: true; token: OAuthTokenResponse } | { ok: false; error: string }) => void;
};

function callbackHtml(ok: boolean, message: string): string {
  const color = ok ? "#0f7b3f" : "#b3261e";
  return `<!doctype html><html><head><meta charset="utf-8"><title>授权${ok ? "完成" : "失败"}</title></head>
<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#222">
<h2 style="color:${color}">${ok ? "授权完成" : "授权失败"}</h2>
<p>${message}</p><p>可以关闭此页面返回 CC Desktop。</p>
</body></html>`;
}

export class OAuthHandler {
  private pending: Map<string, PendingFlow> = new Map();

  constructor(
    private readonly providerManager: ProviderManager,
    private readonly credentials: CredentialManager,
  ) {}

  static generatePKCE(): { verifier: string; challenge: string } {
    // RFC 7636: verifier 43–128 字符，取自 unreserved 集合；challenge = S256(verifier)
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  /** 该 provider 类型是否支持 OAuth 登录。 */
  static supportsOAuth(type: string): boolean {
    return supportsOAuth(type as ProviderConfig["type"]);
  }

  /**
   * 启动授权流程：起环回服务器、返回授权 URL，并返回一个在回调到达后 resolve
   * 的 Promise。调用方负责用系统浏览器打开 authorizationUrl。
   */
  async start(providerId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<StartOAuthResult> {
    const config = this.providerManager.getConfig(providerId);
    if (!config) throw new Error(`Unknown provider: ${providerId}`);
    if (!OAuthHandler.supportsOAuth(config.type)) {
      throw new Error(`${config.type} does not support OAuth sign-in`);
    }
    const clientId = config.oauthClientId?.trim();
    if (!clientId) {
      throw new Error("OAuth client ID is not configured for this provider");
    }

    const endpoints = this.providerManager.getOAuthConfig(config.type);
    if (!endpoints.authorizationUrl || !endpoints.tokenUrl) {
      throw new Error(`${config.type} has no OAuth endpoints configured`);
    }

    const state = randomBytes(32).toString("hex");
    const { verifier, challenge } = OAuthHandler.generatePKCE();

    const server = http.createServer();
    const { port } = await new Promise<AddressInfo>((resolve, reject) => {
      server.once("error", reject);
      // 只绑环回地址：不暴露到局域网，也不触发 Windows 防火墙提示。
      server.listen(0, "127.0.0.1", () => resolve(server.address() as AddressInfo));
    });
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    let settle!: PendingFlow["settle"];
    const completion = new Promise<OAuthTokenResponse>((resolve, reject) => {
      let done = false;
      settle = (result) => {
        if (done) return;
        done = true;
        if (result.ok) resolve(result.token);
        else reject(new Error(result.error));
      };
    });

    const timer = setTimeout(() => {
      this.finish(state, { ok: false, error: "OAuth authorization timed out" });
    }, timeoutMs);
    // 超时不应阻止进程退出
    timer.unref?.();

    const flow: PendingFlow = {
      providerId,
      providerType: config.type,
      verifier,
      redirectUri,
      server,
      timer,
      settle,
    };
    this.pending.set(state, flow);

    server.on("request", (req, res) => {
      void this.onCallbackRequest(state, req.url || "/", res);
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (endpoints.scope) params.set("scope", endpoints.scope);

    return {
      authorizationUrl: `${endpoints.authorizationUrl}?${params.toString()}`,
      state,
      redirectUri,
      completion,
    };
  }

  /** 取消某个进行中的流程（例如用户点了取消 / 退出设置页）。 */
  cancel(state: string): void {
    this.finish(state, { ok: false, error: "OAuth authorization cancelled" });
  }

  cancelAll(): void {
    for (const state of Array.from(this.pending.keys())) this.cancel(state);
  }

  private async onCallbackRequest(
    state: string,
    rawUrl: string,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(rawUrl, "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const flow = this.pending.get(state);
    // 不认识的 state：可能是伪造回调，也可能流程已结束。一律不交换。
    if (!flow || url.searchParams.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(callbackHtml(false, "state 校验失败，请重新发起授权。"));
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      const desc = url.searchParams.get("error_description") || error;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(callbackHtml(false, `授权被拒绝：${desc}`));
      this.finish(state, { ok: false, error: `OAuth error: ${desc}` });
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(callbackHtml(false, "回调缺少 authorization code。"));
      this.finish(state, { ok: false, error: "OAuth callback missing code" });
      return;
    }

    try {
      const token = await this.exchangeCode(flow, code);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(callbackHtml(true, "登录成功，已保存凭证。"));
      this.finish(state, { ok: true, token });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(callbackHtml(false, `换取 token 失败：${message}`));
      this.finish(state, { ok: false, error: message });
    }
  }

  private async exchangeCode(flow: PendingFlow, code: string): Promise<OAuthTokenResponse> {
    const endpoints = this.providerManager.getOAuthConfig(flow.providerType);
    const config = this.providerManager.getConfig(flow.providerId);
    if (!endpoints.tokenUrl || !config?.oauthClientId) {
      throw new Error("OAuth endpoints or client ID missing");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      // 公共客户端：不带 client_secret，只用 PKCE + client_id
      client_id: config.oauthClientId,
      code_verifier: flow.verifier,
      redirect_uri: flow.redirectUri,
    });

    return this.requestToken(endpoints.tokenUrl, body, "OAuth token exchange");
  }

  /** 用 refresh_token 换新 token。 */
  async refresh(config: ProviderConfig, refreshToken: string): Promise<OAuthTokenResponse> {
    const endpoints = this.providerManager.getOAuthConfig(config.type);
    const clientId = config.oauthClientId?.trim();
    if (!endpoints.tokenUrl || !clientId) {
      throw new Error("OAuth endpoints or client ID missing");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
    return this.requestToken(endpoints.tokenUrl, body, "OAuth token refresh");
  }

  private async requestToken(
    tokenUrl: string,
    body: URLSearchParams,
    what: string,
  ): Promise<OAuthTokenResponse> {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      // 端点把错误细节放在 body 里（RFC 6749 §5.2），比 statusText 有用得多。
      const detail = await response.text().catch(() => "");
      throw new Error(`${what} failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
    }

    const json = (await response.json()) as OAuthTokenResponse;
    if (!json?.access_token) {
      throw new Error(`${what} failed: response has no access_token`);
    }
    const token: OAuthTokenResponse = { ...json };
    if (json.expires_in && Number.isFinite(json.expires_in)) {
      token.expires_at = Date.now() + json.expires_in * 1000;
    }
    return token;
  }

  private finish(
    state: string,
    result: { ok: true; token: OAuthTokenResponse } | { ok: false; error: string },
  ): void {
    const flow = this.pending.get(state);
    if (!flow) return;
    this.pending.delete(state);
    clearTimeout(flow.timer);
    flow.server.close();
    flow.server.closeAllConnections?.();
    flow.settle(result);
  }

  // ── 凭证存取 ────────────────────────────────────────────────────────────

  /** 保存 OAuth token（加密后单独存文件，与 API Key 互不覆盖）。 */
  saveOAuthToken(providerId: string, token: OAuthTokenResponse): void {
    const encrypted = this.credentials.encrypt(JSON.stringify(token));
    this.providerManager.saveOAuthToken(providerId, encrypted);
  }

  /** 读取 OAuth token（解密）。格式损坏时返回 null，让调用方走重新登录。 */
  loadOAuthToken(providerId: string): OAuthTokenResponse | null {
    const encrypted = this.providerManager.loadOAuthToken(providerId);
    if (!encrypted) return null;
    try {
      const parsed = JSON.parse(this.credentials.decrypt(encrypted)) as OAuthTokenResponse;
      return parsed?.access_token ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 删除 OAuth token。 */
  deleteOAuthToken(providerId: string): void {
    this.providerManager.deleteOAuthToken(providerId);
  }

  /**
   * 取一个可用的 access token：快过期（<60s）且有 refresh_token 时自动刷新并回写。
   */
  async ensureFreshToken(providerId: string): Promise<string | null> {
    const config = this.providerManager.getConfig(providerId);
    if (!config) return null;
    const token = this.loadOAuthToken(providerId);
    if (!token) return null;

    const expiring =
      token.expires_at != null && token.expires_at - Date.now() < 60_000;
    if (!expiring || !token.refresh_token) return token.access_token;

    try {
      const refreshed = await this.refresh(config, token.refresh_token);
      // 有些端点在刷新时不返回新的 refresh_token，保留旧的。
      const merged: OAuthTokenResponse = {
        refresh_token: token.refresh_token,
        ...refreshed,
      };
      this.saveOAuthToken(providerId, merged);
      return merged.access_token;
    } catch {
      // 刷新失败就当作需要重新登录，让上层报「未认证」而不是继续用死 token。
      return null;
    }
  }
}
