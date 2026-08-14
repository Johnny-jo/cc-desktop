import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { CHANGELOG } from "../changelog";

export function ChangelogModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="changelog-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="changelog-modal"
        role="dialog"
        aria-label="更新日志"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="changelog-head">
          <h3>更新日志</h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="changelog-body">
          {CHANGELOG.map((entry) => (
            <section key={entry.version} className="changelog-entry">
              <header className="changelog-entry-head">
                <span className="changelog-ver">v{entry.version}</span>
                <span className="changelog-date">{entry.date}</span>
              </header>
              <p className="changelog-title">{entry.title}</p>
              <ul>
                {entry.items.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
