import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { addSeat } from "../state/room-store";
import { useI18n } from "../i18n/useI18n";

export function RoomAddSeatModal({
  agents,
  onClose,
}: {
  agents: Array<{ name: string; description: string }>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [agentName, setAgentName] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selected = agents.find((a) => a.name === agentName) ?? null;

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    void addSeat("agent", n, agentName || undefined);
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
          <h3>{t.room.addSeatTitle}</h3>
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
            {t.room.addSeatSubmit}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
