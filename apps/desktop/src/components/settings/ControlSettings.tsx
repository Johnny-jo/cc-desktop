import React from "react";
import type { PlaywrightBrowser, SessionMcpServerStatus } from "@claude-desktop/shared";
import { ToggleSwitch } from "../ToggleSwitch";
import { controlTarget, type ControlTarget, type McpServerDraft } from "./mcp-form";
import "./ControlSettings.css";

const targets = [
  { key: "windows-computer", label: "桌面应用", description: "查看和操作 Windows 应用，按 Esc 退出控制。控制管理员窗口时，按 Windows 提示为该窗口临时授权。" },
  { key: "chrome", label: "Google Chrome", description: "在 Chrome 中浏览网页和操作标签页。" },
  { key: "msedge", label: "Microsoft Edge", description: "在 Edge 中浏览网页和操作标签页。" },
] as const;

type Props = {
  rows: McpServerDraft[];
  live: Record<string, SessionMcpServerStatus & { probe?: boolean }>;
  isWindows: boolean;
  expanded: ControlTarget | null;
  onExpand: (target: ControlTarget | null) => void;
  onToggle: (target: ControlTarget, enabled: boolean) => void;
  onAdd: (target: PlaywrightBrowser) => void;
  renderProfile: (row: McpServerDraft, index: number) => React.ReactNode;
  onProbe: (rows: McpServerDraft[]) => void;
  probingTarget: ControlTarget | "mcp" | null;
  note?: string;
};

function statusText(active: McpServerDraft[], live: Props["live"]) {
  if (!active.length) return "已关闭";
  const statuses = active.map(row => live[row.name.trim()]?.status);
  if (statuses.includes("failed")) return "连接失败";
  if (statuses.includes("needs-auth")) return "需要授权";
  if (statuses.includes("pending")) return "连接中";
  if (statuses.includes("disabled")) return "会话已停用";
  if (statuses.every(status => status === "connected")) {
    return active.some(row => live[row.name.trim()]?.probe) ? "测试通过" : "已连接";
  }
  return "已启用";
}

export function ControlSettings({ rows, live, isWindows, expanded, onExpand, onToggle, onAdd, renderProfile, onProbe, probingTarget, note }: Props) {
  return (
    <div className="control-settings">
      {targets.map(({ key, label, description }) => {
        const profiles = rows.filter(row => controlTarget(row) === key);
        const active = profiles.filter(row => !row.disabled);
        const enabled = active.length > 0;
        const supported = key !== "windows-computer" || isWindows;
        const isOpen = expanded === key;
        const status = supported ? statusText(active, live) : "仅支持 Windows";
        return (
          <section key={key} className="control-settings-target">
            <div className="control-settings-row">
              <span aria-hidden="true" className={`control-app-icon control-app-icon-${key}`} />
              <div className="control-settings-identity">
                <h3>{label}</h3>
                <p>{description}</p>
              </div>
              <div className="control-settings-actions">
                <span className="control-settings-status" data-connected={status === "已连接"}>{status}</span>
                {(key !== "windows-computer" || profiles.length > 0) && (
                  <button type="button" className="btn btn-ghost btn-sm" aria-expanded={isOpen}
                    aria-controls={isOpen ? `control-profiles-${key}` : undefined}
                    aria-label={`${isOpen ? "收起" : "管理"}${label}配置`}
                    onClick={() => onExpand(isOpen ? null : key)}>{isOpen ? "收起" : "管理"}</button>
                )}
                <ToggleSwitch label={`${label}操控`} checked={enabled} disabled={!supported && !enabled}
                  onCheckedChange={checked => onToggle(key, checked)} />
              </div>
            </div>
            {isOpen && (
              <div id={`control-profiles-${key}`} className="control-settings-profiles">
                {profiles.map(renderProfile)}
                {!profiles.length && <p className="settings-hint">添加配置可指定连接名称、浏览器模式和配置目录。</p>}
                <div className="settings-collection-actions">
                  {key !== "windows-computer" && (
                    <button type="button" className="btn btn-sm" onClick={() => onAdd(key)}>添加配置</button>
                  )}
                  {supported && enabled && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={probingTarget !== null}
                      onClick={() => onProbe(active)}>{probingTarget === key ? "测试中…" : "测试连接"}</button>
                  )}
                </div>
              </div>
            )}
          </section>
        );
      })}
      {note && <p className="settings-hint" role="status">{note}</p>}
    </div>
  );
}
