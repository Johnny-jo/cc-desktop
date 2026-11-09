import { describe, expect, it, afterEach } from "vitest";
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
    expect(OAuthHandler.supportsOAuth("claude")).toBe(false);
    expect(OAuthHandler.supportsOAuth("openai")).toBe(false);
    expect(OAuthHandler.supportsOAuth("openai-compatible")).toBe(false);
  });
});

describe("OAuthHandler.start", () => {
  it("rejects providers without a public OAuth endpoint", async () => {
    const manager = stubManager({
      config: { ...geminiConfig, type: "claude", auth: { type: "claude", authMethod: "api-key" } },
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
