import React, { useCallback, useEffect, useState } from "react";
import { getDesktop } from "../lib/desktop-api";
import { useAppStore } from "../state/store";

type DirEntry = { name: string; rel: string; kind: "dir" | "file" };

type TreeNodeProps = {
  cwd: string;
  entry: DirEntry;
  depth: number;
  selected: string | null;
  onSelect: (rel: string) => void;
  onOpen: (rel: string) => void;
  /** Bumped when the filesystem may have changed — reloads expanded dirs. */
  refreshKey: number;
};

function TreeNode({
  cwd,
  entry,
  depth,
  selected,
  onSelect,
  onOpen,
  refreshKey,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  const fetchChildren = useCallback(async () => {
    try {
      const res = await getDesktop().listProjectDir(cwd, entry.rel);
      setChildren(res.entries);
    } catch {
      setChildren([]);
    }
  }, [cwd, entry.rel]);

  const toggle = async () => {
    if (entry.kind !== "dir") return;
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      await fetchChildren();
    }
  };

  // Sync expanded dirs with filesystem changes (file added/deleted/renamed).
  useEffect(() => {
    if (entry.kind === "dir" && expanded) {
      void fetchChildren();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (entry.kind === "file") {
    return (
      <div
        className={`ft-node ft-file${selected === entry.rel ? " selected" : ""}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        title={entry.rel}
        onClick={() => onSelect(entry.rel)}
        onDoubleClick={() => onOpen(entry.rel)}
      >
        <span className="ft-icon" aria-hidden>
          📄
        </span>
        <span className="ft-name">{entry.name}</span>
      </div>
    );
  }

  return (
    <div>
      <div
        className="ft-node ft-dir"
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => void toggle()}
        title={entry.rel}
      >
        <span className={`ft-chevron${expanded ? " open" : ""}`} aria-hidden>
          ▸
        </span>
        <span className="ft-icon" aria-hidden>
          {expanded ? "📂" : "📁"}
        </span>
        <span className="ft-name">{entry.name}</span>
      </div>
      {expanded
        ? (children ?? []).map((c) => (
            <TreeNode
              key={c.rel}
              cwd={cwd}
              entry={c}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              onOpen={onOpen}
              refreshKey={refreshKey}
            />
          ))
        : null}
      {expanded && children !== null && children.length === 0 ? (
        <div
          className="ft-empty"
          style={{ paddingLeft: 10 + (depth + 1) * 14 }}
        >
          空目录
        </div>
      ) : null}
    </div>
  );
}

/**
 * Project file tree shown inside the sessions sidebar (pull-up panel).
 * Selecting a file shows the side-open affordance; double-click opens the
 * editor pane directly.
 */
export function FileTree({
  onSelectFile,
  onOpenFile,
  selected,
}: {
  onSelectFile: (rel: string) => void;
  onOpenFile: (rel: string) => void;
  selected: string | null;
}) {
  const projectPath = useAppStore((s) => s.projectPath);
  // Any diff push means the agent likely touched the filesystem.
  const refreshKey = useAppStore((s) => s.fsChangeTick);
  const [roots, setRoots] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectPath) {
      setRoots(null);
      return;
    }
    setError(null);
    try {
      const res = await getDesktop().listProjectDir(projectPath, "");
      setRoots(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRoots([]);
    }
  }, [projectPath]);

  useEffect(() => {
    setRoots(null);
    void load();
  }, [load]);

  // Refresh root listing on filesystem changes (keeps children via refreshKey).
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (!projectPath) {
    return <p className="ft-hint">先打开项目</p>;
  }
  if (error) {
    return (
      <p className="ft-hint">
        加载失败：{error}{" "}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
          重试
        </button>
      </p>
    );
  }
  if (roots === null) {
    return <p className="ft-hint">加载中…</p>;
  }
  if (roots.length === 0) {
    return <p className="ft-hint">空目录</p>;
  }
  return (
    <div className="ft-tree" role="tree">
      {roots.map((e) => (
        <TreeNode
          key={e.rel}
          cwd={projectPath}
          entry={e}
          depth={0}
          selected={selected}
          onSelect={onSelectFile}
          onOpen={onOpenFile}
          refreshKey={refreshKey}
        />
      ))}
    </div>
  );
}
