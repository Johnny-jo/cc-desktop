import React, { useCallback, useState } from "react";
import {
  abortActiveSession,
  sendMessage,
  useAppStore,
} from "../state/store";

export function Composer() {
  const [text, setText] = useState("");
  const running = useAppStore((s) => s.running);
  const projectPath = useAppStore((s) => s.projectPath);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const settings = useAppStore((s) => s.settings);

  const canSend = Boolean(text.trim()) && Boolean(projectPath || activeSessionId);

  const onSend = useCallback(() => {
    if (!text.trim()) return;
    const prompt = text;
    setText("");
    sendMessage(prompt);
  }, [text]);

  const modelLabel = settings?.defaultModel ?? "model";

  return (
    <div className="composer-shell">
      <div className="composer">
        <textarea
          className="composer-input"
          rows={2}
          placeholder={
            projectPath
              ? activeSessionId
                ? "Reply…"
                : "Message Claude…"
              : "Open a project first, then type a message…"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={!projectPath && !activeSessionId}
        />
        <div className="composer-bar">
          <span className="composer-model" title={modelLabel}>
            ✦ {modelLabel}
          </span>
          <div className="composer-actions">
            {running ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => abortActiveSession()}
              >
                Stop
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-send"
              disabled={!canSend}
              onClick={onSend}
            >
              {running ? "Send anyway" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
