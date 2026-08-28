import React, { useState } from "react";
import type { PermissionDecision, PermissionRequest } from "@claude-desktop/shared";
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
    <div className="modal permission-modal">
      <div className="modal-header">
        <span className="modal-title">Agent 向你提问</span>
      </div>

      <div className="modal-body">
        {questions.map((q, qi) => (
          <div key={qi} className="ask-question">
            <p className="permission-summary">
              {q.header ? <span className="tool-name">{q.header} </span> : null}
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
              className="composer-input ask-other"
              placeholder="其他（直接填写，优先于上面的选择）"
              value={others[qi] ?? ""}
              onChange={(e) =>
                setOthers((prev) => ({ ...prev, [qi]: e.target.value }))
              }
            />
          </div>
        ))}
      </div>

      <div className="modal-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!allAnswered}
          onClick={submit}
        >
          提交回答
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() =>
            respond({ behavior: "deny", message: "用户拒绝回答" })
          }
        >
          拒绝
        </button>
      </div>
    </div>
  );
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

  if (request.toolName === "AskUserQuestion") {
    const questions = parseAskQuestions(request.inputPreview);
    if (questions) {
      return (
        <div className="modal-overlay">
          <AskQuestionForm request={request} respond={respond} />
        </div>
      );
    }
  }

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
            className="btn"
            title="Persist an allow rule (Settings → Permissions)"
            onClick={() =>
              respond({ behavior: "allow", scope: "always" })
            }
          >
            Always allow
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
