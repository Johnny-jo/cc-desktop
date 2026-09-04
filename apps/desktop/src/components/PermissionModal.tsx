import React, { useState } from "react";
import type { PermissionDecision, PermissionRequest } from "@claude-desktop/shared";
import { clearPermissionRequest, useAppStore } from "../state/store";
import { useI18n } from "../i18n/useI18n";

function previewJson(value: unknown, maxLen = 600): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "\n…";
  } catch {
    return String(value);
  }
}

type AskQuestion = {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
};

/** AskUserQuestion 工具入参 → 结构化问题列表（解析失败返回 null 走通用弹窗）。 */
function parseAskQuestions(input: unknown): AskQuestion[] | null {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const q of qs) {
    const rec = q as Record<string, unknown>;
    if (typeof rec.question !== "string") return null;
    out.push({
      question: rec.question,
      header: typeof rec.header === "string" ? rec.header : undefined,
      multiSelect: rec.multiSelect === true,
      options: Array.isArray(rec.options)
        ? rec.options
            .map((o): { label: string; description?: string } | null => {
              const r = o as Record<string, unknown>;
              if (typeof r.label !== "string") return null;
              const opt: { label: string; description?: string } = {
                label: r.label,
              };
              if (typeof r.description === "string") {
                opt.description = r.description;
              }
              return opt;
            })
            .filter((o) => o !== null)
        : [],
    });
  }
  return out;
}

/**
 * AskUserQuestion 专用表单：选项按钮 + 每题可填“其他”，提交时把答案合并进
 * updatedInput 放行，模型收到的就是用户的选择。
 */
function AskQuestionForm({
  request,
  respond,
}: {
  request: PermissionRequest;
  respond: (d: PermissionDecision) => void;
}) {
  const { t } = useI18n();
  const questions = parseAskQuestions(request.inputPreview) ?? [];
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [others, setOthers] = useState<Record<number, string>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const cur = prev[qi] ?? [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      return { ...prev, [qi]: next };
    });
  };

  const answerFor = (qi: number): string => {
    const other = (others[qi] ?? "").trim();
    if (other) return other;
    return (selections[qi] ?? []).join(", ");
  };

  const allAnswered = questions.every((_, qi) => answerFor(qi).length > 0);

  const submit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      answers[q.question] = answerFor(qi);
    });
    const base =
      request.inputPreview && typeof request.inputPreview === "object"
        ? (request.inputPreview as Record<string, unknown>)
        : {};
    respond({
      behavior: "allow",
      scope: "once",
      updatedInput: { ...base, answers },
    });
  };

  return (
    <div className="agent-prompt-card ask-prompt-card">
      <div className="agent-prompt-kicker">
        <span className="agent-prompt-icon" aria-hidden>
          <svg viewBox="0 0 16 16">
            <path d="M5.2 5.7a2.9 2.9 0 1 1 4.6 2.4C8.6 8.9 8 9.3 8 10.5" />
            <path d="M8 13h.01" />
          </svg>
        </span>
        <span>{t.prompts.agentQuestion}</span>
      </div>

      <div className="agent-prompt-content">
        {questions.map((q, qi) => (
          <div key={qi} className="ask-question">
            {q.header ? (
              <span className="agent-prompt-question-label">{q.header}</span>
            ) : null}
            <p className="agent-prompt-title ask-question-title">
              {q.question}
            </p>
            <div className="ask-options">
              {q.options.map((o) => {
                const selected = (selections[qi] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    className={`btn btn-sm ask-option${selected ? " btn-primary" : ""}`}
                    title={o.description}
                    onClick={() => toggle(qi, o.label, q.multiSelect)}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <input
              className="ask-other"
              placeholder={t.prompts.otherAnswer}
              value={others[qi] ?? ""}
              onChange={(e) =>
                setOthers((prev) => ({ ...prev, [qi]: e.target.value }))
              }
            />
          </div>
        ))}
      </div>

      <div className="agent-prompt-actions">
        <button
          type="button"
          className="btn agent-prompt-secondary"
          onClick={() =>
            respond({ behavior: "deny", message: t.prompts.userDeclined })
          }
        >
          {t.prompts.decline}
        </button>
        <button
          type="button"
          className="btn agent-prompt-primary"
          disabled={!allAnswered}
          onClick={submit}
        >
          {t.prompts.submitAnswer}
        </button>
      </div>
    </div>
  );
}

export function PermissionModal() {
  const { t } = useI18n();
  const request = useAppStore((s) => s.permissionRequest);

  if (!request) return null;

  const respond = (decision: PermissionDecision) => {
    const desktop = window.desktop;
    if (!desktop) return;
    void desktop.respondPermission(request.requestId, decision);
    clearPermissionRequest();
  };

  if (request.toolName === "AskUserQuestion") {
    const questions = parseAskQuestions(request.inputPreview);
    if (questions) {
      return (
        <AskQuestionForm request={request} respond={respond} />
      );
    }
  }

  return (
    <div className="agent-prompt-card permission-modal">
        <div className="agent-prompt-kicker">
          <span className="agent-prompt-icon" aria-hidden>
            <svg viewBox="0 0 16 16">
              <rect x="2" y="2.5" width="12" height="11" rx="2" />
              <path d="m4.5 6 2 2-2 2M8.2 10h3.2" />
            </svg>
          </span>
          <span>{request.toolName}</span>
        </div>

        <div className="agent-prompt-content">
          <p className="agent-prompt-title">{request.summary}</p>
          <pre className="agent-prompt-preview">
            {previewJson(request.inputPreview)}
          </pre>
        </div>

        <div className="agent-prompt-actions">
          <button
            type="button"
            className="btn agent-prompt-secondary"
            onClick={() => respond({ behavior: "deny", message: "User denied" })}
          >
            {t.prompts.decline}
          </button>
          <div className="permission-allow-group">
            <button
              type="button"
              className="btn agent-prompt-primary permission-allow-once"
              onClick={() => respond({ behavior: "allow", scope: "once" })}
            >
              {t.prompts.allowOnce}
            </button>
            <details className="permission-scope-menu">
              <summary aria-label={t.prompts.moreAllowOptions}>
                <svg viewBox="0 0 16 16" aria-hidden>
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </summary>
              <div className="permission-scope-popover">
                <button
                  type="button"
                  onClick={() => respond({ behavior: "allow", scope: "session" })}
                >
                  {t.prompts.allowSession}
                </button>
                <button
                  type="button"
                  onClick={() => respond({ behavior: "allow", scope: "always" })}
                >
                  {t.prompts.allowAlways}
                </button>
              </div>
            </details>
          </div>
        </div>
    </div>
  );
}
