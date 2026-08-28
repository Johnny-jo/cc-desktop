import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { RoomAiShare } from "@claude-desktop/shared";
import { addSeat, updateSeat } from "../state/room-store";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import { useI18n } from "../i18n/useI18n";

export type SeatMemberOpt = {
  userId: string;
  label: string;
  projectPath?: string | null;
  aiShare?: RoomAiShare;
  aiModels?: string[];
  isSelf?: boolean;
};

export type SeatDraft = {
  seatId?: string;
  name: string;
  agentName: string;
  agentPrompt: string;
  skillNames: string[];
  model: string;
  /** @deprecated 等于 workspaceUserId */
  executorUserId: string;
  aiUserId: string;
  workspaceUserId: string;
};

export function RoomAddSeatModal({
  agents,
  models,
  members,
  canRetarget,
  onAskAiShare,
  initial,
  onClose,
}: {
  agents: Array<{ name: string; description: string }>;
  models: string[];
  members?: SeatMemberOpt[];
  canRetarget?: boolean;
  onAskAiShare?: (userId: string) => void;
  initial?: SeatDraft;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? "");
  const [agentName, setAgentName] = useState(initial?.agentName ?? "");
  const [agentPrompt, setAgentPrompt] = useState(initial?.agentPrompt ?? "");
  const [skillNames, setSkillNames] = useState<string[]>(
    initial?.skillNames ?? [],
  );
  const [model, setModel] = useState(initial?.model ?? "");
  const [aiUserId, setAiUserId] = useState(
    initial?.aiUserId || initial?.executorUserId || "",
  );
  const [workspaceUserId, setWorkspaceUserId] = useState(
    initial?.workspaceUserId || initial?.executorUserId || "",
  );
  const [skills, setSkills] = useState<Array<{ name: string; scope: string }>>(
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!hasDesktopApi("listSkills")) return;
    void getDesktop()
      .listSkills()
      .then((res) => {
        setSkills(res.skills ?? []);
      })
      .catch(() => undefined);
  }, []);

  const selected = agents.find((a) => a.name === agentName) ?? null;
  const aiMember = members?.find((e) => e.userId === aiUserId) ?? null;
  const wsMember = members?.find((e) => e.userId === workspaceUserId) ?? null;
  const modelList =
    !aiMember || aiMember.isSelf ? models : (aiMember.aiModels ?? []);
  const showAxes = Boolean(members && members.length > 0 && canRetarget);
  const shareHint =
    aiMember && !aiMember.isSelf
      ? aiMember.aiShare === "on"
        ? null
        : aiMember.aiShare === "pending"
          ? "等待对方同意借用 AI"
          : "尚未借用对方的 AI，需要先请求同意"
      : null;

  const toggleSkill = (n: string) => {
    setSkillNames((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n],
    );
  };

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    const extra = {
      agentPrompt: agentPrompt.trim() || undefined,
      skillNames: skillNames.length ? skillNames : undefined,
      model: model.trim() || undefined,
      executorUserId: workspaceUserId || undefined,
      workspaceUserId: workspaceUserId || undefined,
      aiUserId: aiUserId || undefined,
    };
    if (initial?.seatId) {
      void updateSeat(initial.seatId, {
        name: n,
        agentName: agentName || n,
        ...extra,
      });
    } else {
      void addSeat("agent", n, agentName || undefined, extra);
    }
    onClose();
  };

  return createPortal(
    <div className="room-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="room-modal"
        role="dialog"
        aria-label={t.room.addSeatTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="room-modal-head">
          <h3>{initial?.seatId ? t.room.seatSettings : t.room.addSeatTitle}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="room-modal-body">
          <label className="settings-field">
            {t.room.addSeatName}
            <input
              placeholder={t.room.addSeatNamePh}
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
          <label className="settings-field">
            {t.room.addSeatAgent}
            <select
              className="select"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            >
              <option value="">{t.room.addSeatAgentNone}</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {selected?.description ? (
            <p className="settings-hint">{selected.description}</p>
          ) : null}
          <label className="settings-field">
            {t.room.addSeatPrompt}
            <textarea
              rows={3}
              value={agentPrompt}
              placeholder={t.room.addSeatPromptPh}
              onChange={(e) => setAgentPrompt(e.target.value)}
            />
          </label>
          {showAxes ? (
            <label className="settings-field">
              AI 来源
              <select
                className="select"
                value={aiUserId}
                onChange={(e) => {
                  setAiUserId(e.target.value);
                  setModel("");
                }}
              >
                {members!.map((ex) => (
                  <option key={ex.userId} value={ex.userId}>
                    {ex.label}
                    {ex.isSelf
                      ? ""
                      : ex.aiShare === "on"
                        ? "（已共享模型）"
                        : "（未共享）"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {shareHint ? <p className="settings-hint">{shareHint}</p> : null}
          {aiMember && !aiMember.isSelf && aiMember.aiShare !== "on" ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={aiMember.aiShare === "pending"}
              onClick={() => onAskAiShare?.(aiMember.userId)}
            >
              {aiMember.aiShare === "pending" ? "等待同意" : "请求借用"}
            </button>
          ) : null}
          <label className="settings-field">
            {t.room.addSeatModel}
            <select
              className="select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={Boolean(aiMember && !aiMember.isSelf && aiMember.aiShare !== "on")}
            >
              <option value="">{t.room.addSeatModelDefault}</option>
              {modelList.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          {showAxes ? (
            <label className="settings-field">
              工作目录
              <select
                className="select"
                value={workspaceUserId}
                onChange={(e) => setWorkspaceUserId(e.target.value)}
              >
                {members!.map((ex) => (
                  <option key={ex.userId} value={ex.userId}>
                    {ex.label}
                    {ex.projectPath ? `（${ex.projectPath}）` : "（未开项目）"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {showAxes && aiUserId && workspaceUserId && aiUserId !== workspaceUserId ? (
            <p className="settings-hint">
              循环在文件主人电脑上跑，模型请求转到 AI 主人；写文件由文件主人确认。
            </p>
          ) : null}
          {wsMember && !wsMember.projectPath ? (
            <p className="settings-hint">
              {wsMember.isSelf
                ? "当前没有打开项目，执行会失败。"
                : "对方当前没有打开项目，现在发起执行会失败。"}
            </p>
          ) : null}
          {skills.length ? (
            <fieldset className="settings-field">
              <legend>{t.room.addSeatSkills}</legend>
              <div className="room-seat-skills">
                {skills.map((s) => (
                  <label key={`${s.scope}-${s.name}`} className="room-check">
                    <input
                      type="checkbox"
                      checked={skillNames.includes(s.name)}
                      onChange={() => toggleSkill(s.name)}
                    />
                    {s.name}
                    <span className="settings-hint">{s.scope}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <p className="settings-hint">{t.room.addSeatSkillsEmpty}</p>
          )}
        </div>
        <footer className="room-modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!name.trim()}
            onClick={submit}
          >
            {initial?.seatId ? t.common.save : t.room.addSeatSubmit}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
