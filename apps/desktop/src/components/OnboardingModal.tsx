import React, { useMemo, useState } from "react";
import { completeOnboarding, useAppStore } from "../state/store";

function randomGatewayToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * First-run modal when no CPA gateway token is stored.
 * Generates a local api-key, writes it into userData CPA config + encrypted settings,
 * then starts the bundled CPA.
 */
export function OnboardingModal({ open }: { open: boolean }) {
  const cpaStatus = useAppStore((s) => s.cpaStatus);
  const [token, setToken] = useState(() => randomGatewayToken());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneNote, setDoneNote] = useState<string | null>(null);

  const cpaHint = useMemo(() => {
    if (cpaStatus.state === "ready") {
      return `CPA ready on port ${cpaStatus.port}`;
    }
    if (cpaStatus.state === "error") {
      return `CPA: ${cpaStatus.message}`;
    }
    if (cpaStatus.state === "starting") return "CPA starting…";
    return "CPA will start after you continue";
  }, [cpaStatus]);

  if (!open) return null;

  const onSubmit = async () => {
    setError(null);
    setDoneNote(null);
    const t = token.trim();
    if (!t) {
      setError("Enter or generate a gateway token");
      return;
    }
    setBusy(true);
    try {
      const res = await completeOnboarding(t, true);
      if (!res.ok) {
        setError(res.error ?? "Setup failed");
        return;
      }
      if (res.cpaStatus.state === "ready") {
        setDoneNote(
          `Ready — CPA on port ${res.cpaStatus.port}. Open a project and send a message.`,
        );
      } else if (res.cpaStatus.state === "error") {
        setDoneNote(
          `Token saved. CPA not ready yet: ${res.cpaStatus.message}. Check Settings → CPA paths or start CPA from the sidebar.`,
        );
      } else {
        setDoneNote("Token saved. You can open a project and start chatting.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay onboarding-overlay">
      <div className="modal onboarding-modal" role="dialog" aria-labelledby="onboarding-title">
        <div className="modal-header">
          <span className="modal-title" id="onboarding-title">
            Welcome to Claude Desktop
          </span>
        </div>
        <div className="modal-body">
          <p className="onboarding-lead">
            This app ships with <strong>Claude Code</strong> and a local{" "}
            <strong>CPA</strong> gateway. You only need a gateway token (stored
            encrypted on this machine). Upstream model logins reuse{" "}
            <code>~/.cli-proxy-api</code> when present.
          </p>

          <label className="settings-field">
            Gateway token (CPA api-keys)
            <div className="onboarding-token-row">
              <input
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => setToken(randomGatewayToken())}
              >
                Regenerate
              </button>
            </div>
          </label>
          <p className="settings-hint">{cpaHint}</p>
          <p className="settings-hint">
            After setup you can change models, CPA paths, and permissions in
            Settings (sidebar).
          </p>
          {error ? <p className="settings-error">{error}</p> : null}
          {doneNote ? <p className="settings-ok">{doneNote}</p> : null}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void onSubmit()}
          >
            {busy ? "Setting up…" : "Save & start CPA"}
          </button>
        </div>
      </div>
    </div>
  );
}
