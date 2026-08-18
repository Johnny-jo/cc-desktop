import React, { memo, useState } from "react";
import type { ToolCardState, TodoItem } from "@claude-desktop/shared";
import { requestRevealChange, useAppStore } from "../state/store";

function formatElapsed(sec?: number): string {
  if (sec == null || !Number.isFinite(sec)) return "";
  if (sec < 10) return `${sec.toFixed(1)}s`;
  return `${Math.round(sec)}s`;
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="todo-list">
      {todos.map((t, i) => (
        <li key={i} className={`todo-item todo-${t.status}`}>
          <span className="todo-box" aria-hidden>
            {t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"}
          </span>
          <span className="todo-text">{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

export const ToolCard = memo(function ToolCard({
  tool,
}: {
  tool: ToolCardState;
}) {
  // Collapsed by default — user expands to inspect details.
  const [open, setOpen] = useState(false);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const isTodo =
    (tool.name === "TodoWrite" ||
      tool.name === "TaskCreate" ||
      tool.name === "TaskList") &&
    Boolean(tool.todos?.length);
  const isTask = tool.name === "Task" || tool.name === "Agent";
  // Write/Edit cards jump to the changes panel instead of expanding inline.
  const isFileEdit = tool.name === "Write" || tool.name === "Edit";
  const hasBody = Boolean(
    tool.summary || tool.resultPreview || isTodo || (isTask && tool.summary),
  );
  const elapsed =
    tool.status === "running" && tool.elapsedSeconds != null
      ? formatElapsed(tool.elapsedSeconds)
      : "";

  const jumpToChange = () => {
    if (!activeSessionId) return;
    requestRevealChange({
      sessionId: activeSessionId,
      toolUseId: tool.id,
      path: tool.summary || undefined,
    });
  };

  return (
    <div
      className={`tool-card tool-${tool.status}${open ? " open" : ""}${
        isFileEdit ? " tool-card-linked" : ""
      }`}
    >
      <button
        type="button"
        className="tool-card-toggle"
        onClick={isFileEdit ? jumpToChange : () => setOpen((v) => !v)}
        aria-expanded={isFileEdit ? undefined : open}
        title={
          isFileEdit
            ? "View this change in the Changes panel"
            : open
              ? "Collapse tool details"
              : "Expand tool details"
        }
      >
        <span
          className="tool-chevron"
          aria-hidden
          role={isFileEdit ? "button" : undefined}
          onClick={
            isFileEdit
              ? (e) => {
                  e.stopPropagation();
                  setOpen((v) => !v);
                }
              : undefined
          }
        >
          {open ? "▾" : "▸"}
        </span>
        {tool.isSubagent ? (
          <span className="tool-chip tool-chip-subagent" title="Ran inside a subagent">
            sub
          </span>
        ) : null}
        {isTask ? (
          <span className="tool-chip tool-chip-task" title="Subagent task">
            agent
          </span>
        ) : null}
        <span className="tool-name">{tool.name}</span>
        {!open && tool.summary ? (
          <span className="tool-summary-inline" title={tool.summary}>
            {tool.summary}
          </span>
        ) : null}
        <span className={`tool-status status-${tool.status}`}>
          {tool.status}
          {elapsed ? ` · ${elapsed}` : ""}
        </span>
      </button>

      {open && hasBody ? (
        <div className="tool-card-body">
          {isTodo && tool.todos ? (
            <TodoList todos={tool.todos} />
          ) : (
            tool.summary && (
              <div className="tool-summary" title={tool.summary}>
                {tool.summary}
              </div>
            )
          )}
          {tool.resultPreview ? (
            <pre className="tool-preview">{tool.resultPreview}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
