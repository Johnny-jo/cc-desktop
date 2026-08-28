import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { addSeat, updateSeat } from "../state/room-store";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import { useI18n } from "../i18n/useI18n";

export type SeatDraft = {
  seatId?: string;
  name: string;
  agentName: string;
  agentPrompt: string;
  skillNames: string[];
  model: string;
  /** 执行节点 userId；"" = 房主本机 */
  executorUserId: string;
};

export function RoomAddSeatModal({
  agents,
  models,
  executors,
  initial,
  onClose,
}: {
  agents: Array<{ name: string; description: string }>;
  models: string[];
  /** 可选的执行节点（首位是房主，userId 为 ""）；projectPath 为该成员当前打开的项目 */
  executors?: Array<{ userId: string; label: string; projectPath?: string | null }>;
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
  const [executorUserId, setExecutorUserId] = useState(
    initial?.executorUserId ?? "",
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
  const selectedExecutor =
    executors?.find((e) => e.userId === executorUserId) ?? null;

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
      executorUserId: executorUserId || undefined,
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
          <label className="settings-field">
            {t.room.addSeatModel}
            <select
              className="select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">{t.room.addSeatModelDefault}</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          {executors && executors.length > 1 ? (
            <label className="settings-field">
              运行位置
              <select
                className="select"
                value={executorUserId}
                onChange={(e) => setExecutorUserId(e.target.value)}
              >
                {executors.map((ex) => (
                  <option key={ex.userId} value={ex.userId}>
                    {ex.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {executors && executors.length > 1 && executorUserId ? (
            <p className="settings-hint">
              这个 Agent 会在对方电脑上执行，改动落在对方的项目里；写文件需对方本人确认。
            </p>
          ) : null}
          {selectedExecutor && !selectedExecutor.projectPath ? (
            <p className="settings-hint">
              {selectedExecutor.userId
                ? "对方当前没有打开项目，现在发起执行会失败。"
                : "房主当前没有打开项目，执行会失败。"}
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
