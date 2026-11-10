import type { DesktopApi } from "./desktop-api";
import { IPC } from "@claude-desktop/shared";

export type ModelSettingsDraft = { modelsCsv: string; defaultModel: string };
const modelIds = (csv: string): string[] => [...new Set(csv.split(",").map(id => id.trim()).filter(Boolean))];

/** Rebase synced models while preserving unsaved model choices and unrelated fields. */
export function mergeModelSettingsDraft<T extends ModelSettingsDraft>(draft: T, previous: ModelSettingsDraft, next: ModelSettingsDraft): T {
  const before = modelIds(previous.modelsCsv);
  const edited = modelIds(draft.modelsCsv);
  const removed = new Set(before.filter(id => !edited.includes(id)));
  const added = edited.filter(id => !before.includes(id));
  const merged = [...new Set([...modelIds(next.modelsCsv).filter(id => !removed.has(id)), ...added])];
  const preferred = draft.defaultModel !== previous.defaultModel ? draft.defaultModel : next.defaultModel;
  const defaultModel = merged.includes(preferred) ? preferred : merged.includes(next.defaultModel) ? next.defaultModel : merged[0] ?? "";
  const modelsCsv = merged.join(", ");
  return draft.modelsCsv === modelsCsv && draft.defaultModel === defaultModel ? draft : { ...draft, modelsCsv, defaultModel };
}

/** Capability updates can leave the configured model IDs unchanged. */
export function subscribeProviderModelUpdates(desktop: Pick<DesktopApi, "on"> | null, refresh: () => Promise<void>): (() => void) | undefined {
  if (typeof desktop?.on !== "function") return undefined;
  const subscriptions = [IPC.providerUpdated, IPC.modelCatalogUpdated].map(channel =>
    desktop.on(channel, () => { void refresh(); }),
  );
  return () => { for (const unsubscribe of subscriptions) unsubscribe(); };
}
