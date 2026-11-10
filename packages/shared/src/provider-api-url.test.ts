import { describe, expect, it } from "vitest";
import type { ProviderConfig, ProviderType } from "./provider-types";
import { normalizeProviderBaseUrl, providerApiUrl } from "./provider-api-url";

const config = (type: ProviderType, baseUrl?: string, authMethod = "api-key") => ({ type, auth: { type, authMethod, baseUrl } }) as ProviderConfig;

describe("provider API URLs", () => {
  it.each([
    ["claude", "https://api.anthropic.com/v1/models"], ["openai", "https://api.openai.com/v1/models"],
    ["deepseek", "https://api.deepseek.com/v1/models"], ["kimi", "https://api.moonshot.cn/v1/models"],
    ["xai", "https://api.x.ai/v1/models"], ["gemini", "https://generativelanguage.googleapis.com/v1beta/models"],
  ] as const)("keeps %s's official default when Base URL is blank", (type, expected) => {
    expect(providerApiUrl(config(type, "  "), "models")).toBe(expected);
  });
  it.each(["claude", "openai", "deepseek", "kimi", "xai", "gemini", "openai-compatible"] as const)("uses the same custom API prefix for %s models and inference", type => {
    expect(providerApiUrl(config(type, " https://gateway.example/custom/v1/ "), "models")).toBe("https://gateway.example/custom/v1/models");
    expect(providerApiUrl(config(type, "https://gateway.example/custom/v1"), "messages")).toBe("https://gateway.example/custom/v1/messages");
  });
  it("adds the default version only to a bare host", () => {
    expect(providerApiUrl(config("openai", "http://localhost:8080/"), "responses")).toBe("http://localhost:8080/v1/responses");
    expect(providerApiUrl(config("gemini", "https://gateway.example"), "models/gemini-test:generateContent")).toBe("https://gateway.example/v1beta/models/gemini-test:generateContent");
    expect(providerApiUrl(config("gemini", "https://gateway.example"), "models/gemini-test:streamGenerateContent?alt=sse")).toBe("https://gateway.example/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
    expect(providerApiUrl(config("openai", "https://gateway.example/api"), "chat/completions")).toBe("https://gateway.example/api/chat/completions");
  });
  it("also accepts an endpoint URL consistently for discovery and generation", () => {
    const provider = config("openai-compatible", "https://gateway.example/api/v1/chat/completions/");
    expect(providerApiUrl(provider, "models")).toBe("https://gateway.example/api/v1/models");
    expect(providerApiUrl(provider, "chat/completions")).toBe("https://gateway.example/api/v1/chat/completions");
    const rootEndpoint = config("openai-compatible", "https://gateway.example/chat/completions");
    expect(providerApiUrl(rootEndpoint, "chat/completions")).toBe("https://gateway.example/chat/completions");
    expect(providerApiUrl(rootEndpoint, "models")).toBe("https://gateway.example/models");
  });
  it("preserves custom base prefixes that happen to use resource names", () => {
    for (const path of ["models", "messages", "responses"]) {
      const provider = config("openai-compatible", `https://gateway.example/proxy/${path}`);
      expect(providerApiUrl(provider, "chat/completions")).toBe(`https://gateway.example/proxy/${path}/chat/completions`);
      expect(providerApiUrl(provider, "models")).toBe(`https://gateway.example/proxy/${path}/models`);
    }
  });
  it("requires an explicit compatible API address", () => {
    expect(() => providerApiUrl(config("openai-compatible", ""), "models")).toThrow(/Base URL/i);
  });
  it.each(["ftp://host/v1", "file:///tmp/gateway", "https://user:pass@host/v1", "https://host/v1?key=secret", "https://host/v1#fragment", "invalid"])("rejects invalid API bases: %s", base => {
    expect(() => normalizeProviderBaseUrl(base)).toThrow(/Base URL/i);
    expect(() => providerApiUrl(config("claude", base), "messages")).toThrow(/Base URL/i);
  });
  it.each(["claude", "openai", "gemini"] as const)("does not send %s OAuth credentials to an API-key override", type => {
    const url = providerApiUrl(config(type, "https://gateway.example/v1", "oauth2"), "models");
    expect(new URL(url).hostname).not.toBe("gateway.example");
  });
});
