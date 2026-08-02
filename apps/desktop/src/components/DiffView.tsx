import React from "react";
import type { FileChange } from "@claude-desktop/shared";

function lineClass(line: string): string {
  if (line.startsWith("+")) return "diff-line diff-add";
  if (line.startsWith("-")) return "diff-line diff-del";
  if (line.startsWith("#")) return "diff-line diff-meta";
  if (line.startsWith("@@")) return "diff-line diff-hunk";
  return "diff-line diff-ctx";
}

export function DiffView({ change }: { change: FileChange }) {
  const lines = change.hunks.split("\n");

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className={`change-status status-${change.status}`}>
          {change.status}
        </span>
        <span className="diff-path" title={change.path}>
          {change.path}
        </span>
        <span className="diff-meta">
          {change.events.length} change{change.events.length !== 1 ? "s" : ""}
        </span>
      </div>
      <pre className="diff-content">
        {lines.map((line, i) => (
          <div key={i} className={lineClass(line)}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
