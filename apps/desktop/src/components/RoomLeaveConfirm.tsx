import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { fillTemplate } from "../lib/room-mod-ui";
import { useI18n } from "../i18n/useI18n";

export function RoomLeaveConfirm({
  isHost,
  roomName,
  onConfirm,
  onCancel,
}: {
  isHost: boolean;
  roomName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="room-modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="room-modal room-leave-modal"
        role="dialog"
        aria-label={isHost ? t.room.leaveConfirmTitleHost : t.room.leaveConfirmTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="room-modal-head">
          <h3>{isHost ? t.room.leaveConfirmTitleHost : t.room.leaveConfirmTitle}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            ×
          </button>
        </header>
        <div className="room-modal-body">
          <p className="room-leave-text">
            {fillTemplate(
              isHost ? t.room.leaveConfirmBodyHost : t.room.leaveConfirmBody,
              { name: roomName },
            )}
          </p>
          {isHost ? (
            <p className="room-leave-warn">{t.room.leaveConfirmWarnHost}</p>
          ) : null}
        </div>
        <footer className="room-modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            {t.common.cancel}
          </button>
          <button
            type="button"
            className={`btn btn-sm${isHost ? " btn-danger" : ""}`}
            onClick={onConfirm}
            autoFocus
          >
            {isHost ? t.room.leaveConfirmYesHost : t.room.leaveConfirmYes}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
