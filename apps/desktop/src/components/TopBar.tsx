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

export type TopBarProps = {
  onOpenSettings: () => void;
};

export function TopBar({ onOpenSettings }: TopBarProps) {
  const projectPath = useAppStore((s) => s.projectPath);
  const cpaStatus = useAppStore((s) => s.cpaStatus);
  const settings = useAppStore((s) => s.settings);

  const models = settings?.models?.length
    ? settings.models
    : settings?.defaultModel
      ? [settings.defaultModel]
      : [];

  const onBrowse = async () => {
    try {
      await openProject();
    } catch {
      // lastError set in store
    }
  };

  return (
    <div className="topbar">
      <span className="brand">Claude Desktop</span>

      <div className="topbar-project">
        <button
          type="button"
          className="btn"
          onClick={() => void onBrowse()}
          title="Open project folder"
        >
          Open folder
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

      <button
        type="button"
        className="btn topbar-settings"
        onClick={onOpenSettings}
        title="Settings"
      >
        Settings
      </button>
    </div>
  );
}
