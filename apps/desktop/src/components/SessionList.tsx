import React from "react";
import {
  newChat,
  openProject,
  selectSession,
  startCpa,
  useAppStore,
} from "../state/store";
import { StatusDot } from "./StatusDot";
import { FileTree } from "./FileTree";

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export type SessionListProps = {
  onOpenSettings: () => void;
  /** File tree (pull-up) panel state and callbacks */
  fileTreeOpen: boolean;
  onToggleFileTree: () => void;
  selectedFile: string | null;
  onSelectFile: (rel: string) => void;
  onOpenFile: (rel: string) => void;
  editorOpen: boolean;
  onToggleEditor: () => void;
};

export function SessionList({
  onOpenSettings,
  fileTreeOpen,
  onToggleFileTree,
  selectedFile,
  onSelectFile,
  onOpenFile,
  editorOpen,
  onToggleEditor,
}: SessionListProps) {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const projectPath = useAppStore((s) => s.projectPath);
  const cpaStatus = useAppStore((s) => s.cpaStatus);

  const onBrowse = async () => {
    try {
      await openProject();
    } catch {
      // lastError in store
    }
  };

  const projectLabel = projectPath
    ? projectPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
      projectPath
    : "No project";

  return (
    <div className="session-list">
      <div className="sidebar-brand">
        <svg
          className="brand-icon"
          width="20"
          height="20"
          viewBox="0 0 20 20"
          aria-hidden
        >
          <path
            d="M10 2c0.5 3.4 1.1 4.9 2.4 6.2s2.8 1.9 6.2 2.4c-3.4 0.5-4.9 1.1-6.2 2.4s-1.9 2.8-2.4 6.2c-0.5-3.4-1.1-4.9-2.4-6.2S4.8 11.1 1.4 10.6c3.4-0.5 4.9-1.1 6.2-2.4S9.5 5.4 10 2z"
            fill="currentColor"
          />
        </svg>
        <span className="brand-mark">Claude</span>
        <span className="brand-sub">Desktop</span>
      </div>

      <button
        type="button"
        className="sidebar-new"
        onClick={() => newChat()}
      >
        <span className="sidebar-new-icon">+</span>
        New chat
      </button>

      <div className="sidebar-section-label">Recent</div>

      <ul className="session-list-ul">
        {sessions.length === 0 ? (
          <li className="session-empty">No sessions yet</li>
        ) : (
          sessions.map((s) => {
            const folder =
              s.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
              "";
            return (
            <li key={s.id} className="session-list-item">
              <button
                type="button"
                className={
                  s.id === activeSessionId
                    ? "session-item active"
                    : "session-item"
                }
                onClick={() => void selectSession(s.id)}
                title={`${s.title}${s.cwd ? `\n${s.cwd}` : ""}`}
              >
                <span className="session-title">{s.title}</span>
                <span className="session-meta">
                  {folder ? (
                    <span className="session-folder" title={s.cwd}>
                      {folder}
                    </span>
                  ) : null}
                  <span className={`session-status status-${s.status}`}>
                    {s.status === "running" ? "● running" : formatTime(s.updatedAt)}
                  </span>
                </span>
              </button>
            </li>
            );
          })
        )}
      </ul>

      <div className="sidebar-footer">
        {/* Pull-up file tree above the project folder row (VSCode style) */}
        <div className={`sidebar-files${fileTreeOpen ? " open" : ""}`}>
          <div className="sidebar-files-head">
            <button
              type="button"
              className="sidebar-files-toggle"
              onClick={onToggleFileTree}
              aria-expanded={fileTreeOpen}
              title={fileTreeOpen ? "收起文件结构" : "展开文件结构"}
            >
              <span className={`sidebar-files-chevron${fileTreeOpen ? " open" : ""}`}>
                ▴
              </span>
              <span className="sidebar-files-label">文件</span>
            </button>
            {fileTreeOpen && selectedFile && !editorOpen ? (
              <button
                type="button"
                className="sidebar-files-sidebtn"
                title="在编辑栏打开"
                onClick={onToggleEditor}
              >
                ⇥
              </button>
            ) : null}
          </div>
          {fileTreeOpen ? (
            <div className="sidebar-files-body">
              <FileTree
                selected={selectedFile}
                onSelectFile={onSelectFile}
                onOpenFile={onOpenFile}
              />
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="sidebar-footer-row"
          onClick={() => void onBrowse()}
          title={projectPath ?? "Open project folder"}
        >
          <span className="sidebar-footer-icon">📁</span>
          <span className="sidebar-footer-text">{projectLabel}</span>
        </button>
        <button
          type="button"
          className="sidebar-footer-row"
          onClick={() => void startCpa()}
          title="Start / ensure CPA"
        >
          <StatusDot status={cpaStatus} compact />
        </button>
        <button
          type="button"
          className="sidebar-footer-row"
          onClick={onOpenSettings}
        >
          <span className="sidebar-footer-icon">⚙</span>
          <span className="sidebar-footer-text">Settings</span>
        </button>
      </div>
    </div>
  );
}
