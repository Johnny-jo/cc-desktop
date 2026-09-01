import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@claude-desktop/shared";
import { applyCpaModelCatalog } from "./cpa-model-sync";

function fakeSettings(models: string[], defaultModel: string) {
  const state = { models: [...models], defaultModel };
  return {
    state,
    get: () => ({ models: [...state.models], defaultModel: state.defaultModel }),
    update(patch: { models: string[]; defaultModel: string }) {
      state.models = [...patch.models];
      state.defaultModel = patch.defaultModel;
    },
  };
}

const catalog = (...ids: string[]): ModelInfo[] => ids.map((id) => ({ id }));

describe("applyCpaModelCatalog", () => {
  it("ignores an empty catalog so a half-started CPA never wipes settings", () => {
    const settings = fakeSettings(["a", "b"], "a");
    expect(applyCpaModelCatalog([], settings)).toBe(false);
    expect(settings.state).toEqual({ models: ["a", "b"], defaultModel: "a" });
  });

  it("is a no-op when the model set is unchanged (order-independent)", () => {
    const settings = fakeSettings(["a", "b"], "b");
    expect(applyCpaModelCatalog(catalog("b", "a"), settings)).toBe(false);
    expect(settings.state).toEqual({ models: ["a", "b"], defaultModel: "b" });
  });

  it("adds newly synced models and keeps the current defaultModel", () => {
    const settings = fakeSettings(["a"], "a");
    expect(applyCpaModelCatalog(catalog("a", "b", "c"), settings)).toBe(true);
    expect(settings.state).toEqual({ models: ["a", "b", "c"], defaultModel: "a" });
  });

  it("drops removed models and falls back to the first model when the default is gone", () => {
    const settings = fakeSettings(["a", "gone"], "gone");
    expect(applyCpaModelCatalog(catalog("a", "b"), settings)).toBe(true);
    expect(settings.state).toEqual({ models: ["a", "b"], defaultModel: "a" });
  });

  it("keeps provider-prefixed ids from openai-compatibility providers as-is", () => {
    const settings = fakeSettings([], "");
    expect(
      applyCpaModelCatalog(catalog("ark/kimi-k3", "g2a/grok-4.6"), settings),
    ).toBe(true);
    expect(settings.state).toEqual({
      models: ["ark/kimi-k3", "g2a/grok-4.6"],
      defaultModel: "ark/kimi-k3",
    });
  });
});
