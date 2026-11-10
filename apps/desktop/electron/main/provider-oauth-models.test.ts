import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@claude-desktop/shared";
import { listOAuthModels, providerOAuthRequestHeaders } from "./provider-oauth-models";

const config = (type: "openai" | "claude" | "gemini"): ProviderConfig => ({ id: `${type}-1`, name: type, type, enabled: true, auth: { type, authMethod: "oauth2" } });
afterEach(() => vi.unstubAllGlobals());

describe("OAuth model catalogs", () => {
  it("preserves Codex supported_reasoning_levels and the account default", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ models: [{ slug: "gpt-6.1-sol", supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "xhigh", description: "Deep" }], default_reasoning_level: "xhigh" }] }));
    expect(await listOAuthModels(config("openai"), { access_token: "token" })).toEqual([
      { id: "gpt-6.1-sol", name: "gpt-6.1-sol", reasoningEfforts: ["low", "xhigh"], defaultReasoningEffort: "xhigh" },
    ]);
  });

  it("preserves other OAuth catalogs' advertised reasoning metadata without inferring account capabilities", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ data: [{ id: "claude-test", reasoning_efforts: ["medium", "high"], default_reasoning_effort: "medium" }] }));
    expect((await listOAuthModels(config("claude"), { access_token: "token" }))[0]).toMatchObject({ reasoningEfforts: ["medium", "high"], defaultReasoningEffort: "medium" });
    vi.stubGlobal("fetch", async () => Response.json({ models: [{ slug: "gpt-6.1-sol" }] }));
    expect((await listOAuthModels(config("openai"), { access_token: "token" }))[0]).not.toHaveProperty("reasoningEfforts");
  });

  it("uses the ChatGPT Codex catalog and maps slug/context metadata without contacting the platform API", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push(String(url));
      expect(init.headers).toMatchObject({ authorization: "Bearer subscription-token", "ChatGPT-Account-Id": "account-1" });
      return Response.json({ models: [{ slug: "gpt-example", display_name: "Example", context_window: 272000, visibility: "list", supported_in_api: true }, { slug: "hidden", visibility: "hidden" }] });
    });
    expect(await listOAuthModels(config("openai"), { access_token: "subscription-token", account_id: "account-1" })).toEqual([{ id: "gpt-example", name: "Example", contextLimit: 272000 }]);
    const url = new URL(requests[0]);
    expect(url.origin + url.pathname).toBe("https://chatgpt.com/backend-api/codex/models");
    expect(url.searchParams.get("client_version")).toBeTruthy();
  });

  it("fetches all Claude pages with OAuth beta headers and preserves server display names", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push(String(url));
      expect(init.headers).toMatchObject({ authorization: "Bearer claude-token", "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" });
      expect(init.headers).not.toHaveProperty("x-api-key");
      return requests.length === 1
        ? Response.json({ data: [{ id: "claude-one", display_name: "One", max_input_tokens: 200000 }], has_more: true, last_id: "claude-one" })
        : Response.json({ data: [{ id: "claude-two", display_name: "Two" }], has_more: false });
    });
    expect(await listOAuthModels(config("claude"), { access_token: "claude-token" })).toEqual([{ id: "claude-one", name: "One", contextLimit: 200000 }, { id: "claude-two", name: "Two" }]);
    expect(new URL(requests[0]).pathname).toBe("/v1/models");
    expect(new URL(requests[1]).searchParams.get("after_id")).toBe("claude-one");
  });

  it("lists user-authorized Google Generative Language models and follows page tokens", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push(String(url));
      expect(init.headers).toMatchObject({ authorization: "Bearer google-token" });
      expect(init.headers).not.toHaveProperty("x-goog-api-key");
      return requests.length === 1
        ? Response.json({ models: [{ name: "models/gemini-example", displayName: "Gemini", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next" })
        : Response.json({ models: [{ name: "models/gemini-two", supportedGenerationMethods: ["generateContent"] }] });
    });
    expect(await listOAuthModels({ ...config("gemini"), oauthProjectId: "my-project" }, { access_token: "google-token" })).toEqual([{ id: "gemini-example", name: "Gemini", contextLimit: 1048576 }, { id: "gemini-two", name: "gemini-two" }]);
    expect(new URL(requests[0]).origin).toBe("https://generativelanguage.googleapis.com");
    expect(new URL(requests[1]).searchParams.get("pageToken")).toBe("next");
  });

  it("never invents a model list when account access fails or the response shape is invalid", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "expired", access_token: "secret-echo" }, { status: 401 }));
    await expect(listOAuthModels(config("openai"), { access_token: "token" })).rejects.toThrow(/401/);
    vi.stubGlobal("fetch", async () => Response.json({ data: [{ id: "api-platform-model" }] }));
    await expect(listOAuthModels(config("openai"), { access_token: "token" })).rejects.toThrow(/catalog/i);
  });

  it("keeps OAuth and API-key headers distinct", () => {
    expect(providerOAuthRequestHeaders("claude", { access_token: "token" })).not.toHaveProperty("x-api-key");
    expect(() => providerOAuthRequestHeaders("deepseek", { access_token: "token" })).toThrow(/OAuth/);
  });

  it("includes the user's Google quota project in account requests", () => {
    expect(providerOAuthRequestHeaders("gemini", { access_token: "token" }, { oauthProjectId: "my-project" })).toMatchObject({ "x-goog-user-project": "my-project" });
  });
});
