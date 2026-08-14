import React, { useMemo, useState } from "react";
import type { FileChange } from "@claude-desktop/shared";
import {
  DIFF_PREVIEW_ROWS,
  extractLineRangeSummary,
  parseHunkForDisplay,
  type DiffDisplayRow,
} from "@claude-desktop/shared";

function rowClass(kind: DiffDisplayRow["kind"]): string {
  switch (kind) {
    case "add":
      return "diff-line diff-add";
    case "del":
      return "diff-line diff-del";
    case "hunk":
      return "diff-line diff-hunk";
    case "meta":
      return "diff-line diff-meta";
    default:
      return "diff-line diff-ctx";
  }
}

function fmtNo(n: number | null): string {
  return n == null ? "" : String(n);
}

const PAGE = DIFF_PREVIEW_ROWS;

export function DiffView({ change }: { change: FileChange }) {
  const [limit, setLimit] = useState(PAGE);

  // Reset page when switching files / hunks
  const hunkKey = `${change.path}:${change.updatedAt}:${change.hunks.length}`;
  const [prevKey, setPrevKey] = useState(hunkKey);
  if (prevKey !== hunkKey) {
    setPrevKey(hunkKey);
    setLimit(PAGE);
  }

  const rows = useMemo(
    () => parseHunkForDisplay(change.hunks, limit),
    [change.hunks, limit],
  );
  const rangeSummary = useMemo(
    () => extractLineRangeSummary(change.hunks),
    [change.hunks],
  );
  const capped = rows.some(
    (r) => r.kind === "meta" && r.text.includes("preview capped"),
  );
  // Rough total lines in raw hunk (cheap; may exceed limit)
  const rawLineCount = useMemo(() => {
    let n = 0;
    const s = change.hunks;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n += 1;
    return n + 1;
  }, [change.hunks]);

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className={`change-status status-${change.status}`}>
          {change.status}
        </span>
        <span className="diff-path" title={change.path}>
          {change.path}
        </span>
        {rangeSummary ? (
          <span className="diff-range" title="Changed line numbers">
            {rangeSummary}
          </span>
        ) : null}
        <span className="diff-meta">
          {change.events.length} change{change.events.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="diff-content" role="table" aria-label="diff">
        <div className="diff-gutter-head" aria-hidden>
          <span className="diff-gutter-col">旧</span>
          <span className="diff-gutter-col">新</span>
          <span className="diff-gutter-spacer" />
        </div>
        {rows.map((row, i) => (
          <div key={i} className={rowClass(row.kind)}>
            <span className="diff-gutter-col diff-no-old" title="旧文件行号">
              {fmtNo(row.oldNo)}
            </span>
            <span className="diff-gutter-col diff-no-new" title="新文件行号">
              {fmtNo(row.newNo)}
            </span>
            <span className="diff-line-text">{row.text || " "}</span>
          </div>
        ))}
      </div>
      {capped || rawLineCount > limit ? (
        <div className="diff-more">
          <span className="diff-more-hint">
            预览已截断（约 {Math.min(limit, rawLineCount)} / {rawLineCount} 行）
          </span>
          {limit < Math.min(rawLineCount, PAGE * 5) ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setLimit((n) => n + PAGE)}
            >
              再加载 {PAGE} 行
            </button>
          ) : (
            <span className="diff-more-hint">请在编辑器中打开查看全文</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
