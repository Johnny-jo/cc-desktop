import React, { useState } from "react";
import type { UserPromptDecision } from "@claude-desktop/shared";
import { clearUserPromptRequest, useAppStore } from "../state/store";

/**
 * Modal for agent "ask user for more info" flows:
 * - MCP elicitation (form / url)
 * - SDK user dialog (request_user_dialog)
 */
export function UserPromptModal() {
  const request = useAppStore((s) => s.userPromptRequest);
  const [answer, setAnswer] = useState("");

  if (!request) return null;

  const respond = (decision: UserPromptDecision) => {
    const desktop = window.desktop;
    if (!desktop?.respondUserPrompt) return;
    void desktop.respondUserPrompt(request.requestId, decision);
    setAnswer("");
    clearUserPromptRequest();
  };

  const onAccept = () => {
    if (request.url) {
      // URL mode: accept means user completed external auth
      respond({ behavior: "accept", content: { ok: true } });
      return;
    }
    // Free-text / form: send answer as content.text
    respond({
      behavior: "accept",
      content: answer.trim()
        ? { text: answer.trim(), answer: answer.trim() }
        : { ok: true },
      result: answer.trim() || { ok: true },
    });
  };

  return (
    <div className="modal-overlay">
      <div className="modal permission-modal">
        <div className="modal-header">
          <span className="modal-title">
            {request.kind === "elicitation"
              ? "Agent needs input"
              : "Confirm"}
          </span>
          <span className="tool-name">{request.title}</span>
        </div>

        <div className="modal-body">
          <p className="permission-summary">{request.message}</p>
          {request.url ? (
            <p className="muted">
              Open URL:{" "}
              <a href={request.url} target="_blank" rel="noreferrer">
                {request.url}
              </a>
            </p>
          ) : (
            <textarea
              className="composer-input user-prompt-input"
              rows={3}
              placeholder="Type your response…"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              autoFocus
            />
          )}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onAccept}
          >
            {request.url ? "I've completed this" : "Submit"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              respond({ behavior: "decline", message: "User declined" })
            }
          >
            Decline
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() =>
              respond({ behavior: "cancel", message: "User cancelled" })
            }
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
