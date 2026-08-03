import React from "react";
import { clearLastError, useAppStore } from "../state/store";

export function ErrorBanner() {
  const lastError = useAppStore((s) => s.lastError);
  if (!lastError) return null;

  return (
    <div className="error-banner" role="alert">
      <span className="error-banner-text" title={lastError}>
        {lastError}
      </span>
      <button
        type="button"
        className="btn error-banner-dismiss"
        onClick={() => clearLastError()}
        aria-label="Dismiss error"
      >
        Dismiss
      </button>
    </div>
  );
}
