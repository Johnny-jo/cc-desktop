import React, { useEffect, useState } from "react";
import { useI18n } from "../i18n/useI18n";
import { shortFingerprint } from "../lib/room-invite-ui";
import {
  approveRoomDevice,
  denyRoomDevice,
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

  // Catch up on devices that queued before this view mounted; live updates
  // arrive as room:event { pending } via bindRoomEvents.
  useEffect(() => {
    if (!canHost) return;
    void listRoomPending(roomId).then((res) => {
      if (res.ok) setRoomPending(roomId, res.pending);
    });
  }, [canHost, roomId]);

  if (!canHost) return null;
  if (!devices.length && !fingerprintChanged) return null;

  const decide = async (fp: string, approve: boolean) => {
    setBusyFp(fp);
    if (approve) await approveRoomDevice(roomId, fp);
    else await denyRoomDevice(roomId, fp);
    setBusyFp(null);
    // 主进程随后会再推一次 pending 列表刷新这里
  };

  return (
    <div className="room-pending-banner">
      <div className="room-pending-title">{t.room.pendingTitle}</div>
      {fingerprintChanged ? (
        <p className="room-pending-warn">{t.room.fingerprintChanged}</p>
      ) : null}
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
  );
}
