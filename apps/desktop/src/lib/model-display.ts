/** Display labels never change the ID used for routing or saved per-model settings. */
export function displayModelId(modelId: string, providers: readonly { id: string }[]): string {
  const provider = providers.find(({ id }) => modelId.startsWith(`${id}/`));
  return provider && modelId.length > provider.id.length + 1 ? modelId.slice(provider.id.length + 1) : modelId;
}
