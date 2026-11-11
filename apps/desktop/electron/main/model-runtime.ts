import type { CpaStatus, ModelInfo, ModelQuotaInfo } from "@claude-desktop/shared";

/** Model transport used by chat and rooms. Legacy IPC status names remain wire compatible. */
export interface ModelRuntime {
  ensureReady(): Promise<CpaStatus>;
  getStatus(): CpaStatus;
  buildProcessEnv(model?: string): Record<string, string>;
  getProxyTarget(): { origin: string; token: string } | null;
  /** Host-signed SDK transport header for this runtime's local endpoint only. */
  cacheSessionHeader?(sessionId: string, env: Record<string, string>): string | undefined;
  listModelCatalog(): Promise<ModelInfo[]>;
  getModelCatalog(): ModelInfo[];
  getModelQuota(model: string): Promise<ModelQuotaInfo | null>;
  mergeSdkModelCapabilities(models: Array<{ value?: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>): void;
  stopIfManaged(): void;
}
