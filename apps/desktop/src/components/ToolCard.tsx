import React, { useState } from "react";
import type { ToolCardState } from "@claude-desktop/shared";

export function ToolCard({ tool }: { tool: ToolCardState }) {
  // Collapsed by default — user expands to inspect details.
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(tool.summary || tool.resultPreview);

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
        <span className="tool-name">{tool.name}</span>
        {!open && tool.summary ? (
          <span className="tool-summary-inline" title={tool.summary}>
            {tool.summary}
          </span>
        ) : null}
        <span className={`tool-status status-${tool.status}`}>{tool.status}</span>
      </button>

      {open && hasBody ? (
        <div className="tool-card-body">
          {tool.summary ? (
            <div className="tool-summary" title={tool.summary}>
              {tool.summary}
            </div>
          ) : null}
          {tool.resultPreview ? (
            <pre className="tool-preview">{tool.resultPreview}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
