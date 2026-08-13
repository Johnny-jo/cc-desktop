import React, { useEffect, useState } from "react";
import { getDesktop } from "../lib/desktop-api";
import { useAppStore } from "../state/store";

/**
 * Read-only project file viewer pane (opens next to the chat column).
 * Editing/saving comes later — this is the navigation companion.
 */
export function FileEditor({
  rel,
  onClose,
}: {
  rel: string;
  onClose: () => void;
}) {
  const projectPath = useAppStore((s) => s.projectPath);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!projectPath || !rel) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    setTruncated(false);
    void (async () => {
      try {
        const res = await getDesktop().readProjectFile(projectPath, rel);
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? "读取失败");
          return;
        }
        setContent(res.content ?? "");
        setTruncated(Boolean(res.truncated));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath, rel]);

  const name = rel.split(/[/\\]/).pop() ?? rel;

  return (
    <div className="file-editor">
      <div className="file-editor-head">
        <span className="file-editor-name" title={rel}>
          {name}
        </span>
        <span className="file-editor-path" title={rel}>
          {rel}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          title="关闭"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="file-editor-body">
        {error ? (
          <p className="file-editor-hint">无法打开：{error}</p>
        ) : content === null ? (
          <p className="file-editor-hint">加载中…</p>
        ) : (
          <>
            <pre className="file-editor-code">{content}</pre>
            {truncated ? (
              <p className="file-editor-hint">（内容过长，已截断显示）</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
