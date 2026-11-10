import { describe, expect, it, vi } from "vitest";
import { applyProviderModelCatalog } from "./provider-model-sync";
function setup() {
  const state = { models: ["second/model"], defaultModel: "second/model" };
  const update = vi.fn(patch => Object.assign(state, patch));
  return { state, settings: { get: () => state, update } };
}
describe("native model catalog sync", () => {
  it("keeps the selected account while a different account finishes discovery first", () => {
    const { state, settings } = setup();
    applyProviderModelCatalog([{ id: "first/model" }], settings, ["first", "second"], "first");
    expect(state.defaultModel).toBe("second/model");
    expect(state.models).toContain("second/model");
  });
  it("replaces a removed model only after its own account catalog is validated", () => {
    const { state, settings } = setup();
    applyProviderModelCatalog([{ id: "second/new-model" }], settings, ["second"], "second");
    expect(state.defaultModel).toBe("second/new-model");
  });
  it("clears model selection when the last account is deleted", () => {
    const { state, settings } = setup();
    applyProviderModelCatalog([], settings, []);
    expect(state).toEqual({ models: [], defaultModel: "" });
  });
});
