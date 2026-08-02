import React from "react";
import type { PermissionDecision } from "@claude-desktop/shared";
import { clearPermissionRequest, useAppStore } from "../state/store";

function previewJson(value: unknown, maxLen = 600): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "\n…";
  } catch {
    return String(value);
  }
}

export function PermissionModal() {
  const request = useAppStore((s) => s.permissionRequest);

  if (!request) return null;

  const respond = (decision: PermissionDecision) => {
    const desktop = window.desktop;
    if (!desktop) return;
    void desktop.respondPermission(request.requestId, decision);
    clearPermissionRequest();
  };

  return (
    <div className="modal-overlay">
      <div className="modal permission-modal">
        <div className="modal-header">
          <span className="modal-title">Permission Request</span>
          <span className="tool-name">{request.toolName}</span>
        </div>

        <div className="modal-body">
          <p className="permission-summary">{request.summary}</p>
          <details className="permission-details">
            <summary>Input preview</summary>
            <pre className="permission-json">
              {previewJson(request.inputPreview)}
            </pre>
          </details>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={() =>
              respond({ behavior: "allow", scope: "once" })
            }
          >
            Allow once
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              respond({ behavior: "allow", scope: "session" })
            }
          >
            Allow for session
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() =>
              respond({ behavior: "deny", message: "User denied" })
            }
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
