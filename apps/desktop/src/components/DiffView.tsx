import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FileChange } from "@claude-desktop/shared";
import {
  DIFF_PREVIEW_ROWS,
  extractLineRangeSummary,
  mergeFullTextWithHunks,
  parseHunkForDisplay,
  type DiffDisplayRow,
} from "@claude-desktop/shared";
import { useI18n } from "../i18n/useI18n";

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

type ViewMode = "diff" | "full";

export function DiffView({
  change,
  loadFullText,
}: {
  change: FileChange;
  /** Read the current full file text; null/throw → full mode unavailable. */
  loadFullText?: () => Promise<string | null>;
}) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(PAGE);
  const [mode, setMode] = useState<ViewMode>("diff");
  const [fullText, setFullText] = useState<string | null>(null);
  const [fullFailed, setFullFailed] = useState(false);

  // Reset page + full-text cache when switching files / hunks
  const hunkKey = `${change.path}:${change.updatedAt}:${change.hunks.length}`;
  const [prevKey, setPrevKey] = useState(hunkKey);
  if (prevKey !== hunkKey) {
    setPrevKey(hunkKey);
    setLimit(PAGE);
    setFullText(null);
    setFullFailed(false);
  }

  // Lazily load full text when entering full mode.
  const loadingRef = useRef(false);
  useEffect(() => {
    if (mode !== "full" || fullText !== null || fullFailed || !loadFullText) {
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;
    let cancelled = false;
    void loadFullText()
      .then((text) => {
        if (cancelled) return;
        if (text == null) setFullFailed(true);
        else setFullText(text);
      })
      .catch(() => {
        if (!cancelled) setFullFailed(true);
      })
      .finally(() => {
        loadingRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [mode, fullText, fullFailed, loadFullText, hunkKey]);

  const diffRows = useMemo(
    () => parseHunkForDisplay(change.hunks, limit),
    [change.hunks, limit],
  );
  const fullRows = useMemo(
    () =>
      mode === "full" && fullText !== null
        ? mergeFullTextWithHunks(fullText, change.hunks)
        : null,
    [mode, fullText, change.hunks],
  );
  const rows = fullRows ?? diffRows;

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

  const fullAvailable = Boolean(loadFullText) && !fullFailed;
  const isDeleted = change.status === "D";

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
        {loadFullText ? (
          <span className="diff-mode-switch" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "diff"}
              className={
                mode === "diff" ? "diff-mode-btn active" : "diff-mode-btn"
              }
              onClick={() => setMode("diff")}
            >
              {t.changes.diffOnly}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "full"}
              className={
                mode === "full" ? "diff-mode-btn active" : "diff-mode-btn"
              }
              disabled={!fullAvailable}
              title={
                fullAvailable ? undefined : t.changes.fullTextFailed
              }
              onClick={() => setMode("full")}
            >
              {t.changes.fullText}
            </button>
          </span>
        ) : null}
      </div>
      {isDeleted ? (
        <p className="diff-deleted-hint">{t.changes.deletedHint}</p>
      ) : null}
      {mode === "full" && fullFailed ? (
        <p className="diff-deleted-hint">{t.changes.fullTextFailed}</p>
      ) : null}
      {mode === "full" && fullText === null && !fullFailed ? (
        <p className="diff-deleted-hint">…</p>
      ) : null}
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
      {mode === "diff" && (capped || rawLineCount > limit) ? (
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
