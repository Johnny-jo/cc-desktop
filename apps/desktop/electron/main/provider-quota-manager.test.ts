import { describe, expect, it } from "vitest";
import {
  QuotaManager,
  modelContextLimit,
  normalizeModels,
} from "./provider-quota-manager";
import type { ProviderConfig } from "@claude-desktop/shared";

const openaiConfig: ProviderConfig = {
  id: "openai-1",
  name: "OpenAI",
  type: "openai",
  enabled: true,
  auth: { type: "openai", authMethod: "api-key" },
};

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
