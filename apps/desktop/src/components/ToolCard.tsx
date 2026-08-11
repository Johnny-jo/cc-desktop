import React, { useState } from "react";
import type { ToolCardState, TodoItem } from "@claude-desktop/shared";

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

export function ToolCard({ tool }: { tool: ToolCardState }) {
  // Collapsed by default — user expands to inspect details.
  const [open, setOpen] = useState(false);
  const isTodo = tool.name === "TodoWrite" && Boolean(tool.todos?.length);
  const isTask = tool.name === "Task" || tool.name === "Agent";
  const hasBody = Boolean(
    tool.summary || tool.resultPreview || isTodo || (isTask && tool.summary),
  );
  const elapsed =
    tool.status === "running" && tool.elapsedSeconds != null
      ? formatElapsed(tool.elapsedSeconds)
      : "";

  return (
    <div className={`tool-card tool-${tool.status}${open ? " open" : ""}`}>
      <button
        type="button"
        className="tool-card-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Collapse tool details" : "Expand tool details"}
      >
        <span className="tool-chevron" aria-hidden>
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
}
