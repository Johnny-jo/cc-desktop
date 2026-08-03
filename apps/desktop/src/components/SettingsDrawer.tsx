import React, { useEffect, useState } from "react";
import type { AppSettings, PublicSettings } from "@claude-desktop/shared";
import { saveSettings, useAppStore } from "../state/store";

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
};

function fromSettings(s: PublicSettings | null): FormState {
  return {
    cpaExePath: s?.cpaExePath ?? "",
    cpaConfigPath: s?.cpaConfigPath ?? "",
    cpaPort: String(s?.cpaPort ?? 8317),
    token: "",
    modelsCsv: (s?.models ?? []).join(", "),
    defaultModel: s?.defaultModel ?? "",
    shutdownCpaOnQuit: s?.shutdownCpaOnQuit ?? false,
  };
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const settings = useAppStore((s) => s.settings);
  const [form, setForm] = useState<FormState>(() => fromSettings(settings));
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(fromSettings(settings));
      setLocalError(null);
      setSavedNote(null);
    }
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

    const patch: Partial<AppSettings> & { token?: string } = {
      cpaExePath: form.cpaExePath.trim(),
      cpaConfigPath: form.cpaConfigPath.trim(),
      cpaPort: port,
      models,
      defaultModel,
      shutdownCpaOnQuit: form.shutdownCpaOnQuit,
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

          <label className="settings-field">
            Default model
            <input
              value={form.defaultModel}
              onChange={(e) => setField("defaultModel", e.target.value)}
              spellCheck={false}
            />
          </label>

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
