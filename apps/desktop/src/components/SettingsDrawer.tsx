import React, { useEffect, useState } from "react";
import type { AppSettings, ModelInfo, PublicSettings } from "@claude-desktop/shared";
import {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  buildModelContextLimitsPatch,
} from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import {
  getState,
  saveSettings,
  syncCpaModels,
  useAppStore,
} from "../state/store";

export type SettingsDrawerProps = {
  open: boolean;
  onClose: () => void;
};

type FormState = {
  cpaExePath: string;
  cpaConfigPath: string;
  cpaPort: string;
  token: string;
  modelsCsv: string;
  defaultModel: string;
  shutdownCpaOnQuit: boolean;
  defaultContextLimit: string;
  /** modelId → override 字符串；缺省或 "" = auto */
  modelContextLimitDraft: Record<string, string>;
};

function fromSettings(s: PublicSettings | null): FormState {
  const draft: Record<string, string> = {};
  for (const [k, v] of Object.entries(s?.modelContextLimits ?? {})) {
    draft[k] = String(v);
  }
  return {
    cpaExePath: s?.cpaExePath ?? "",
    cpaConfigPath: s?.cpaConfigPath ?? "",
    cpaPort: String(s?.cpaPort ?? 8317),
    token: "",
    modelsCsv: (s?.models ?? []).join(", "),
    defaultModel: s?.defaultModel ?? "",
    shutdownCpaOnQuit: s?.shutdownCpaOnQuit ?? false,
    defaultContextLimit: String(s?.defaultContextLimit ?? 200_000),
    modelContextLimitDraft: draft,
  };
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const settings = useAppStore((s) => s.settings);
  const [form, setForm] = useState<FormState>(() => fromSettings(settings));
  const [catalog, setCatalog] = useState<ModelInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  async function refreshCatalog() {
    try {
      const desktop = getDesktop();
      const list = await desktop.getModelCatalog();
      setCatalog(Array.isArray(list) ? list : []);
    } catch {
      setCatalog([]);
    }
  }

  function visibleModelIds(modelsCsv: string, cat: ModelInfo[]): string[] {
    const fromCsv = modelsCsv
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const set = new Set<string>([...fromCsv, ...cat.map((m) => m.id)]);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  useEffect(() => {
    if (!open) return;
    setForm(fromSettings(settings));
    setLocalError(null);
    setSavedNote(null);
    void refreshCatalog();
  }, [open, settings]);

  if (!open) return null;

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onSave = async () => {
    setLocalError(null);
    setSavedNote(null);
    const port = Number(form.cpaPort);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      setLocalError("Port must be a number between 1 and 65535");
      return;
    }
    const models = form.modelsCsv
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length === 0) {
      setLocalError("Models list cannot be empty");
      return;
    }
    const defaultModel = form.defaultModel.trim() || models[0];
    if (!models.includes(defaultModel)) {
      models.unshift(defaultModel);
    }
    const defaultContextLimit = Number(form.defaultContextLimit);
    if (
      !Number.isFinite(defaultContextLimit) ||
      defaultContextLimit < CONTEXT_LIMIT_MIN ||
      defaultContextLimit > CONTEXT_LIMIT_MAX
    ) {
      setLocalError(
        `Default context limit must be between ${CONTEXT_LIMIT_MIN} and ${CONTEXT_LIMIT_MAX}`,
      );
      return;
    }

    const visibleIds = visibleModelIds(form.modelsCsv, catalog);
    const patchLimits = buildModelContextLimitsPatch({
      existing: settings?.modelContextLimits ?? {},
      visibleIds,
      draft: form.modelContextLimitDraft,
    });
    if (!patchLimits.ok) {
      setLocalError(patchLimits.error);
      return;
    }

    const patch: Partial<AppSettings> & { token?: string } = {
      cpaExePath: form.cpaExePath.trim(),
      cpaConfigPath: form.cpaConfigPath.trim(),
      cpaPort: port,
      models,
      defaultModel,
      shutdownCpaOnQuit: form.shutdownCpaOnQuit,
      defaultContextLimit: Math.floor(defaultContextLimit),
      modelContextLimits: patchLimits.modelContextLimits,
    };
    if (form.token.trim()) {
      patch.token = form.token.trim();
    }

    setSaving(true);
    try {
      await saveSettings(patch);
      setForm((prev) => ({ ...prev, token: "" }));
      setSavedNote("Saved");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <aside
        className="settings-drawer"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-header">
          <h2>Settings</h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="settings-body">
          <label className="settings-field">
            CPA executable
            <input
              value={form.cpaExePath}
              onChange={(e) => setField("cpaExePath", e.target.value)}
              spellCheck={false}
            />
          </label>

          <label className="settings-field">
            CPA config.yaml
            <input
              value={form.cpaConfigPath}
              onChange={(e) => setField("cpaConfigPath", e.target.value)}
              spellCheck={false}
            />
          </label>

          <label className="settings-field">
            CPA port
            <input
              type="number"
              min={1}
              max={65535}
              value={form.cpaPort}
              onChange={(e) => setField("cpaPort", e.target.value)}
            />
          </label>

          <label className="settings-field">
            Auth token
            <input
              type="password"
              autoComplete="off"
              placeholder={
                settings?.hasToken
                  ? "•••••••• (leave blank to keep)"
                  : "CPA / Anthropic token"
              }
              value={form.token}
              onChange={(e) => setField("token", e.target.value)}
            />
          </label>

          <label className="settings-field">
            Models (comma-separated)
            <input
              value={form.modelsCsv}
              onChange={(e) => setField("modelsCsv", e.target.value)}
              spellCheck={false}
            />
          </label>

          <div className="settings-inline-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={syncing}
              onClick={() => {
                void (async () => {
                  setLocalError(null);
                  setSavedNote(null);
                  setSyncing(true);
                  try {
                    await syncCpaModels();
                    const latest = getState().settings;
                    setForm(fromSettings(latest));
                    setSavedNote(
                      `Synced ${latest?.models?.length ?? 0} models from CPA`,
                    );
                    void refreshCatalog();
                  } catch (err) {
                    setLocalError(
                      err instanceof Error ? err.message : String(err),
                    );
                  } finally {
                    setSyncing(false);
                  }
                })();
              }}
            >
              {syncing ? "Syncing…" : "Sync models from CPA"}
            </button>
            <span className="settings-hint">
              Pulls /v1/models (e.g. deepseek-v4-flash)
            </span>
          </div>

          <label className="settings-field">
            Default model
            <input
              value={form.defaultModel}
              onChange={(e) => setField("defaultModel", e.target.value)}
              spellCheck={false}
            />
          </label>

          <label className="settings-field">
            Default context limit (tokens)
            <input
              type="number"
              min={1024}
              step={1024}
              value={form.defaultContextLimit}
              onChange={(e) => setField("defaultContextLimit", e.target.value)}
            />
          </label>
          <p className="settings-hint">
            Used when CPA/builtin has no window for the model. Default 200000.
          </p>

          <label className="settings-check">
            <input
              type="checkbox"
              checked={form.shutdownCpaOnQuit}
              onChange={(e) => setField("shutdownCpaOnQuit", e.target.checked)}
            />
            Shut down CPA on quit (only if this app spawned it)
          </label>

          {localError ? <p className="settings-error">{localError}</p> : null}
          {savedNote ? <p className="settings-ok">{savedNote}</p> : null}
        </div>

        <footer className="settings-footer">
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void onSave()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
