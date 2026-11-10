import { useEffect, useState } from "react";
import { IPC, type ProviderConfig } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import { displayModelId } from "../lib/model-display";

/** Resolve display-only provider prefixes from the actual configured accounts. */
export function useModelDisplay(): (modelId: string) => string {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  useEffect(() => {
    const desktop = getDesktop();
    if (typeof desktop.listProviders !== "function") return;
    let active = true;
    const refresh = async () => {
      try {
        const configs = await desktop.listProviders();
        if (active) setProviders(Array.isArray(configs) ? configs : []);
      } catch { /* Retain known prefixes if a later account refresh fails. */ }
    };
    void refresh();
    const unsubscribe = desktop.on(IPC.providerUpdated, () => void refresh());
    return () => { active = false; unsubscribe(); };
  }, []);
  return modelId => displayModelId(modelId, providers);
}
