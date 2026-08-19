import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fillTemplate } from "../lib/room-mod-ui";
import { useI18n } from "../i18n/useI18n";

export function RoomInviteModal({
  code,
  port,
  listening,
  onClose,
}: {
  code: string;
  port?: number;
  listening: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // ignore — user can still select + copy manually
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return createPortal(
    <div className="room-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="room-modal room-invite-modal"
        role="dialog"
        aria-label={t.room.inviteTitle}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="room-modal-head">
          <h3>{t.room.inviteTitle}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="room-modal-body">
          <div className="room-invite-code">
            <input
              readOnly
              value={code}
              spellCheck={false}
              onFocus={(e) => e.target.select()}
            />
            <button type="button" className="btn btn-sm" onClick={() => void copy()}>
              {copied ? t.room.inviteCopied : t.common.copy}
            </button>
          </div>
          {listening ? (
            <p className="settings-hint">
              {fillTemplate(t.room.inviteFirewall, { port: String(port ?? "") })}
            </p>
          ) : (
            <p className="room-leave-warn">{t.room.inviteNotListening}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
