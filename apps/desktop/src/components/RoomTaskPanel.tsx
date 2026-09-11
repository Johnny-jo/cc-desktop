import React from "react";
import type { RoomDelegationPolicy, RoomSnapshot, RoomTask, RoomTaskStatus } from "@claude-desktop/shared";
import type { controlRoomTask } from "../state/room-store";
import { ThemedSelect } from "./Select";
import "./RoomTaskPanel.css";

type Control = Parameters<typeof controlRoomTask>[0];
type TaskRoom = Pick<RoomSnapshot, "roomId" | "status" | "localUserId" | "members" | "seats" | "tasks">;
type Props = {
  room: TaskRoom;
  offline?: boolean;
  pendingKeys?: readonly string[];
  onControl: (args: Control) => void;
};
const labels: Record<RoomTaskStatus, string> = {
  "awaiting-approval": "等待确认", "awaiting-workspace": "等待项目授权",
  queued: "排队中", running: "执行中", stopping: "正在停止", cancelled: "已取消", completed: "已完成", failed: "失败",
};
const terminal = new Set<RoomTaskStatus>(["cancelled", "completed", "failed"]);
const policyLabels: Record<RoomDelegationPolicy, string> = {
  ask: "逐次确认", "read-only": "只读自动，修改需批", auto: "授权范围内自动",
};

function awaitsMyApproval(room: TaskRoom, task: RoomTask) {
  return Boolean(room.members.some(member => member.userId === room.localUserId && member.userId === task.initiatorUserId)
    && task.status === "awaiting-approval" && task.approvalRequestId && task.approvalKind);
}

export function summarizeRoomTasks(room: TaskRoom) {
  const tasks = room.tasks ?? [];
  return {
    active: tasks.filter(task => !terminal.has(task.status)).length,
    running: tasks.filter(task => task.status === "running").length,
    queued: tasks.filter(task => task.status === "queued").length,
    approvals: tasks.filter(task => awaitsMyApproval(room, task)).length,
  };
}

export function RoomTaskRow({ room, task, offline, pendingKeys = [], onControl }: Props & { task: RoomTask }) {
  const member = room.members.find(m => m.userId === room.localUserId);
  const own = Boolean(member && member.userId === task.initiatorUserId);
  const active = !terminal.has(task.status) && task.status !== "stopping";
  const canStop = active && member && (own || member.role === "host" || member.role === "admin");
  const canApprove = awaitsMyApproval(room, task);
  const disabled = Boolean(offline || room.status !== "open" || pendingKeys.includes(task.id));
  return (
    <li className={`room-task-row${canApprove ? " needs-approval" : ""}`} data-task-id={task.id} data-parent-task-id={task.parentTaskId}>
      <div className="room-task-heading">
        <strong>{room.seats.find(s => s.id === task.seatId)?.name ?? task.seatId}</strong>
        <span className={`room-task-status is-${task.status}`} role="status">{labels[task.status]}</span>
      </div>
      <div className="room-task-meta">发起人：{room.members.find(m => m.userId === task.initiatorUserId)?.name ?? task.initiatorUserId} · {task.readOnly ? "只读" : "可修改"}</div>
      {task.parentTaskId ? <div className="room-task-meta" title={`父任务：${task.parentTaskId} · 根任务：${task.rootTaskId}`}>转交任务</div> : null}
      <p className="room-task-text" title={task.text}>{task.text}</p>
      {task.status === "awaiting-approval" ? (
        <div className="room-task-approval">
          <span>{task.approvalKind === "write" ? "申请写权限" : "转交审批"}</span>
          {task.approvalDetail ? <p>{task.approvalDetail}</p> : null}
          {!own ? <span>等待原发起人确认</span> : null}
        </div>
      ) : null}
      {task.error ? <p className="room-task-error">{task.error}</p> : null}
      {canApprove || canStop ? <div className="room-task-actions">
        {canApprove ? <>
          <button type="button" className="room-task-approve" disabled={disabled} onClick={() => onControl({ roomId: room.roomId, action: "approve", taskId: task.id, requestId: task.approvalRequestId, allow: true })}>批准</button>
          <button type="button" disabled={disabled} onClick={() => onControl({ roomId: room.roomId, action: "approve", taskId: task.id, requestId: task.approvalRequestId, allow: false })}>拒绝</button>
        </> : null}
        {canStop ? <button type="button" disabled={disabled} onClick={() => onControl({ roomId: room.roomId, action: "stop", taskId: task.id })}>停止</button> : null}
      </div> : null}
    </li>
  );
}

export function RoomTaskPanel(props: Props) {
  const { room, offline, pendingKeys = [], onControl } = props;
  const member = room.members.find(m => m.userId === room.localUserId);
  const tasks = room.tasks ?? [];
  const approvals = tasks.filter(task => awaitsMyApproval(room, task)).sort((a, b) => a.createdAt - b.createdAt);
  const current = tasks.filter(task => !terminal.has(task.status) && !awaitsMyApproval(room, task)).sort((a, b) => a.createdAt - b.createdAt);
  const recent = tasks.filter(task => terminal.has(task.status)).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)).slice(0, 10);
  const policy = member?.delegationPolicy ?? "ask";
  const summary = summarizeRoomTasks(room);
  return (
    <section className="room-task-panel" aria-label="群聊任务">
      {summary.running || summary.queued ? <div className="room-task-summary" aria-label="任务概况">
        {summary.running ? <span className="is-running">{`${summary.running} 项执行中`}</span> : null}
        {summary.queued ? <span>{`${summary.queued} 项排队`}</span> : null}
      </div> : null}
      {approvals.length ? <section className="room-task-approvals" aria-label="待我确认">
        <h3>待我确认 <span aria-live="polite">{approvals.length}</span></h3>
        <ul>{approvals.map(task => <RoomTaskRow key={task.id} {...props} task={task} />)}</ul>
      </section> : null}
      <h3>当前任务 {current.length ? <span>{current.length}</span> : null}</h3>
      {current.length ? <ul>{current.map(task => <RoomTaskRow key={task.id} {...props} task={task} />)}</ul> : (
        <div className="room-task-empty">
          <p>{approvals.length ? "暂无其他进行中的任务" : "暂无进行中的任务"}</p>
          {!approvals.length ? <p>从 @ 候选中选择 Agent，发送消息即可发起任务。</p> : null}
        </div>
      )}
      {recent.length ? <details className="room-task-recent">
        <summary>近期任务 · {recent.length}</summary>
        <ul>{recent.map(task => <RoomTaskRow key={task.id} {...props} task={task} />)}</ul>
      </details> : null}
      <details className="room-task-policy-wrap">
        <summary><span>我的转交策略</span><span className="room-task-policy-current">{policyLabels[policy]}</span></summary>
        <div className="room-task-policy">
          <ThemedSelect ariaLabel="我的转交策略" variant="field" value={policy}
            disabled={!member || offline || room.status !== "open" || pendingKeys.includes("policy")}
            options={Object.entries(policyLabels).map(([value, label]) => ({ value, label }))}
            onChange={value => onControl({ roomId: room.roomId, action: "policy", policy: value as RoomDelegationPolicy })} />
        </div>
        <p className="room-task-policy-hint">仅用于我发起任务的后续转交</p>
      </details>
    </section>
  );
}
