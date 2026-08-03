import React from "react";
import type { PermissionMode } from "@claude-desktop/shared";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { setModel, setPermissionMode, useAppStore } from "../state/store";

const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];

export type ChatPanelProps = {
  changesOpen: boolean;
  onToggleChanges: () => void;
  onOpenSettings: () => void;
};

export function ChatPanel({
  changesOpen,
  onToggleChanges,
  onOpenSettings,
}: ChatPanelProps) {
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const itemsBySession = useAppStore((s) => s.itemsBySession);
  const sessions = useAppStore((s) => s.sessions);
  const running = useAppStore((s) => s.running);
  const settings = useAppStore((s) => s.settings);

  const items = activeSessionId ? (itemsBySession[activeSessionId] ?? []) : [];
  const active = sessions.find((s) => s.id === activeSessionId);

  const models = settings?.models?.length
    ? settings.models
    : settings?.defaultModel
      ? [settings.defaultModel]
      : [];

  return (
    <div className="chat-panel">
      <header className="chat-header">
        <div className="chat-header-left">
          <span className="chat-title">
            {active ? active.title : "New chat"}
          </span>
          {running ? <span className="badge running">running</span> : null}
        </div>
        <div className="chat-header-right">
          <label className="chat-header-field">
            <select
              className="select select-ghost"
              value={settings?.defaultModel ?? ""}
              disabled={!settings}
              onChange={(e) => void setModel(e.target.value)}
              title="Model"
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="chat-header-field">
            <select
              className="select select-ghost"
              value={settings?.permissionMode ?? "default"}
              disabled={!settings}
              onChange={(e) =>
                void setPermissionMode(e.target.value as PermissionMode)
              }
              title="Permission mode"
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
            className="btn btn-ghost btn-icon"
            onClick={onToggleChanges}
            title={changesOpen ? "Hide changes" : "Show changes"}
            aria-pressed={changesOpen}
          >
            {changesOpen ? "⟩" : "⟨"} Diff
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onOpenSettings}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <div className="chat-body">
        <div className="chat-inner">
          <MessageList items={items} />
        </div>
      </div>

      <div className="chat-composer">
        <div className="chat-inner">
          <Composer />
        </div>
      </div>
    </div>
  );
}
