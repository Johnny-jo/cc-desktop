/**
 * OAuth 2.0 流程处理
 * 支持 PKCE、token 刷新、安全存储
 */

import { createHash, randomBytes } from "node:crypto";
import type { ProviderConfig } from "@claude-desktop/shared";
import { ProviderManager } from "./provider-manager";
import { CredentialManager } from "./credential-manager";

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export class OAuthHandler {
  private pkceVerifiers: Map<string, string> = new Map(); // state -> verifier

  constructor(private providerManager: ProviderManager) {}

  /**
   * 生成 PKCE code challenge
   */
  private generatePKCE(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("hex").slice(0, 128);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  /**
   * 生成 OAuth 授权 URL（带 PKCE）
   */
  generateAuthorizationUrl(
    providerType: string,
    clientId: string,
    redirectUri: string = "http://localhost:5173/oauth-callback",
  ): { url: string; state: string } | null {
    try {
      const oauthConfig = this.providerManager.getOAuthConfig(providerType);
      if (!oauthConfig.authorizationUrl) {
        return null;
      }

      const state = randomBytes(32).toString("hex");
      const { verifier, challenge } = this.generatePKCE();

      // 存储 verifier 以供后续交换时使用
      this.pkceVerifiers.set(state, verifier);

      const params: Record<string, string> = {
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      };

      if (oauthConfig.scope) {
        params.scope = oauthConfig.scope;
      }

      const url = `${oauthConfig.authorizationUrl}?${new URLSearchParams(params).toString()}`;
      return { url, state };
    } catch (err) {
      console.error("Failed to generate authorization URL:", err);
      return null;
    }
  }

  /**
   * 交换授权码获取 token（Claude）
   */
  private async exchangeCodeClaude(
    code: string,
    clientId: string,
    clientSecret: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenResponse> {
    const response = await fetch("https://api.anthropic.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Claude OAuth error: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * 交换授权码获取 token（OpenAI）
   */
  private async exchangeCodeOpenAI(
    code: string,
    clientId: string,
    clientSecret: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenResponse> {
    const response = await fetch("https://platform.openai.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`OpenAI OAuth error: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * 交换授权码获取 token（Gemini）
   */
  private async exchangeCodeGemini(
    code: string,
    clientId: string,
    clientSecret: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenResponse> {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Gemini OAuth error: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * 通用交换码获取 token
   */
  async exchangeCode(
    providerType: string,
    code: string,
    clientId: string,
    clientSecret: string,
    state: string,
    redirectUri: string = "http://localhost:5173/oauth-callback",
  ): Promise<OAuthTokenResponse> {
    const codeVerifier = this.pkceVerifiers.get(state);
    if (!codeVerifier) {
      throw new Error("Invalid OAuth state or code verifier not found");
    }

    try {
      let tokenResponse: OAuthTokenResponse;

      switch (providerType) {
        case "claude":
          tokenResponse = await this.exchangeCodeClaude(code, clientId, clientSecret, codeVerifier, redirectUri);
          break;
        case "openai":
          tokenResponse = await this.exchangeCodeOpenAI(code, clientId, clientSecret, codeVerifier, redirectUri);
          break;
        case "gemini":
          tokenResponse = await this.exchangeCodeGemini(code, clientId, clientSecret, codeVerifier, redirectUri);
          break;
        default:
          throw new Error(`OAuth not supported for ${providerType}`);
      }

      // 清除已使用的 verifier
      this.pkceVerifiers.delete(state);

      return tokenResponse;
    } catch (err) {
      this.pkceVerifiers.delete(state);
      throw err;
    }
  }

  /**
   * 刷新 token（Claude）
   */
  private async refreshTokenClaude(
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<OAuthTokenResponse> {
    const response = await fetch("https://api.anthropic.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Claude token refresh error: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * 刷新 token（OpenAI）
   */
  private async refreshTokenOpenAI(
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<OAuthTokenResponse> {
    const response = await fetch("https://platform.openai.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`OpenAI token refresh error: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * 通用刷新 token
   */
  async refreshToken(
    providerType: string,
    refreshToken: string,
    clientId: string,
    clientSecret: string,
  ): Promise<OAuthTokenResponse> {
    switch (providerType) {
      case "claude":
        return this.refreshTokenClaude(refreshToken, clientId, clientSecret);
      case "openai":
        return this.refreshTokenOpenAI(refreshToken, clientId, clientSecret);
      case "gemini":
        // Gemini 使用标准 OAuth2 刷新
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
          }).toString(),
        });

        if (!response.ok) {
          throw new Error(`Gemini token refresh error: ${response.statusText}`);
        }

        return response.json();
      default:
        throw new Error(`Token refresh not supported for ${providerType}`);
    }
  }

  /**
   * 保存 OAuth token（加密）
   */
  saveOAuthToken(providerId: string, token: OAuthTokenResponse): void {
    const encrypted = CredentialManager.encrypt(JSON.stringify(token));
    this.providerManager.saveApiKey(`${providerId}-oauth`, encrypted);
  }

  /**
   * 读取 OAuth token（解密）
   */
  loadOAuthToken(providerId: string): OAuthTokenResponse | null {
    const encrypted = this.providerManager.loadApiKey(`${providerId}-oauth`);
    if (!encrypted) return null;

    try {
      const decrypted = CredentialManager.decrypt(encrypted);
      return JSON.parse(decrypted);
    } catch {
      return null;
    }
  }

  /**
   * 删除 OAuth token
   */
  deleteOAuthToken(providerId: string): void {
    this.providerManager.deleteApiKey(`${providerId}-oauth`);
  }
}
