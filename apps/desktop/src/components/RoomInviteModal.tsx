import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { decodeRoomInvite, looksLikeRoomInvite } from "@claude-desktop/shared";
import { fillTemplate } from "../lib/room-mod-ui";
import { shortFingerprint } from "../lib/room-invite-ui";
import { useI18n } from "../i18n/useI18n";

export function RoomInviteModal({
  code,
  port,
  listening,
  encrypt,
  hostFingerprint,
  onClose,
}: {
  code: string;
  port?: number;
  listening: boolean;
  /** Snapshot transport flags — shown so guests know what they will get. */
  encrypt: boolean;
  hostFingerprint?: string;
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

  const relayUrl = (() => {
    if (!looksLikeRoomInvite(code)) return "";
    try {
      return (decodeRoomInvite(code).wss ?? [])[0] ?? "";
    } catch {
      return "";
    }
  })();

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
          <button
            type="button"
            className="settings-close-btn"
            title={t.common.close}
            aria-label={t.common.close}
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
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
            <button
              type="button"
              className={`room-action-icon room-copy-icon${copied ? " is-active" : ""}`}
              title={copied ? t.room.inviteCopied : t.common.copy}
              aria-label={copied ? t.room.inviteCopied : t.common.copy}
              onClick={() => void copy()}
            >
              {copied ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="m3.2 8.3 3 3 6.6-6.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <rect x="5" y="4.8" width="7.8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M10.7 4.8V3.6c0-.8-.6-1.4-1.4-1.4H3.6c-.8 0-1.4.6-1.4 1.4v5.7c0 .8.6 1.4 1.4 1.4H5" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              )}
            </button>
          </div>
          <p className="room-invite-encrypt">
            {encrypt
              ? `${t.room.encryptedOn}${
                  hostFingerprint
                    ? ` · ${fillTemplate(t.room.fingerprint, {
                        fp: shortFingerprint(hostFingerprint),
                      })}`
                    : ""
                }`
              : t.room.encryptedOff}
          </p>
          {listening ? (
            <p className="settings-hint">
              {fillTemplate(t.room.inviteFirewall, { port: String(port ?? "") })}
            </p>
          ) : (
            <p className="room-leave-warn">{t.room.inviteNotListening}</p>
          )}
          {relayUrl ? (
            <p className="settings-hint">
              {fillTemplate(t.room.inviteRelay, { url: relayUrl })}
            </p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
