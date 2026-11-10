import { describe, expect, it, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OAuthHandler, type OAuthTokenResponse } from "./oauth-handler";
import { CredentialManager } from "./credential-manager";
import type { ProviderManager } from "./provider-manager";
import type { ProviderConfig } from "@claude-desktop/shared";

/** 可控的 provider 管理器桩：只实现 OAuthHandler 用到的部分。 */
function stubManager(opts: {
  config: ProviderConfig;
  endpoints: { authorizationUrl?: string; tokenUrl?: string; scope?: string };
  onSaveToken?: (id: string, encrypted: string) => void;
}): ProviderManager {
  return {
    getConfig: (id: string) => (id === opts.config.id ? opts.config : null),
    getOAuthConfig: () => opts.endpoints,
    saveOAuthToken: (id: string, encrypted: string) => opts.onSaveToken?.(id, encrypted),
    loadOAuthToken: () => null,
    deleteOAuthToken: () => undefined,
  } as unknown as ProviderManager;
}

const creds = () => new CredentialManager({ encrypt: (p) => p, decrypt: (c) => c });

const geminiConfig: ProviderConfig = {
  id: "gemini-1",
  name: "Gemini",
  type: "gemini",
  enabled: true,
  oauthClientId: "client-abc",
  auth: { type: "gemini", authMethod: "oauth2" },
};

const servers: http.Server[] = [];

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

describe("OAuthHandler.generatePKCE", () => {
  it("produces a verifier in RFC 7636 range and an S256 challenge", () => {
    const { verifier, challenge } = OAuthHandler.generatePKCE();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/); // base64url，无填充
    expect(challenge).not.toBe(verifier);
  });

  it("never repeats a verifier", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(OAuthHandler.generatePKCE().verifier);
    expect(seen.size).toBe(50);
  });
});

describe("OAuthHandler.supportsOAuth", () => {
  it("is true only for providers with real authorization endpoints", () => {
    expect(OAuthHandler.supportsOAuth("gemini")).toBe(true);
    expect(OAuthHandler.supportsOAuth("claude")).toBe(true);
    expect(OAuthHandler.supportsOAuth("openai")).toBe(true);
    expect(OAuthHandler.supportsOAuth("openai-compatible")).toBe(false);
  });
});

describe("OAuthHandler.start", () => {
  it("rejects providers without a public OAuth endpoint", async () => {
    const manager = stubManager({
      config: { ...geminiConfig, type: "deepseek", auth: { type: "deepseek", authMethod: "api-key" } },
      endpoints: {},
    });
    const handler = new OAuthHandler(manager, creds());
    await expect(handler.start("gemini-1")).rejects.toThrow(/does not support OAuth/);
  });

  it("requires a client ID instead of silently using an env var", async () => {
    const manager = stubManager({
      config: { ...geminiConfig, oauthClientId: undefined },
      endpoints: { authorizationUrl: "https://auth.example/a", tokenUrl: "https://auth.example/t" },
    });
    const handler = new OAuthHandler(manager, creds());
    await expect(handler.start("gemini-1")).rejects.toThrow(/client ID/i);
  });

  it("builds an authorization URL with PKCE, state and a loopback redirect", async () => {
    const manager = stubManager({
      config: geminiConfig,
      endpoints: {
        authorizationUrl: "https://auth.example/authorize",
        tokenUrl: "https://auth.example/token",
        scope: "scope-a",
      },
    });
    const handler = new OAuthHandler(manager, creds());

    const start = await handler.start("gemini-1");
    const url = new URL(start.authorizationUrl);

    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("scope-a");
    expect(url.searchParams.get("state")).toBe(start.state);
    // 回调必须是环回地址，而不是 Vite 开发端口
    expect(start.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(url.searchParams.get("redirect_uri")).toBe(start.redirectUri);

    start.completion.catch(() => undefined);
    handler.cancelAll();
  });

  it("exchanges the code via the loopback callback and sends no client_secret", async () => {
    let received: Record<string, string> = {};
    const tokenServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received = Object.fromEntries(new URLSearchParams(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "access-123",
            refresh_token: "refresh-456",
            expires_in: 3600,
            token_type: "Bearer",
          }),
        );
      });
    });
    const tokenPort = await listen(tokenServer);

    const manager = stubManager({
      config: geminiConfig,
      endpoints: {
        authorizationUrl: "https://auth.example/authorize",
        tokenUrl: `http://127.0.0.1:${tokenPort}/token`,
      },
    });
    const handler = new OAuthHandler(manager, creds());

    const start = await handler.start("gemini-1");

    // 模拟浏览器带着 code 回到环回地址
    const callback = new URL(start.redirectUri);
    callback.searchParams.set("code", "the-code");
    callback.searchParams.set("state", start.state);
    const response = await fetch(callback);
    expect(response.status).toBe(200);

    const token = await start.completion;
    expect(token.access_token).toBe("access-123");
    expect(token.expires_at).toBeGreaterThan(Date.now());

    expect(received.grant_type).toBe("authorization_code");
    expect(received.code).toBe("the-code");
    expect(received.client_id).toBe("client-abc");
    expect(received.redirect_uri).toBe(start.redirectUri);
    expect(received.code_verifier).toBeTruthy();
    // 公共客户端不能用 client_secret
    expect(received).not.toHaveProperty("client_secret");
  });

  it("refuses a callback whose state does not match", async () => {
    const manager = stubManager({
      config: geminiConfig,
      endpoints: { authorizationUrl: "https://auth.example/a", tokenUrl: "https://auth.example/t" },
    });
    const handler = new OAuthHandler(manager, creds());

    const start = await handler.start("gemini-1");
    const callback = new URL(start.redirectUri);
    callback.searchParams.set("code", "x");
    callback.searchParams.set("state", "forged");

    const response = await fetch(callback);
    expect(response.status).toBe(400);

    start.completion.catch(() => undefined);
    handler.cancelAll();
  });

  it("surfaces an authorization error from the callback", async () => {
    const manager = stubManager({
      config: geminiConfig,
      endpoints: { authorizationUrl: "https://auth.example/a", tokenUrl: "https://auth.example/t" },
    });
    const handler = new OAuthHandler(manager, creds());
    const start = await handler.start("gemini-1");
    // 回调在 fetch 期间就会 reject，先挂上处理器，避免短暂的 unhandled rejection。
    const completion = start.completion.catch((err: unknown) => err);

    const callback = new URL(start.redirectUri);
    callback.searchParams.set("error", "access_denied");
    callback.searchParams.set("state", start.state);
    await fetch(callback);

    expect(String(await completion)).toMatch(/access_denied/);
  });

  it("times out and closes the loopback server", async () => {
    const manager = stubManager({
      config: geminiConfig,
      endpoints: { authorizationUrl: "https://auth.example/a", tokenUrl: "https://auth.example/t" },
    });
    const handler = new OAuthHandler(manager, creds());
    const start = await handler.start("gemini-1", 30);

    await expect(start.completion).rejects.toThrow(/timed out/i);
    // 超时后端口应已释放
    await expect(fetch(start.redirectUri)).rejects.toThrow();
  });
});

describe("OAuthHandler token storage", () => {
  it("round-trips a token through encryption and clears it on delete", () => {
    let stored: string | null = null;
    const manager = stubManager({
      config: geminiConfig,
      endpoints: {},
      onSaveToken: (_id, encrypted) => {
        stored = encrypted;
      },
    });
    (manager as unknown as Record<string, unknown>).loadOAuthToken = () => stored;
    (manager as unknown as Record<string, unknown>).deleteOAuthToken = () => {
      stored = null;
    };
    const handler = new OAuthHandler(manager, creds());

    const token: OAuthTokenResponse = { access_token: "a", refresh_token: "r", expires_in: 60 };
    handler.saveOAuthToken("gemini-1", token);

    expect(handler.loadOAuthToken("gemini-1")).toMatchObject({ access_token: "a" });
    handler.deleteOAuthToken("gemini-1");
    expect(handler.loadOAuthToken("gemini-1")).toBeNull();
  });

  it("returns null for a corrupt stored token instead of throwing", () => {
    const manager = stubManager({ config: geminiConfig, endpoints: {} });
    (manager as unknown as Record<string, unknown>).loadOAuthToken = () => "enc:{not json";
    const handler = new OAuthHandler(manager, creds());
    expect(handler.loadOAuthToken("gemini-1")).toBeNull();
  });
});

const claudeConfig = {
  id: "claude-1", name: "Claude", type: "claude", enabled: true,
  auth: { type: "claude", authMethod: "oauth2" },
} as ProviderConfig;

const openaiConfig = {
  id: "openai-1", name: "ChatGPT", type: "openai", enabled: true,
  auth: { type: "openai", authMethod: "oauth2" },
} as ProviderConfig;

describe("native account OAuth", () => {
  it("uses Claude's first-party manual redirect and a public client without extra configuration", async () => {
    const handler = new OAuthHandler(stubManager({ config: claudeConfig, endpoints: {} }), creds());
    const started = await handler.start(claudeConfig.id);
    started.completion.catch(() => undefined);
    try {
      const url = new URL(started.authorizationUrl);
      expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      expect(url.searchParams.get("code")).toBe("true");
      expect(url.searchParams.get("scope")).toContain("user:inference");
      expect(started.redirectUri).toBe("https://platform.claude.com/oauth/code/callback");
      expect(started.callbackMode).toBe("manual");
    } finally { handler.cancelAll(); }
  });

  it("exchanges Claude's pasted code#state as JSON with the bound state and verifier", async () => {
    let request: RequestInit | undefined;
    let endpoint: unknown;
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit) => {
      endpoint = input;
      request = init;
      return Response.json({ access_token: "claude-access", refresh_token: "claude-refresh", expires_in: 3600 });
    });
    const handler = new OAuthHandler(stubManager({ config: claudeConfig, endpoints: {} }), creds());
    const started = await handler.start(claudeConfig.id);
    try {
      await handler.submitCallback(started.state, `some-code#${started.state}`);
      expect((await started.completion).access_token).toBe("claude-access");
      expect(endpoint).toBe("https://platform.claude.com/v1/oauth/token");
      expect(request?.headers).toMatchObject({ "content-type": "application/json" });
      expect(JSON.parse(String(request?.body))).toMatchObject({
        code: "some-code", state: started.state, grant_type: "authorization_code",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", redirect_uri: started.redirectUri,
      });
      expect(JSON.parse(String(request?.body)).code_verifier).toBeTruthy();
      await expect(handler.submitCallback(started.state, `some-code#${started.state}`)).rejects.toThrow(/not pending/i);
    } finally { started.completion.catch(() => undefined); handler.cancelAll(); }
  });

  it("rejects a forged pasted state and unrelated callback URLs without exchanging the code", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = new OAuthHandler(stubManager({ config: claudeConfig, endpoints: {} }), creds());
    const started = await handler.start(claudeConfig.id);
    started.completion.catch(() => undefined);
    try {
      await expect(handler.submitCallback(started.state, "code#forged")).rejects.toThrow(/state/i);
      await expect(handler.submitCallback(started.state, `https://attacker.example/callback?code=x&state=${started.state}`)).rejects.toThrow(/redirect/i);
      await expect(handler.submitCallback(started.state, "bare-code")).rejects.toThrow(/state/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { handler.cancelAll(); }
  });

  it("uses a Codex-allowed loopback port and keeps account ID metadata from the ID token", async () => {
    const idToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-42" } })).toString("base64url")}.sig`;
    vi.stubGlobal("fetch", async () => Response.json({ access_token: "codex-access", id_token: idToken, expires_in: 60 }));
    const handler = new OAuthHandler(stubManager({ config: openaiConfig, endpoints: {} }), creds());
    const started = await handler.start(openaiConfig.id);
    try {
      const url = new URL(started.authorizationUrl);
      expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
      expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
      expect(started.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:145[57]\/auth\/callback$/);
      const callback = new URL(started.redirectUri);
      callback.searchParams.set("state", started.state);
      callback.searchParams.set("code", "codex-code");
      await handler.submitCallback(started.state, callback.toString());
      expect(await started.completion).toMatchObject({ id_token: idToken, account_id: "account-42" });
    } finally { started.completion.catch(() => undefined); handler.cancelAll(); }
  });

  it("requests offline Google consent using a user-owned client, with no embedded secret", async () => {
    const handler = new OAuthHandler(stubManager({ config: geminiConfig, endpoints: {} }), creds());
    const started = await handler.start(geminiConfig.id);
    started.completion.catch(() => undefined);
    try {
      const url = new URL(started.authorizationUrl);
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/generative-language.retriever");
      expect(url.searchParams.has("client_secret")).toBe(false);
    } finally { handler.cancelAll(); }
  });

  it("deduplicates concurrent refreshes and preserves account metadata when refresh rotates credentials", async () => {
    let stored = creds().encrypt(JSON.stringify({ access_token: "old", refresh_token: "r1", expires_at: 1, account_id: "acct", id_token: "id-original" }));
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({ access_token: "new", refresh_token: "r2", expires_in: 600 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = stubManager({ config: openaiConfig, endpoints: {}, onSaveToken: (_id, encrypted) => { stored = encrypted; } });
    manager.loadOAuthToken = () => stored;
    const handler = new OAuthHandler(manager, creds());
    expect(await Promise.all([handler.ensureFreshToken(openaiConfig.id), handler.ensureFreshToken(openaiConfig.id)])).toEqual(["new", "new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(creds().decrypt(stored))).toMatchObject({ refresh_token: "r2", account_id: "acct", id_token: "id-original" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ grant_type: "refresh_token", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
  });

  it("does not return an expired token that cannot be refreshed", async () => {
    const manager = stubManager({ config: geminiConfig, endpoints: {} });
    manager.loadOAuthToken = () => creds().encrypt(JSON.stringify({ access_token: "expired", expires_at: 1 }));
    const handler = new OAuthHandler(manager, creds());
    expect(await handler.ensureFreshToken(geminiConfig.id)).toBeNull();
  });

  it("does not resurrect a logged-out account when an in-flight refresh completes", async () => {
    let resolveRefresh!: (value: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));
    let stored: string | null = null;
    const manager = stubManager({ config: openaiConfig, endpoints: {}, onSaveToken: (_id, encrypted) => { stored = encrypted; } });
    manager.loadOAuthToken = () => stored;
    manager.deleteOAuthToken = () => { stored = null; };
    const handler = new OAuthHandler(manager, creds());
    handler.saveOAuthToken(openaiConfig.id, { access_token: "old", refresh_token: "r1", expires_at: 1 });
    const refresh = handler.ensureFreshToken(openaiConfig.id);
    handler.deleteOAuthToken(openaiConfig.id);
    resolveRefresh(Response.json({ access_token: "new", refresh_token: "r2", expires_in: 600 }));
    expect(await refresh).toBeNull();
    expect(stored).toBeNull();
  });

  it("does not save refreshed credentials after the provider switches OAuth clients", async () => {
    let resolveRefresh!: (value: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));
    const manager = stubManager({ config: openaiConfig, endpoints: {} });
    let currentConfig = openaiConfig;
    manager.getConfig = () => currentConfig;
    const save = vi.fn();
    manager.saveOAuthToken = save;
    manager.loadOAuthToken = () => creds().encrypt(JSON.stringify({ access_token: "old", refresh_token: "r1", expires_at: 1 }));
    const handler = new OAuthHandler(manager, creds());
    const refreshing = handler.ensureFreshToken(openaiConfig.id);
    currentConfig = { ...openaiConfig, oauthClientId: "different-client" };
    resolveRefresh(Response.json({ access_token: "new", expires_in: 600 }));
    expect(await refreshing).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("discards a cancelled exchange even if its transport resolves later", async () => {
    let resolveExchange!: (value: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { resolveExchange = resolve; }));
    const handler = new OAuthHandler(stubManager({ config: claudeConfig, endpoints: {} }), creds());
    const started = await handler.start(claudeConfig.id);
    const submitted = handler.submitCallback(started.state, `code#${started.state}`);
    handler.cancel(started.state);
    resolveExchange(Response.json({ access_token: "should-not-be-saved" }));
    await expect(submitted).rejects.toThrow(/no longer pending/);
    await expect(started.completion).rejects.toThrow(/cancelled/);
  });

  it("refreshes Claude using JSON and the granted scopes without broadening permissions", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init: RequestInit) => Response.json({ access_token: "new" }));
    vi.stubGlobal("fetch", fetchMock);
    const handler = new OAuthHandler(stubManager({ config: claudeConfig, endpoints: {} }), creds());
    await handler.refresh(claudeConfig, "refresh", "user:inference");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      grant_type: "refresh_token", refresh_token: "refresh", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e", scope: "user:inference",
    });
  });

  it("uses JWT expiry when a Codex refresh response does not include expires_in", async () => {
    const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 })).toString("base64url")}.sig`;
    const manager = stubManager({ config: openaiConfig, endpoints: {} });
    manager.loadOAuthToken = () => creds().encrypt(JSON.stringify({ access_token: accessToken }));
    expect(await new OAuthHandler(manager, creds()).ensureFreshToken(openaiConfig.id)).toBeNull();
  });

  it("redacts credential echoes in a token endpoint error", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "invalid_grant", error_description: "secret-authorization-code" }, { status: 400 }));
    const handler = new OAuthHandler(stubManager({ config: claudeConfig, endpoints: {} }), creds());
    const started = await handler.start(claudeConfig.id);
    const submitted = handler.submitCallback(started.state, `code#${started.state}`);
    await expect(submitted).rejects.toThrow("HTTP 400 (invalid_grant)");
    await expect(started.completion).rejects.not.toThrow(/secret-authorization-code/);
  });
});
