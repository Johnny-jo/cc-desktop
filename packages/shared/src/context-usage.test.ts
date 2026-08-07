import { describe, expect, it } from "vitest";
import {
  computeContextUsage,
  extractUsedTokens,
  parseModelContextLimit,
  resolveContextLimit,
} from "./context-usage";
import type { TurnUsage } from "./models";

describe("extractUsedTokens", () => {
  it("prefers inputTokens", () => {
    expect(
      extractUsedTokens({
        inputTokens: 1000,
        cacheReadTokens: 50,
        cacheCreationTokens: 10,
      }),
    ).toBe(1000);
  });

  it("falls back to cache sum when input missing", () => {
    expect(
      extractUsedTokens({
        cacheReadTokens: 80,
        cacheCreationTokens: 20,
      }),
    ).toBe(100);
  });

  it("returns undefined when no usable fields", () => {
    expect(extractUsedTokens({})).toBeUndefined();
    expect(extractUsedTokens(undefined)).toBeUndefined();
  });
});

describe("resolveContextLimit", () => {
  it("priority: override > cpa > builtin > default", () => {
    const settings = {
      defaultContextLimit: 200_000,
      modelContextLimits: { "deepseek-v4-flash": 64_000 },
    };
    const catalog = [
      { id: "deepseek-v4-flash", contextLimit: 128_000 },
      { id: "mystery-model" },
    ];

    expect(
      resolveContextLimit("deepseek-v4-flash", settings, catalog),
    ).toEqual({ limitTokens: 64_000, source: "override" });

    expect(
      resolveContextLimit(
        "deepseek-v4-flash",
        { ...settings, modelContextLimits: {} },
        catalog,
      ),
    ).toEqual({ limitTokens: 128_000, source: "cpa" });

    expect(resolveContextLimit("claude-opus-5", settings, [])).toEqual({
      limitTokens: 200_000,
      source: "builtin",
    });

    expect(resolveContextLimit("totally-unknown-xyz", settings, [])).toEqual({
      limitTokens: 200_000,
      source: "default",
    });
  });
});

describe("parseModelContextLimit", () => {
  it("reads common field names", () => {
    expect(parseModelContextLimit({ context_length: 131072 })).toBe(131072);
    expect(parseModelContextLimit({ max_model_len: 32000 })).toBe(32000);
    expect(parseModelContextLimit({ context_window: 200000 })).toBe(200000);
    // max_tokens only if >= 1024
    expect(parseModelContextLimit({ max_tokens: 4096 })).toBe(4096);
    expect(parseModelContextLimit({ max_tokens: 512 })).toBeUndefined();
    expect(parseModelContextLimit({ metadata: { context_length: 99999 } })).toBe(
      99999,
    );
  });
});

describe("computeContextUsage", () => {
  it("builds ratio and drops when used unknown", () => {
    const turn: TurnUsage = { inputTokens: 160_000 };
    const u = computeContextUsage({
      turn,
      modelId: "kimi-for-coding",
      settings: { defaultContextLimit: 200_000, modelContextLimits: {} },
      catalog: [],
      now: 1_700_000_000_000,
    });
    expect(u).toMatchObject({
      usedTokens: 160_000,
      limitTokens: 200_000, // kimi-for-coding no longer matched by builtin; falls to default
      source: "default",
      modelId: "kimi-for-coding",
      updatedAt: 1_700_000_000_000,
    });
    expect(u!.ratio).toBeCloseTo(160_000 / 200_000);

    expect(
      computeContextUsage({
        turn: { durationMs: 1 },
        modelId: "x",
        settings: { defaultContextLimit: 200_000, modelContextLimits: {} },
        catalog: [],
        now: 1,
      }),
    ).toBeUndefined();
  });
});
