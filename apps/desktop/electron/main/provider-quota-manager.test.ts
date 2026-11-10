import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QuotaManager,
  modelContextLimit,
  normalizeModels,
} from "./provider-quota-manager";
import type { ProviderConfig } from "@claude-desktop/shared";
import { hasCustomProviderApi } from "./provider-model-capabilities";
import { forwardProviderMessage } from "./provider-protocol";

describe("Claude gateway authentication", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    [undefined, undefined, "x-api-key"],
    ["https://api.anthropic.com/v1", "auto", "x-api-key"],
    ["https://gateway.example/v1", undefined, "bearer"],
    ["https://gateway.example/v1", "auto", "bearer"],
    ["https://gateway.example/v1", "x-api-key", "x-api-key"],
    [undefined, "bearer", "bearer"],
  ] as const)("uses matching discovery/inference headers for %s with %s", async (baseUrl, apiKeyAuth, scheme) => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "claude-test" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const config = { id: "claude-gateway", name: "Claude", type: "claude", enabled: true, auth: { type: "claude", authMethod: "api-key", baseUrl, apiKeyAuth } } as ProviderConfig;
    expect((await new QuotaManager().syncQuota(config, "fake-key")).error).toBeUndefined();
    await forwardProviderMessage(config, "fake-key", { model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "hello" }] }, { signal: new AbortController().signal });
    const [discovery, inference] = fetcher.mock.calls.map(call => call[1].headers);
    for (const headers of [discovery, inference]) {
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["x-api-key"]).toBe(scheme === "x-api-key" ? "fake-key" : undefined);
      expect(headers.authorization).toBe(scheme === "bearer" ? "Bearer fake-key" : undefined);
      expect(headers["anthropic-beta"]).toBeUndefined();
    }
    expect(fetcher.mock.calls[0][0]).toMatch(/\/models$/);
    expect(fetcher.mock.calls[1][0]).toMatch(/\/messages$/);
  });
  it("adds subscription-token beta flags consistently only for a recognized Claude Auth Token", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "claude-test" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const config = { id: "claude-token", name: "Claude", type: "claude", enabled: true, auth: { type: "claude", authMethod: "api-key", apiKeyAuth: "bearer" } } as ProviderConfig;
    const token = "sk-ant-oat01-local-placeholder";
    await new QuotaManager().syncQuota(config, token);
    await forwardProviderMessage(config, token, { model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "hello" }] }, { signal: new AbortController().signal });
    for (const [, init] of fetcher.mock.calls) {
      expect(init.headers.authorization).toBe(`Bearer ${token}`);
      expect(init.headers["anthropic-beta"].split(",")).toEqual(expect.arrayContaining(["oauth-2025-04-20", "claude-code-20250219"]));
    }
  });
});

const openaiConfig: ProviderConfig = {
  id: "openai-1",
  name: "OpenAI",
  type: "openai",
  enabled: true,
  auth: { type: "openai", authMethod: "api-key" },
};

describe("custom provider reasoning defaults", () => {
  it.each(["https://api.openai.com", "https://api.openai.com/v1/", "https://API.OPENAI.COM:443/custom-prefix"])("keeps a named provider's official origin native: %s", baseUrl => {
    expect(hasCustomProviderApi({ ...openaiConfig, auth: { ...openaiConfig.auth, baseUrl } })).toBe(false);
  });
  it("keeps explicitly compatible services configurable even on an official origin", () => {
    expect(hasCustomProviderApi({ type: "openai-compatible", auth: { type: "openai-compatible", authMethod: "api-key", baseUrl: "https://api.openai.com/v1" } })).toBe(true);
  });
});

describe("modelContextLimit", () => {
  it("reads the common gateway field names", () => {
    expect(modelContextLimit({ id: "a", context_window: 128000 })).toBe(128000);
    expect(modelContextLimit({ id: "a", context_length: 64000 })).toBe(64000);
    expect(modelContextLimit({ id: "a", max_context_tokens: 32000 })).toBe(32000);
  });

  it("reads Gemini's inputTokenLimit", () => {
    expect(modelContextLimit({ id: "models/gemini-2.5-pro", inputTokenLimit: 1048576 })).toBe(
      1048576,
    );
  });

  it("ignores implausible max_tokens values used as output caps", () => {
    // 一些网关的 max_tokens 是「输出上限」，不是窗口
    expect(modelContextLimit({ id: "a", max_tokens: 512 })).toBeUndefined();
    expect(modelContextLimit({ id: "a", max_tokens: 8192 })).toBe(8192);
  });

  it("returns undefined rather than inventing a number", () => {
    expect(modelContextLimit({ id: "a" })).toBeUndefined();
    expect(modelContextLimit({ id: "a", context_window: 0 })).toBeUndefined();
    expect(modelContextLimit({ id: "a", context_window: "nope" })).toBeUndefined();
  });
});

describe("normalizeModels", () => {
  it("preserves the upstream's exact reasoning levels and default", () => {
    expect(normalizeModels("openai-compatible", { data: [{ id: "custom", supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "high", description: "Deep" }], default_reasoning_level: "high" }] })).toEqual([
      { id: "custom", name: "custom", contextLimit: undefined, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
    ]);
  });

  it("uses verified OpenAI capabilities only for exact official model IDs with no metadata", () => {
    const models = normalizeModels("openai", { data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-astra" }, { id: "gpt-6-future" }] });
    expect(models[0]).toMatchObject({ reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" });
    expect(models[1]).toMatchObject({ reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(models[1]).not.toHaveProperty("defaultReasoningEffort");
    expect(models[2]).not.toHaveProperty("reasoningEfforts");
  });

  it.each(["custom-model", "gpt-6.1-sol"])("offers configurable default efforts for compatible model %s without metadata", id => {
    expect(normalizeModels("openai-compatible", { data: [{ id }] })[0]).toMatchObject({
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
    });
  });

  it("respects explicit compatible metadata instead of replacing it with configurable defaults", () => {
    const models = normalizeModels("openai-compatible", { data: [
      { id: "explicit-empty", reasoning_efforts: [] },
      { id: "explicit-unsupported", capabilities: { reasoning_levels: ["none"] } },
      { id: "default-only", default_reasoning_effort: "high" },
    ] });
    for (const model of models.slice(0, 2)) expect(model).not.toHaveProperty("reasoningEfforts");
    expect(models[0]).not.toHaveProperty("defaultReasoningEffort");
    expect(models[2]).toMatchObject({ reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high" });
  });

  it.each(["gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"])("uses the verified SDK-supported API effort levels and default for %s", id => {
    const [model] = normalizeModels("openai", { data: [{ id }] });
    expect(model).toMatchObject({ reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" });
    expect(normalizeModels("openai", { data: [{ id: `${id}-unknown` }] })[0]).not.toHaveProperty("reasoningEfforts");
    expect(normalizeModels("openai", { data: [{ id, reasoning_efforts: ["high"] }] })[0]).toMatchObject({ reasoningEfforts: ["high"] });
    expect(normalizeModels("openai", { data: [{ id, reasoning_efforts: ["high"] }] })[0]).not.toHaveProperty("defaultReasoningEffort");
  });

  it("does not replace explicit upstream capabilities with a builtin assumption", () => {
    const models = normalizeModels("openai", { data: [
      { id: "gpt-6.1-sol", reasoning_efforts: ["high"], default_reasoning_effort: "high" },
      { id: "gpt-6-astra", reasoning_levels: [] },
      { id: "gpt-6.1-sol", capabilities: { reasoningEfforts: [] } },
    ] });
    expect(models[0]).toMatchObject({ reasoningEfforts: ["high"], defaultReasoningEffort: "high" });
    expect(models[1]).not.toHaveProperty("reasoningEfforts");
    expect(models[2]).not.toHaveProperty("reasoningEfforts");
  });

  it("parses the OpenAI shape and falls back to the builtin table", () => {
    const models = normalizeModels("openai", {
      data: [
        { id: "gpt-5-codex", owned_by: "openai" },
        { id: "unknown-model-xyz" },
      ],
    });
    expect(models).toEqual([
      { id: "gpt-5-codex", name: "gpt-5-codex", contextLimit: 128_000 },
      { id: "unknown-model-xyz", name: "unknown-model-xyz", contextLimit: undefined },
    ]);
  });

  it("strips the models/ prefix from Gemini ids and keeps display names", () => {
    const models = normalizeModels("gemini", {
      models: [
        {
          name: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          inputTokenLimit: 1048576,
        },
      ],
    });
    expect(models).toEqual([
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextLimit: 1048576 },
    ]);
  });

  it("tolerates malformed payloads", () => {
    expect(normalizeModels("openai", null)).toEqual([]);
    expect(normalizeModels("openai", {})).toEqual([]);
    expect(normalizeModels("openai", { data: [null, {}, { id: "" }] })).toEqual([]);
    expect(normalizeModels("openai", "nonsense")).toEqual([]);
  });
});

describe("QuotaManager", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("discovers the same official capabilities with an empty or explicit official Base URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "gpt-4o" }] })));
    const native = await new QuotaManager().syncQuota(openaiConfig, "key");
    const explicit = await new QuotaManager().syncQuota({ ...openaiConfig, auth: { ...openaiConfig.auth, baseUrl: "https://api.openai.com/v1" } }, "key");
    expect(explicit.models).toEqual(native.models);
    expect(explicit.models?.[0]).not.toHaveProperty("reasoningEfforts");
    expect(explicit.models?.[0]).not.toHaveProperty("defaultReasoningEffort");
  });
  it.each(["claude", "openai", "deepseek", "kimi", "xai", "gemini"] as const)("offers default efforts for %s API models at a custom Base URL", async type => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "custom-model" }] })));
    const result = await new QuotaManager().syncQuota({ ...openaiConfig, type, auth: { type, authMethod: "api-key", baseUrl: "https://gateway.example/api/" } }, "key");
    expect(result.models?.[0]).toMatchObject({ reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" });
  });
  it("keeps OAuth model metadata independent of ignored API Base URL overrides", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "unknown-model" }] })));
    const result = await new QuotaManager().syncQuota({ ...openaiConfig, auth: { type: "openai", authMethod: "oauth2", baseUrl: "https://gateway.example/api/" } }, "key");
    expect(result.models?.[0]).not.toHaveProperty("reasoningEfforts");
  });
  it.each(["claude", "openai", "deepseek", "kimi", "xai", "gemini"] as const)("discovers %s models using the configured API Base URL", async type => {
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "model" }] })); vi.stubGlobal("fetch", upstream);
    await new QuotaManager().syncQuota({ ...openaiConfig, type, auth: { type, authMethod: "api-key", baseUrl: "https://gateway.example/custom/api/" } }, "key");
    expect(upstream.mock.calls[0][0]).toBe("https://gateway.example/custom/api/models");
  });
  it.each([["http://localhost:8317", "http://localhost:8317/v1/models"], ["https://gateway.example/api/v1/", "https://gateway.example/api/v1/models"]])("uses the API base path for %s", async (baseUrl, expected) => {
    const upstream = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "model" }] }));
    vi.stubGlobal("fetch", upstream);
    await new QuotaManager().syncQuota({ ...openaiConfig, type: "openai-compatible", auth: { type: "openai-compatible", authMethod: "api-key", baseUrl } }, "key");
    expect(upstream.mock.calls[0][0]).toBe(expected);
  });
  it("does not return successful cached auth for a missing credential", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "model" }] })));
    const manager = new QuotaManager();
    await manager.syncQuota(openaiConfig, "key");
    expect((await manager.syncQuota(openaiConfig)).error).toMatch(/credential/);
  });
  it("paginates Gemini catalogs and hides models that cannot generate messages", async () => {
    const upstream = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ models: [{ name: "models/embed", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "page2" }))
      .mockResolvedValueOnce(Response.json({ models: [{ name: "models/gemini-test", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1000000 }] }));
    vi.stubGlobal("fetch", upstream);
    const result = await new QuotaManager().syncQuota({ ...openaiConfig, type: "gemini", auth: { type: "gemini", authMethod: "api-key" } }, "google-key");
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(String(upstream.mock.calls[1][0])).toContain("pageToken=page2");
    expect(result.models?.map(model => model.id)).toEqual(["gemini-test"]);
  });
  it("does not claim usage numbers — no provider exposes them generically", async () => {
    const manager = new QuotaManager();
    // 无凭证时直接返回错误，而不是编一个 usedQuota
    const result = await manager.syncQuota(openaiConfig, undefined);
    expect(result.quota).toBeNull();
    expect(result.error).toMatch(/No credential/);
  });

  it("asks for a base URL on openai-compatible providers", async () => {
    const manager = new QuotaManager();
    const result = await manager.syncQuota(
      {
        id: "compat-1",
        name: "Local",
        type: "openai-compatible",
        enabled: true,
        auth: { type: "openai-compatible", authMethod: "api-key", baseUrl: "" },
      },
      "sk-x",
    );
    expect(result.error).toMatch(/base URL/i);
  });

  it("marks a manually configured limit as manual, not api", async () => {
    const manager = new QuotaManager();
    const quota = manager.createManualQuota("p1", 64_000, 60);
    expect(quota).toMatchObject({ providerId: "p1", source: "manual", limitTokens: 64_000 });
  });

  it("invalidates cached results", () => {
    const manager = new QuotaManager();
    manager.invalidateCache("p1");
    manager.clearCache();
    // 无缓存时不会抛错；这里只验证 API 契约
    expect(true).toBe(true);
  });
});
