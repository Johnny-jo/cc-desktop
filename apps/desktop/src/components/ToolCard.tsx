import React from "react";
import type { ToolCardState } from "@claude-desktop/shared";

export function ToolCard({ tool }: { tool: ToolCardState }) {
  return (
    <div className={`tool-card tool-${tool.status}`}>
      <div className="tool-card-header">
        <span className="tool-name">{tool.name}</span>
        <span className={`tool-status status-${tool.status}`}>{tool.status}</span>
      </div>
      {tool.summary ? (
        <div className="tool-summary" title={tool.summary}>
          {tool.summary}
        </div>
      ) : null}
      {tool.resultPreview ? (
        <pre className="tool-preview">{tool.resultPreview}</pre>
      ) : null}
    </div>
  );
}
