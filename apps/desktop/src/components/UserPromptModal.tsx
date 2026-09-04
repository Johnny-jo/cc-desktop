import React, { useState } from "react";
import type { UserPromptDecision } from "@claude-desktop/shared";
import { clearUserPromptRequest, useAppStore } from "../state/store";
import { useI18n } from "../i18n/useI18n";

/**
 * Modal for agent "ask user for more info" flows:
 * - MCP elicitation (form / url)
 * - SDK user dialog (request_user_dialog)
 */
export function UserPromptModal() {
  const { t } = useI18n();
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
    <div className="agent-prompt-card permission-modal">
        <div className="agent-prompt-kicker">
          <span className="agent-prompt-icon" aria-hidden>
            <svg viewBox="0 0 16 16">
              <path d="M3 3.2h10v7.3H7l-3.4 2.3.8-2.3H3V3.2Z" />
            </svg>
          </span>
          <span>{request.title || t.prompts.agentQuestion}</span>
        </div>

        <div className="agent-prompt-content">
          <p className="agent-prompt-title">{request.message}</p>
          {request.url ? (
            <p className="agent-prompt-link">
              <a href={request.url} target="_blank" rel="noreferrer">
                {request.url}
              </a>
            </p>
          ) : (
            <textarea
              className="user-prompt-input"
              rows={3}
              placeholder={t.prompts.typeResponse}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              autoFocus
            />
          )}
        </div>

        <div className="agent-prompt-actions">
          <button
            type="button"
            className="btn agent-prompt-secondary"
            onClick={() =>
              respond({ behavior: "decline", message: "User declined" })
            }
          >
            {t.prompts.decline}
          </button>
          <button
            type="button"
            className="btn agent-prompt-primary"
            onClick={onAccept}
          >
            {request.url ? t.prompts.completed : t.prompts.submitAnswer}
          </button>
        </div>
    </div>
  );
}
