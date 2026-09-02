import React from "react";
import {
  selectSession,
  setTheme,
  startCpa,
  toggleCliMode,
  useAppStore,
} from "../state/store";
import { selectRoom, useRoomStore } from "../state/room-store";
import { effectiveTheme, nextTheme } from "../lib/theme";

/** 左侧 icon 工具栏的模式：AI 对话 / 群聊（好友为占位）。 */
export type RailMode = "chat" | "rooms" | "friends";

function IconChat() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M10 3.2c-3.9 0-7 2.5-7 5.6 0 1.7.9 3.2 2.4 4.3l-.6 2.7 2.9-1.5c.7.2 1.5.3 2.3.3 3.9 0 7-2.5 7-5.7s-3.1-5.7-7-5.7Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconRooms() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="7.5" cy="6.8" r="2.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="13.8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2.8 16.2c0-2.4 2-4 4.7-4s4.7 1.6 4.7 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M13.2 12.4c1.9.3 3.3 1.6 3.3 3.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconFriends() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="6.6" r="2.9" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4 16.4c0-3 2.7-4.8 6-4.8s6 1.8 6 4.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCli() {
  return (
    <svg width="19" height="19" viewBox="0 0 17 17" fill="none" aria-hidden>
      <rect x="2.5" y="3.5" width="12" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5 8.5 l2 2 -2 2M9.5 12.2 H12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSettings() {
  // 齿轮（lucide settings 造型），避免与日夜切换的太阳图标撞脸。
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconCpa() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M11 2.5 5 11h3.6L8.6 17.5 15 8.6h-3.7L11 2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTheme({ isLight }: { isLight: boolean }) {
  if (isLight) {
    return (
      <svg width="19" height="19" viewBox="0 0 17 17" fill="none" aria-hidden>
        <circle cx="8.5" cy="8.5" r="3.2" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M8.5 1.5v1.6M8.5 13.9v1.6M1.5 8.5h1.6M13.9 8.5h1.6M3.5 3.5l1.1 1.1M12.4 12.4l1.1 1.1M13.5 3.5l-1.1 1.1M4.6 12.4l-1.1 1.1"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg width="19" height="19" viewBox="0 0 17 17" fill="none" aria-hidden>
      <path
        d="M14.2 10.6A6 6 0 0 1 6.4 2.8a6 6 0 1 0 7.8 7.8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 窗口最左侧的窄 icon 栏（参考 QQ）：上方是视图切换（AI 对话 / 群聊 /
 * 好友占位 / CLI），下方自底向上是 设置 / CPA / 日夜模式。
 */
export function SideRail({
  mode,
  onModeChange,
  onOpenSettings,
}: {
  mode: RailMode;
  onModeChange: (m: RailMode) => void;
  onOpenSettings: () => void;
}) {
  const cliMode = useAppStore((s) => s.cliMode);
  const cpaStatus = useAppStore((s) => s.cpaStatus);
  const settings = useAppStore((s) => s.settings);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const rooms = useRoomStore((s) => s.rooms);
  const anyRoomOpen = rooms.some((r) => r.status === "open");
  const isLight = effectiveTheme(settings?.theme) === "light";

  const cliDisabled = mode === "rooms";
  /** CLI 会话独占主区时不允许切去群聊（反向限制：群聊下 CLI 也禁用）。 */
  const roomsDisabled = cliMode;
  const onToggleCli = () => {
    if (cliDisabled) return;
    const next = !cliMode;
    toggleCliMode();
    if (!next && activeSessionId) {
      void selectSession(activeSessionId);
    }
  };

  const cpaClass =
    cpaStatus.state === "ready"
      ? " is-on"
      : cpaStatus.state === "starting"
        ? " is-busy"
        : cpaStatus.state === "error"
          ? " is-err"
          : "";
  const cpaTitle =
    cpaStatus.state === "error"
      ? `CPA 错误：${cpaStatus.message}`
      : cpaStatus.state === "ready"
        ? "CPA 运行中"
        : "启动 CPA";

  return (
    <nav className="side-rail" aria-label="主导航">
      <div className="side-rail-top">
        <button
          type="button"
          className={`side-rail-btn${mode === "chat" ? " active" : ""}`}
          title="AI 对话"
          aria-label="AI 对话"
          aria-pressed={mode === "chat"}
          onClick={() => {
            selectRoom(null);
            onModeChange("chat");
          }}
        >
          <IconChat />
        </button>
        <button
          type="button"
          className={`side-rail-btn${mode === "rooms" ? " active" : ""}${roomsDisabled ? " is-disabled" : ""}`}
          title={roomsDisabled ? "CLI 模式下不可用" : "群聊"}
          aria-label="群聊"
          aria-pressed={mode === "rooms"}
          aria-disabled={roomsDisabled}
          onClick={() => {
            if (roomsDisabled) return;
            onModeChange("rooms");
          }}
        >
          <IconRooms />
          {anyRoomOpen ? <span className="side-rail-dot" aria-hidden /> : null}
        </button>
        <button
          type="button"
          className="side-rail-btn is-disabled"
          title="好友（敬请期待）"
          aria-label="好友（敬请期待）"
          aria-disabled="true"
        >
          <IconFriends />
        </button>
        <button
          type="button"
          className={`side-rail-btn${cliMode ? " active" : ""}${cliDisabled ? " is-disabled" : ""}`}
          title={cliDisabled ? "群聊模式下不可用" : cliMode ? "返回桌面模式" : "切换到 CLI 模式"}
          aria-label="CLI 模式"
          aria-pressed={cliMode}
          aria-disabled={cliDisabled}
          onClick={onToggleCli}
        >
          <IconCli />
        </button>
      </div>
      <div className="side-rail-bottom">
        <button
          type="button"
          className="side-rail-btn"
          title={isLight ? "切换到夜间模式" : "切换到日间模式"}
          aria-label={isLight ? "切换到夜间模式" : "切换到日间模式"}
          onClick={() => void setTheme(nextTheme(settings?.theme))}
        >
          <IconTheme isLight={isLight} />
        </button>
        <button
          type="button"
          className={`side-rail-btn side-rail-cpa${cpaClass}`}
          title={cpaTitle}
          aria-label={cpaTitle}
          onClick={() => void startCpa()}
        >
          <IconCpa />
        </button>
        <button
          type="button"
          className="side-rail-btn"
          title="设置"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <IconSettings />
        </button>
      </div>
    </nav>
  );
}
