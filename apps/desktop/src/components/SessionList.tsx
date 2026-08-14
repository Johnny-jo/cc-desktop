import React, { useState } from "react";
import {
  newChat,
  openProject,
  selectSession,
  startCpa,
  useAppStore,
} from "../state/store";
import { selectRoom } from "../state/room-store";
import { useI18n } from "../i18n/useI18n";
import { StatusDot } from "./StatusDot";
import { FileTree } from "./FileTree";
import { RoomSidebar } from "./RoomSidebar";

const SESSION_PAGE = 30;

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
  const { t } = useI18n();
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const projectPath = useAppStore((s) => s.projectPath);
  const cpaStatus = useAppStore((s) => s.cpaStatus);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE);
  const visibleSessions = sessions.slice(0, sessionLimit);
  const hiddenSessions = Math.max(0, sessions.length - sessionLimit);

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
        <span className="brand-mark">CC</span>
        <span className="brand-sub">Desktop</span>
      </div>

      <button
        type="button"
        className="sidebar-new"
        onClick={() => {
          selectRoom(null);
          newChat();
        }}
      >
        <span className="sidebar-new-icon">+</span>
        {t.sidebar.newChat}
      </button>

      <RoomSidebar />

      <div className="sidebar-section-label">{t.sidebar.recent}</div>

      <ul className="session-list-ul">
        {sessions.length === 0 ? (
          <li className="session-empty">{t.sidebar.noSessions}</li>
        ) : (
          <>
          {visibleSessions.map((s) => {
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
                onClick={() => {
                  selectRoom(null);
                  void selectSession(s.id);
                }}
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
          })}
          {hiddenSessions > 0 ? (
            <li>
              <button
                type="button"
                className="session-more"
                onClick={() => setSessionLimit((n) => n + SESSION_PAGE)}
              >
                {t.sidebar.showMore}（还有 {hiddenSessions}）
              </button>
            </li>
          ) : null}
          </>
        )}
      </ul>

      {/* 文件栏：head 固定贴在文件夹上一格；body 在 head 上方生长，避免切换条跳动 */}
      <div className={`sidebar-files${fileTreeOpen ? " open" : ""}`}>
        {fileTreeOpen ? (
          <div className="sidebar-files-body">
            <FileTree
              selected={selectedFile}
              onSelectFile={onSelectFile}
              onOpenFile={onOpenFile}
            />
          </div>
        ) : null}
        <div className="sidebar-files-head">
          <button
            type="button"
            className="sidebar-files-toggle"
            onClick={onToggleFileTree}
            aria-expanded={fileTreeOpen}
            title={fileTreeOpen ? "收起文件结构" : "展开文件结构"}
          >
            <span
              className={`sidebar-files-chevron${fileTreeOpen ? " open" : ""}`}
              aria-hidden
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 10l4-4 4 4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="sidebar-files-label">文件</span>
          </button>
          {fileTreeOpen && selectedFile && !editorOpen ? (
            <button
              type="button"
              className="pane-side-btn"
              title="在编辑栏打开"
              onClick={onToggleEditor}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M6 3l5 5-5 5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <div className="sidebar-footer">
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
          title={
            cpaStatus.state === "error"
              ? `CPA error: ${cpaStatus.message}`
              : "Start / ensure CPA"
          }
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
