import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ProgressAgent, SessionProgress, TaskPlan } from "@claude-desktop/shared";
import { useI18n } from "../i18n/useI18n";
import "./ChatTaskDock.css";

type Tab = "tasks" | "agents";

function DockIcon({ agents = false }: { agents?: boolean }) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden>
      {agents ? <><circle cx="4" cy="4" r="2" /><circle cx="14" cy="7" r="2" /><circle cx="4" cy="14" r="2" /><path d="M4 6v6M6 14h2a6 6 0 0 0 6-5" /></>
        : <><rect x="3" y="2" width="12" height="14" rx="2" /><path d="m5.5 6 1 1 2-2M10 6h2.5M5.5 11h2M10 11h2.5" /></>}
    </svg>
  );
}

function duration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return value < 60 ? `${value}s` : `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, "0")}s`;
}

function AgentPreview({ text, zh }: { text: string; zh: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const preview = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const node = preview.current;
    if (!node || expanded) return;
    const measure = () => setCanExpand(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);
  return <>
    <p ref={preview} className={`chat-task-dock-preview${expanded ? " is-expanded" : ""}`}>{text}</p>
    {canExpand ? <button className="chat-task-dock-more" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{zh ? expanded ? "收起结果" : "展开结果" : expanded ? "Show less" : "Show more"}</button> : null}
  </>;
}

export function ChatTaskDock({ sessionId, progress, taskPlan, onSetPlanClosed }: {
  sessionId: string; progress?: SessionProgress; taskPlan?: TaskPlan;
  onSetPlanClosed?: (closed: boolean) => Promise<void>;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const taskButton = useRef<HTMLButtonElement>(null);
  const agentButton = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ sessionId: string; tab: Tab | null }>({ sessionId, tab: null });
  // Reset before paint; returning to an earlier session must not reopen its popup.
  if (selection.sessionId !== sessionId) setSelection({ sessionId, tab: null });
  const tasks = progress?.tasks ?? [];
  const agents = progress?.agents ?? [];
  const selected = selection.sessionId === sessionId ? selection.tab : null;
  const hasTasks = Boolean(tasks.length || taskPlan);
  const open = selected === "tasks" && hasTasks || selected === "agents" && agents.length ? selected : null;
  const completed = tasks.filter(task => task.status === "completed").length;
  const planLabel = taskPlan ? (zh ? "已关闭" : "Closed")
    : completed === tasks.length ? (zh ? "全部完成" : "All completed")
    : tasks.some(task => task.status === "in_progress") ? (zh ? "进行中" : "In progress")
    : completed ? (zh ? "待继续" : "To continue") : (zh ? "待开始" : "Pending");
  const taskSummary = tasks.length ? `${completed}/${tasks.length} · ${planLabel}` : (zh ? "已关闭 · 无任务" : "Closed · No tasks");
  const changedLabel = zh ? "关闭后有更新" : "Updated since closure";
  const counts = (status: ProgressAgent["status"]) => agents.filter(agent => agent.status === status).length;
  const running = counts("running");
  const agentDone = counts("completed");
  const failures = counts("failed");
  const ended = agentDone + failures + counts("stopped");
  const agentExtras = [
    counts("stopped") ? `${counts("stopped")} ${zh ? "已停止" : "stopped"}` : "",
    counts("paused") ? `${counts("paused")} ${zh ? "已暂停" : "paused"}` : "",
    counts("unknown") ? `${counts("unknown")} ${zh ? "状态未知" : "unknown"}` : "",
  ].filter(Boolean).join(" · ");
  const taskLabels = { pending: zh ? "待开始" : "Pending", in_progress: zh ? "进行中" : "In progress", completed: zh ? "已完成" : "Completed" };
  const agentLabels = { running: zh ? "运行中" : "Running", completed: zh ? "已完成" : "Completed", failed: zh ? "失败" : "Failed", stopped: zh ? "已停止" : "Stopped", paused: zh ? "已暂停" : "Paused", unknown: zh ? "未知" : "Unknown" };
  const agentSummary = (Object.keys(agentLabels) as ProgressAgent["status"][])
    .filter(status => counts(status) > 0).map(status => `${counts(status)} ${agentLabels[status].toLowerCase()}`).join(" · ");

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const panel = node.closest(".chat-panel");
    const measure = () => {
      const bounds = node.getBoundingClientRect();
      const popup = node.querySelector<HTMLElement>(".chat-task-dock-panel");
      const gap = popup ? Math.max(0, parseFloat(getComputedStyle(popup).bottom) - bounds.height) : 8;
      const clipTop = Math.max(0, panel?.getBoundingClientRect().top ?? 0);
      node.style.setProperty("--dock-room", `${Math.max(0, bounds.top - clipTop - gap - 4)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (panel) observer.observe(panel);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [sessionId, Boolean(hasTasks || agents.length), open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setSelection({ sessionId, tab: null });
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
      (open === "tasks" ? taskButton : agentButton).current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [sessionId, open]);

  if (!hasTasks && !agents.length) return null;
  const toggle = (tab: Tab) => setSelection({ sessionId, tab: open === tab ? null : tab });
  const changePlan = async () => {
    if (saving || !onSetPlanClosed) return;
    setSaving(true);
    setSaveError(null);
    try { await onSetPlanClosed(!taskPlan); }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return (
    <div className="chat-task-dock" ref={root}>
      <div className="chat-task-dock-triggers">
        {hasTasks ? <button ref={taskButton} id={`${id}-tasks`} className="chat-task-dock-trigger" type="button" title={zh ? "查看任务清单" : "View task list"} aria-label={`TaskList ${taskSummary}${taskPlan?.changedSinceClose ? ` · ${changedLabel}` : ""}`} aria-expanded={open === "tasks"} aria-controls={`${id}-tasks-panel`} onClick={() => toggle("tasks")}>
          <DockIcon /><span>TaskList</span><span className="chat-task-dock-count">{taskSummary}</span>
          {taskPlan?.changedSinceClose ? <span className="chat-task-dock-count">{changedLabel}</span> : null}
        </button> : null}
        {agents.length ? <button ref={agentButton} id={`${id}-agents`} className="chat-task-dock-trigger" type="button" title={`SubAgent · ${agentSummary}`} aria-label={`SubAgent · ${agentSummary}`} aria-expanded={open === "agents"} aria-controls={`${id}-agents-panel`} onClick={() => toggle("agents")}>
          <DockIcon agents /><span>SubAgent</span><span className="chat-task-dock-count">{running} {zh ? "运行中" : "running"} · {ended}/{agents.length} {zh ? "已结束" : "ended"}</span>
          {failures ? <span className="chat-task-dock-failure">{failures} {zh ? "失败" : "failed"}</span> : null}
          {agentExtras ? <span className="chat-task-dock-count">{agentExtras}</span> : null}
        </button> : null}
      </div>
      {open ? <section id={`${id}-${open}-panel`} className="chat-task-dock-panel" role="region" aria-labelledby={`${id}-${open}`} tabIndex={0}>
        <header><strong>{open === "tasks" ? zh ? "任务清单" : "Task list" : "SubAgent"}</strong><span>{open === "tasks" ? taskSummary : agentSummary}</span></header>
        {open === "tasks" ? <div className="chat-task-dock-plan">
          {taskPlan && tasks.length > completed ? <p>{zh ? `${tasks.length - completed} 项未完成` : `${tasks.length - completed} unfinished tasks`}</p> : null}
          {taskPlan?.changedSinceClose ? <p>{changedLabel}</p> : null}
          {onSetPlanClosed ? <>
            <button type="button" disabled={saving} onClick={() => void changePlan()}>{saving ? (zh ? "保存中…" : "Saving…") : taskPlan ? (zh ? "重新打开" : "Reopen plan") : (zh ? "关闭计划" : "Close plan")}</button>
            <p>{zh ? "关闭仅标记计划结束，执行中的任务仍会继续。" : "Closing marks the plan as ended. Running tasks will continue."}</p>
          </> : null}
          {saveError ? <p role="alert">{zh ? "保存失败：" : "Could not save: "}{saveError}</p> : null}
        </div> : null}
        <ul>
          {open === "tasks" ? tasks.map(task => <li key={JSON.stringify([task.scope ?? null, task.id])} className={`chat-task-dock-row is-${task.status}`}>
            <div className="chat-task-dock-row-heading"><span className="chat-task-dock-status-dot" aria-hidden /><strong>{task.title}</strong><span className="chat-task-dock-state">{taskLabels[task.status]}</span></div>
            {task.activeForm && task.status === "in_progress" ? <p>{task.activeForm}</p> : null}
            {task.description ? <p className="chat-task-dock-preview" title={task.description}>{task.description}</p> : null}
            {task.owner || task.scope ? <p className="chat-task-dock-meta">{[task.owner, task.scope].filter(Boolean).join(" · ")}</p> : null}
          </li>) : agents.map(agent => <li key={agent.id} data-agent-id={agent.id} className={`chat-task-dock-row is-${agent.status}`}>
            <div className="chat-task-dock-row-heading"><span className="chat-task-dock-status-dot" aria-hidden /><strong>{agent.title}</strong><span className="chat-task-dock-state">{agentLabels[agent.status]}</span></div>
            {agent.background || agent.elapsedSeconds != null ? <p className="chat-task-dock-meta">{[agent.background ? zh ? "后台" : "Background" : null, agent.elapsedSeconds != null ? duration(agent.elapsedSeconds) : null].filter(Boolean).join(" · ")}</p> : null}
            {agent.summary ? <AgentPreview text={agent.summary} zh={zh} /> : null}
          </li>)}
        </ul>
      </section> : null}
    </div>
  );
}
