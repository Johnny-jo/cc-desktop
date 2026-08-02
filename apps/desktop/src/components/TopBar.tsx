import React, { useState } from "react";
import type { PermissionMode } from "@claude-desktop/shared";
import { StatusDot } from "./StatusDot";
import {
  openProject,
  setModel,
  setPermissionMode,
  startCpa,
  useAppStore,
} from "../state/store";

const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];

export function TopBar() {
  const projectPath = useAppStore((s) => s.projectPath);
  const cpaStatus = useAppStore((s) => s.cpaStatus);
  const settings = useAppStore((s) => s.settings);
  const lastError = useAppStore((s) => s.lastError);
  const [pathDraft, setPathDraft] = useState("");

  const models = settings?.models?.length
    ? settings.models
    : settings?.defaultModel
      ? [settings.defaultModel]
      : [];

  const onOpen = async () => {
    const path = (pathDraft || projectPath || "").trim();
    if (!path) return;
    try {
      await openProject(path);
      setPathDraft("");
    } catch (err) {
      // lastError set in store if openProject propagates; local catch for throw
      console.error(err);
    }
  };

  return (
    <div className="topbar">
      <span className="brand">Claude Desktop</span>

      <div className="topbar-project">
        <input
          className="topbar-input"
          placeholder={projectPath ?? "Project path…"}
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onOpen();
          }}
          title={projectPath ?? "Open project path"}
        />
        <button type="button" className="btn" onClick={() => void onOpen()}>
          Open
        </button>
      </div>

      <span className="topbar-path" title={projectPath ?? ""}>
        {projectPath ?? "No project"}
      </span>

      <button
        type="button"
        className="btn"
        onClick={() => void startCpa()}
        title="Start / ensure CPA"
      >
        <StatusDot status={cpaStatus} />
      </button>

      <label className="topbar-field">
        Model
        <select
          value={settings?.defaultModel ?? ""}
          disabled={!settings}
          onChange={(e) => void setModel(e.target.value)}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      <label className="topbar-field">
        Permission
        <select
          value={settings?.permissionMode ?? "default"}
          disabled={!settings}
          onChange={(e) =>
            void setPermissionMode(e.target.value as PermissionMode)
          }
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      {lastError ? (
        <span className="topbar-error" title={lastError}>
          {lastError}
        </span>
      ) : null}
    </div>
  );
}
