import React from "react";
import { respondRoomPermAsk, useAppStore } from "../state/store";

/**
 * 房间远程执行的本地审批弹窗（遮罩式）：别人在你的本机项目上发起任务时，
 * 由你决定允许还是拒绝。任一窗口作答后，其余窗口的同名弹窗自动关闭。
 */
export function RoomPermAskModal() {
  const ask = useAppStore((s) => s.roomPermAsk);

  if (!ask) return null;

  const respond = (allow: boolean) => {
    void respondRoomPermAsk(ask.requestId, allow);
  };

  return (
    <div className="modal-overlay">
      <div className="modal permission-modal">
        <div className="modal-header">
          <span className="modal-title">远程执行审批</span>
          <span className="tool-name">{ask.roomName}</span>
        </div>

        <div className="modal-body">
          <p className="permission-summary">
            {ask.requesterName} 想在房间「{ask.roomName}」的席位「
            {ask.seatName}」上，对你的项目 {ask.projectPath} 执行任务。
          </p>
          <details className="permission-details" open>
            <summary>任务内容</summary>
            <pre className="permission-json">{ask.text}</pre>
          </details>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={() => respond(true)}
          >
            允许
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => respond(false)}
          >
            拒绝
          </button>
        </div>
      </div>
    </div>
  );
}
