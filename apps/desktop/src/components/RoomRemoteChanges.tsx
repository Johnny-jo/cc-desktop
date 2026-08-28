import React, { useState } from "react";
import type { FileChange, RoomSeat } from "@claude-desktop/shared";
import { DiffView } from "./DiffView";

function fileName(p: string): string {
  const n = p.replace(/\\/g, "/").split("/").pop();
  return n || p;
}

/**
 * 远端改动（二期）：其他成员机器上的 Agent 席位产生的结构化 diff，
 * 随房间快照下发，全员只读查看——回滚只能在执行节点本机进行。
 */
export function RoomRemoteChanges({
  remoteChanges,
  seats,
  memberName,
}: {
  remoteChanges: Record<string, FileChange[]>;
  seats: RoomSeat[];
  memberName: (seat: RoomSeat | undefined) => string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<{
    seatId: string;
    path: string;
  } | null>(null);

  const entries = Object.entries(remoteChanges).filter(
    ([, changes]) => changes.length,
  );
  const totalFiles = entries.reduce((n, [, c]) => n + c.length, 0);
  if (!entries.length) return null;

  const selChange = selected
    ? (remoteChanges[selected.seatId] ?? []).find(
        (c) => c.path === selected.path,
      ) ?? null
    : null;

  return (
    <div className="room-remote-changes">
      <button
        type="button"
        className="room-remote-changes-bar"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="change-file-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        远端改动（{totalFiles} 个文件，只读）
      </button>
      {open ? (
        <div className="room-remote-changes-body">
          <ul className="room-remote-changes-list">
            {entries.map(([seatId, changes]) => {
              const seat = seats.find((s) => s.id === seatId);
              return (
                <li key={seatId}>
                  <div className="room-remote-changes-seat">
                    {seat?.name ?? "席位"} · 在{memberName(seat)}的电脑上
                  </div>
                  <ul>
                    {changes.map((c) => (
                      <li key={c.path}>
                        <button
                          type="button"
                          className={`change-item${
                            selected?.seatId === seatId &&
                            selected?.path === c.path
                              ? " active"
                              : ""
                          }`}
                          title={c.path}
                          onClick={() => setSelected({ seatId, path: c.path })}
                        >
                          <span className={`change-status status-${c.status}`}>
                            {c.status}
                          </span>{" "}
                          {fileName(c.path)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          {selChange ? (
            <div className="room-remote-changes-diff">
              <DiffView change={selChange} />
            </div>
          ) : (
            <p className="muted room-remote-changes-hint">
              点左边文件看 diff；回滚请在对应成员的电脑上操作
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
