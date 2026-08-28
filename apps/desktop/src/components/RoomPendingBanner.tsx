import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/useI18n";
import { shortFingerprint } from "../lib/room-invite-ui";
import {
  approveRoomDevice,
  denyRoomDevice,
  getPendingEpoch,
  listRoomPending,
  setRoomPending,
  useRoomStore,
} from "../state/room-store";

/**
 * Host-side approval queue: devices that finished the password proof but are
 * waiting for the host (autoApprove off, or fingerprint changed). Guests just
 * see the join dialog's waiting copy / timeout error instead.
 */
export function RoomPendingBanner({
  roomId,
  canHost,
}: {
  roomId: string;
  canHost: boolean;
}) {
  const { t } = useI18n();
  const devices = useRoomStore((s) => s.pendingDevices);
  const fingerprintChanged = useRoomStore((s) => s.fingerprintChanged);
  const [busyFp, setBusyFp] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Catch up on devices that queued before this view mounted; live updates
  // arrive as room:event { pending } via bindRoomEvents. Skip the result if
  // a live event already wrote the queue (stale empty snapshot would hide a
  // real request, stale non-empty would resurrect a disconnected guest).
  useEffect(() => {
    if (!canHost) return;
    let cancelled = false;
    const epoch = getPendingEpoch();
    void listRoomPending(roomId).then((res) => {
      if (cancelled || !res.ok) return;
      if (getPendingEpoch() !== epoch) return;
      setRoomPending(roomId, res.pending);
    });
    return () => {
      cancelled = true;
    };
  }, [canHost, roomId]);

  if (!canHost) return null;
  if (!devices.length && !fingerprintChanged && !actionError) return null;

  const decide = async (fp: string, approve: boolean) => {
    setBusyFp(fp);
    setActionError(null);
    const res = approve
      ? await approveRoomDevice(roomId, fp)
      : await denyRoomDevice(roomId, fp);
    setBusyFp(null);
    if (!res.ok) {
      setActionError(res.error ?? (approve ? "批准失败" : "拒绝失败"));
    }
    // 主进程随后会再推一次 pending 列表刷新这里
  };

  return createPortal(
    <div className="room-modal-overlay" role="presentation">
      <div
        className="room-modal"
        role="dialog"
        aria-label={t.room.pendingTitle}
      >
        <header className="room-modal-head">
          <h3>{t.room.pendingTitle}</h3>
        </header>
        <div className="room-modal-body">
          {fingerprintChanged ? (
            <p className="room-pending-warn">{t.room.fingerprintChanged}</p>
          ) : null}
          {actionError ? <p className="room-pending-warn">{actionError}</p> : null}
          {devices.map((d) => (
            <div key={d.fp} className="room-pending-row">
              <span className="room-pending-name">{d.name}</span>
              <span className="room-pending-fp">{shortFingerprint(d.fp)}</span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busyFp === d.fp}
                onClick={() => void decide(d.fp, true)}
              >
                {t.room.approve}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busyFp === d.fp}
                onClick={() => void decide(d.fp, false)}
              >
                {t.room.deny}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
