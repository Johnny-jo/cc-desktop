import type { AppSettings, ModelInfo } from "@claude-desktop/shared";

/** Narrow slice of SettingsStore used by the CPA model sync (easy to fake in tests). */
export type CpaModelSettings = {
  get(): Pick<AppSettings, "models" | "defaultModel">;
  update(patch: { models: string[]; defaultModel: string }): void;
};

/**
 * Apply CPA's live model catalog to settings (model list + default model).
 *
 * Returns true when settings actually changed — the caller should then
 * broadcast IPC.settingsUpdated. Empty catalogs are ignored so a
 * half-started CPA never wipes the configured model list.
 */
export function applyCpaModelCatalog(
  catalog: ModelInfo[],
  settings: CpaModelSettings,
): boolean {
  const models = catalog.map((m) => m.id);
  if (models.length === 0) return false;
  const current = settings.get();
  // Set-compare: CPA's list order is not stable enough to diff on.
  const sameModels =
    models.length === current.models.length &&
    models.every((id) => current.models.includes(id));
  const defaultModel = models.includes(current.defaultModel)
    ? current.defaultModel
    : models[0];
  if (sameModels && defaultModel === current.defaultModel) return false;
  settings.update({ models, defaultModel });
  return true;
}
