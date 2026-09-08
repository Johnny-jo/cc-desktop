import React from "react";
import type { AgentExpression } from "../hooks/useAgentMascot";

const expressions: AgentExpression[] = ["normal", "dizzy", "stars", "blush"];

/** Draw expressions explicitly so they also work without special Unicode fonts. */
export function AgentEyes({ expression }: { expression: AgentExpression }) {
  const eye = (mood: AgentExpression, x: number) => {
    if (mood === "dizzy") return <g transform={`translate(${x} 16)`}>
      <path className="agent-eye-spiral" d="M7 0C7 4.4 2 7-2 5.5C-7 3.8-7-3.5-3-5.3C1-7.4 6-3.8 4 0C2.6 3-1 3-2 0C-2-1.5 0-2 1-1.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </g>;
    if (mood === "stars") return <path className="agent-eye-star" transform={`translate(${x} 16)`} d="M0-10C1.1-3.4 2.2-1.1 5.5 0C2.2 1.1 1.1 3.4 0 10C-1.1 3.4-2.2 1.1-5.5 0C-2.2-1.1-1.1-3.4 0-10Z" fill="currentColor" />;
    return <rect className="agent-eye-open" x={x - 3.5} y="9" width="7" height="14" rx="3.5" fill="currentColor" />;
  };
  return <svg viewBox="0 0 56 32" aria-hidden="true" focusable="false">
    {expressions.map((mood) => <g key={mood} className={`agent-expression${expression === mood ? " is-active" : ""}`} data-mood={mood}>
      {mood === "blush"
        ? <path d="M11 16 8 24M15 16 12 24M19 16 16 24M41 16 38 24M45 16 42 24M49 16 46 24" stroke="#f498ad" strokeWidth="2" strokeLinecap="round" />
        : <>{eye(mood, 18)}{eye(mood, 38)}</>}
    </g>)}
  </svg>;
}
