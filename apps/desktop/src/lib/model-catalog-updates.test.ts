import { describe, expect, it, vi } from "vitest";
import { IPC } from "@claude-desktop/shared";
import { mergeModelSettingsDraft, subscribeProviderModelUpdates } from "./model-catalog-updates";

describe("live model settings drafts", () => {
  const previous = { modelsCsv: "account/old", defaultModel: "account/old" };
  const next = { modelsCsv: "account/old, gateway/a, gateway/b, gateway/c, gateway/d, gateway/e, gateway/f", defaultModel: "account/old" };
  it("adds synced models to an open clean draft immediately", () => {
    expect(mergeModelSettingsDraft(previous, previous, next)).toEqual(next);
  });
  it("keeps unsaved preferences and manually added/removed model choices", () => {
    const draft = { modelsCsv: "manual/model", defaultModel: "manual/model", context: "123456" };
    expect(mergeModelSettingsDraft(draft, previous, next)).toEqual({ ...draft, modelsCsv: "gateway/a, gateway/b, gateway/c, gateway/d, gateway/e, gateway/f, manual/model" });
  });
  it("removes a deleted provider's models and adopts the new default when untouched", () => {
    expect(mergeModelSettingsDraft({ ...previous, font: "15" }, previous, { modelsCsv: "other/model", defaultModel: "other/model" })).toEqual({ modelsCsv: "other/model", defaultModel: "other/model", font: "15" });
  });
  it("does not retain a stale default after that model disappears", () => {
    expect(mergeModelSettingsDraft({ modelsCsv: "account/old, gateway/a", defaultModel: "gateway/a" }, { modelsCsv: "account/old, gateway/a", defaultModel: "account/old" }, { modelsCsv: "gateway/b", defaultModel: "gateway/b" })).toEqual({ modelsCsv: "gateway/b", defaultModel: "gateway/b" });
  });
});

describe("provider model catalog update subscription", () => {
  it("refreshes capabilities on provider updates even when model IDs stay the same and returns listener cleanup", async () => {
    const unsubscribe = vi.fn();
    const listeners = new Map<string, () => void>();
    const on = vi.fn((channel: string, callback: () => void) => { listeners.set(channel, callback); return unsubscribe; });
    const refresh = vi.fn(async () => {});
    const cleanup = subscribeProviderModelUpdates({ on }, refresh);
    expect(on).toHaveBeenCalledWith(IPC.providerUpdated, expect.any(Function));
    expect(on).toHaveBeenCalledWith(IPC.modelCatalogUpdated, expect.any(Function));
    expect(refresh).not.toHaveBeenCalled();
    listeners.get(IPC.providerUpdated)!();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    listeners.get(IPC.modelCatalogUpdated)!();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup!();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("supports missing desktop APIs and older mocks without a subscription method", () => {
    const refresh = vi.fn(async () => {});
    expect(subscribeProviderModelUpdates(null, refresh)).toBeUndefined();
    expect(subscribeProviderModelUpdates({} as never, refresh)).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });
});
