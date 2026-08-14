import React, { useEffect, useMemo, useRef, useState } from "react";
import { getDesktop } from "../lib/desktop-api";
import { useAppStore } from "../state/store";

export type FileSearchModalProps = {
  open: boolean;
  onClose: () => void;
  onOpenFile: (rel: string) => void;
};

function scoreMatch(path: string, query: string): number {
  const p = path.replace(/\\/g, "/").toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const base = p.split("/").pop() ?? p;
  if (base === q) return 1000;
  if (base.startsWith(q)) return 800 - base.length;
  if (base.includes(q)) return 600 - base.indexOf(q);
  if (p.includes(q)) return 400 - p.indexOf(q);
  // subsequence fuzzy
  let bi = 0;
  let score = 200;
  for (let i = 0; i < base.length && bi < q.length; i++) {
    if (base[i] === q[bi]) {
      score += 2;
      bi += 1;
    }
  }
  return bi === q.length ? score : -1;
}

function highlight(path: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return path;
  const lower = path.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return path;
  return (
    <>
      {path.slice(0, idx)}
      <mark className="file-search-mark">{path.slice(idx, idx + q.length)}</mark>
      {path.slice(idx + q.length)}
    </>
  );
}

/**
 * Ctrl+Shift+F — project file search (by path / name).
 * VS Code–style floating palette over the workspace.
 */
export function FileSearchModal({
  open,
  onClose,
  onOpenFile,
}: FileSearchModalProps) {
  const projectPath = useAppStore((s) => s.projectPath);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset + focus when opened
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setError(null);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Load / filter files (debounced)
  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setLoading(true);
      void (async () => {
        try {
          const res = await getDesktop().listProjectFiles(
            projectPath,
            query.trim() || undefined,
            200,
          );
          if (cancelled) return;
          setFiles(res.files ?? []);
          setError(null);
          setActive(0);
        } catch (err) {
          if (!cancelled) {
            setFiles([]);
            setError(err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, projectPath, query]);

  const ranked = useMemo(() => {
    const q = query.trim();
    if (!q) return files.slice(0, 80);
    return [...files]
      .map((f) => ({ f, s: scoreMatch(f, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.f.localeCompare(b.f))
      .slice(0, 80)
      .map((x) => x.f);
  }, [files, query]);

  // Keep active row visible
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const row = root.querySelector(`[data-idx="${active}"]`) as HTMLElement | null;
    row?.scrollIntoView({ block: "nearest" });
  }, [active, ranked]);

  if (!open) return null;

  const pick = (rel: string) => {
    onOpenFile(rel);
    onClose();
  };

  return (
    <div
      className="file-search-overlay"
      role="dialog"
      aria-label="搜索文件"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="file-search-modal">
        <div className="file-search-head">
          <span className="file-search-icon" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            className="file-search-input"
            placeholder={
              projectPath
                ? "搜索项目文件（文件名 / 路径）"
                : "请先打开项目"
            }
            value={query}
            disabled={!projectPath}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(ranked.length - 1, i + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const hit = ranked[active];
                if (hit) pick(hit);
              }
            }}
          />
          <kbd className="file-search-kbd">Esc</kbd>
        </div>

        <div className="file-search-meta">
          {!projectPath
            ? "未打开项目"
            : loading
              ? "搜索中…"
              : error
                ? `错误：${error}`
                : `${ranked.length} 个结果`}
        </div>

        <div className="file-search-list" ref={listRef} role="listbox">
          {!projectPath ? (
            <div className="file-search-empty">先在左侧打开一个项目文件夹</div>
          ) : ranked.length === 0 && !loading ? (
            <div className="file-search-empty">无匹配文件</div>
          ) : (
            ranked.map((rel, idx) => {
              const name = rel.split(/[/\\]/).pop() ?? rel;
              const dir = rel.slice(0, Math.max(0, rel.length - name.length));
              return (
                <button
                  key={rel}
                  type="button"
                  role="option"
                  data-idx={idx}
                  aria-selected={idx === active}
                  className={
                    idx === active
                      ? "file-search-item active"
                      : "file-search-item"
                  }
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => pick(rel)}
                >
                  <span className="file-search-name">
                    {highlight(name, query)}
                  </span>
                  <span className="file-search-path" title={rel}>
                    {highlight(dir.replace(/\\/g, "/"), query)}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="file-search-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 打开
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
}
