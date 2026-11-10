import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig, ProviderModel } from "@claude-desktop/shared";
import { ProviderRuntime } from "./provider-runtime";

afterEach(() => vi.unstubAllGlobals());

describe("Provider model catalog capabilities", () => {
  it("keeps reasoning metadata on qualified catalog IDs and context overrides", async () => {
    const config: ProviderConfig = { id: "account", name: "Account", type: "openai", enabled: true, auth: { type: "openai", authMethod: "api-key" }, contextLimitOverride: 64000 };
    const models: ProviderModel[] = [{ id: "company/model", name: "Model", contextLimit: 128000, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }];
    const runtime = new ProviderRuntime({
      providerManager: { listConfigs: () => [config], getConfig: () => config, loadApiKey: () => "key", updateConfig: () => true },
      credentials: { decrypt: () => "key" },
      oauthHandler: {},
      quotaManager: { invalidateCache: () => {}, syncQuota: async () => ({ providerId: config.id, quota: null, models }) },
      getDefaultModel: () => "account/company/model",
    } as unknown as ConstructorParameters<typeof ProviderRuntime>[0]);
    await runtime.syncProvider(config.id);
    expect(runtime.getModelCatalog()).toEqual([{ id: "account/company/model", contextLimit: 64000, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }]);
    runtime.mergeSdkModelCapabilities([{ value: "account/company/model", supportsEffort: true, supportedEffortLevels: ["medium", "max"] }]);
    expect(runtime.getModelCatalog()[0].reasoningEfforts).toEqual(["low", "high"]);
  });
});
