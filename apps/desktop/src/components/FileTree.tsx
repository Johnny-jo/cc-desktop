import React, { useEffect, useRef, useState } from "react";
import { getDesktop } from "../lib/desktop-api";
import {
  createDebouncedLatest,
  FILE_TREE_REFRESH_MS,
} from "../lib/debounce-latest";
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
  const loaderRef = useRef(createDebouncedLatest<DirEntry[]>(FILE_TREE_REFRESH_MS));
  const wasExpanded = useRef(false);

  useEffect(() => () => loaderRef.current.cancel(), []);

  const toggle = () => {
    if (entry.kind !== "dir") return;
    setExpanded((v) => !v);
  };

  // Load (and refresh) children when expanded. Debounced so a tool_use tick
  // cannot overwrite the later listing after the file lands.
  useEffect(() => {
    if (entry.kind !== "dir" || !expanded) {
      wasExpanded.current = false;
      return;
    }
    const delay = wasExpanded.current ? FILE_TREE_REFRESH_MS : 0;
    wasExpanded.current = true;
    loaderRef.current.schedule(
      async () => {
        const res = await getDesktop().listProjectDir(cwd, entry.rel);
        return res.entries;
      },
      setChildren,
      () => setChildren([]),
      delay,
    );
  }, [refreshKey, expanded, cwd, entry.rel, entry.kind]);

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
  const loaderRef = useRef(
    createDebouncedLatest<{ entries: DirEntry[] }>(FILE_TREE_REFRESH_MS),
  );

  useEffect(() => () => loaderRef.current.cancel(), []);

  const load = (delay: number) => {
    if (!projectPath) {
      setRoots(null);
      return;
    }
    setError(null);
    loaderRef.current.schedule(
      () => getDesktop().listProjectDir(projectPath, ""),
      (res) => setRoots(res.entries),
      () => {
        setError("加载失败");
        setRoots([]);
      },
      delay,
    );
  };

  useEffect(() => {
    setRoots(null);
    load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  useEffect(() => {
    if (refreshKey === 0) return;
    load(FILE_TREE_REFRESH_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  if (!projectPath) {
    return <p className="ft-hint">先打开项目</p>;
  }
  if (error) {
    return (
      <p className="ft-hint">
        加载失败：{error}{" "}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load(0)}>
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
