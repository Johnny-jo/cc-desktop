import type { ModelInfo } from "@claude-desktop/shared";
type ProviderModelSettings = {
  get(): { models: string[]; defaultModel: string };
  update(patch: { models: string[]; defaultModel: string }): void;
};

/** Discovery is concurrent: a faster account must not displace another account's selection. */
export function applyProviderModelCatalog(catalog: ModelInfo[], settings: ProviderModelSettings, enabledIds: string[], validatedProviderId?: string): boolean {
  const models = catalog.map(model => model.id);
  const current = settings.get();
  const selectedProviderId = current.defaultModel.split("/")[0];
  const waitingForSelected = enabledIds.includes(selectedProviderId) && validatedProviderId !== selectedProviderId;
  const defaultModel = models.includes(current.defaultModel) || waitingForSelected ? current.defaultModel : models[0] ?? "";
  if (defaultModel && !models.includes(defaultModel)) models.push(defaultModel);
  if (models.length === current.models.length && models.every(id => current.models.includes(id)) && defaultModel === current.defaultModel) return false;
  settings.update({ models, defaultModel });
  return true;
}
