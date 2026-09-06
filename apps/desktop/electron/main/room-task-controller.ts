import { randomUUID } from "node:crypto";
import type { RoomDelegationPolicy, RoomRole, RoomTask } from "@claude-desktop/shared";

type Result = { ok: boolean; error?: string };
type Runtime = {
  task: RoomTask;
  signal: AbortController;
  started: boolean;
  depth: number;
  waitingWorkspace?: boolean;
  approval?: { promise: Promise<boolean>; resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout> };
};
export type RoomTaskRunContext = { signal: AbortSignal; requestWrite: (detail: string) => Promise<boolean> };
type Deps = {
  members: () => readonly { userId: string; role: RoomRole }[];
  policy: (userId: string) => RoomDelegationPolicy;
  execute: (task: RoomTask, context: RoomTaskRunContext) => Promise<void>;
  abort: (task: RoomTask) => void;
  changed: () => void;
  ready?: (seatId: string) => boolean;
  id?: () => string;
};
const TERMINAL = new Set<RoomTask["status"]>(["completed", "failed", "cancelled"]);

/** Room-local authority. UI and model input never choose a role or child-task owner. */
export class RoomTaskController {
  private entries = new Map<string, Runtime>();
  private activeSeats = new Set<string>();
  private disposed = false;
  constructor(private deps: Deps) {}

  get(id: string): RoomTask | undefined { return this.entries.get(id)?.task; }
  list(): RoomTask[] { return [...this.entries.values()].map(r => r.task); }
  isActive(id: string): boolean {
    const r = this.entries.get(id);
    return Boolean(r?.started && !r.signal.signal.aborted && !TERMINAL.has(r.task.status));
  }

  submit(input: { seatId: string; initiatorUserId: string; text: string; parentTaskId?: string; readOnly?: boolean }): Result & { task?: RoomTask } {
    if (this.disposed) return { ok: false, error: "群聊任务服务已关闭" };
    const parent = input.parentTaskId ? this.entries.get(input.parentTaskId) : undefined;
    if (input.parentTaskId && (!parent || !this.isActive(parent.task.id))) return { ok: false, error: "来源任务已结束或中断" };
    const initiator = parent?.task.initiatorUserId ?? input.initiatorUserId;
    if (!this.deps.members().some(m => m.userId === initiator)) return { ok: false, error: "任务发起人已不在群内" };
    const active = [...this.entries.values()].filter(r => !TERMINAL.has(r.task.status));
    if (active.length >= 32) return { ok: false, error: "待处理任务已达上限，请先处理已有任务" };
    if (parent && (parent.depth >= 4 || this.list().filter(t => t.rootTaskId === parent.task.rootTaskId).length >= 16)) {
      return { ok: false, error: "连续转交已达上限，需要人类重新发起任务" };
    }
    const id = this.deps.id?.() ?? randomUUID();
    const task: RoomTask = {
      id, rootTaskId: parent?.task.rootTaskId ?? id, seatId: input.seatId, initiatorUserId: initiator,
      ...(parent ? { parentTaskId: parent.task.id } : {}),
      text: input.text, readOnly: input.readOnly === true, createdAt: Date.now(), status: "queued",
    };
    const runtime: Runtime = { task, signal: new AbortController(), started: false, depth: (parent?.depth ?? -1) + 1 };
    this.entries.set(id, runtime);
    const policy = this.deps.policy(initiator);
    if (parent && (policy === "ask" || (policy === "read-only" && !task.readOnly) || (parent.task.readOnly && !task.readOnly))) {
      void this.ask(runtime, "delegation").then(allow => {
        if (runtime.signal.signal.aborted || runtime.started || this.disposed) return;
        if (!allow) this.cancel(runtime);
        else { task.status = "queued"; this.pump(); }
        this.deps.changed();
      });
    } else this.pump();
    this.prune();
    this.deps.changed();
    return { ok: true, task };
  }

  private ask(runtime: Runtime, kind: "delegation" | "write", detail?: string): Promise<boolean> {
    runtime.task.status = "awaiting-approval";
    runtime.task.approvalKind = kind;
    runtime.task.approvalDetail = detail;
    runtime.task.approvalRequestId = randomUUID();
    let resolve!: (allow: boolean) => void;
    const promise = new Promise<boolean>(done => { resolve = done; });
    const timer = setTimeout(() => {
      this.resolveApproval(runtime, false);
      this.deps.changed();
    }, 300_000);
    timer.unref?.();
    runtime.approval = { promise, resolve, timer };
    this.deps.changed();
    return promise;
  }

  private resolveApproval(runtime: Runtime, allow: boolean): void {
    const pending = runtime.approval;
    if (!pending) return;
    clearTimeout(pending.timer);
    // Settle this task-wide upgrade before releasing its slot. Promise waiters
    // only consume the decision; they must never mutate a newer approval.
    if (runtime.task.approvalKind === "write" && this.isActive(runtime.task.id)) {
      if (allow) runtime.task.readOnly = false;
      runtime.task.status = runtime.waitingWorkspace ? "awaiting-workspace" : "running";
    }
    runtime.approval = undefined;
    delete runtime.task.approvalRequestId;
    delete runtime.task.approvalKind;
    delete runtime.task.approvalDetail;
    pending.resolve(allow);
  }

  approve(id: string, requestId: string, actorUserId: string, allow: boolean): Result {
    const runtime = this.entries.get(id);
    if (!runtime?.approval || runtime.task.approvalRequestId !== requestId || runtime.signal.signal.aborted) return { ok: false, error: "审批已失效" };
    if (runtime.task.initiatorUserId !== actorUserId || !this.deps.members().some(m => m.userId === actorUserId)) return { ok: false, error: "只有原任务发起人可以审批" };
    const kind = runtime.task.approvalKind;
    this.resolveApproval(runtime, allow);
    if (kind === "delegation") {
      if (!allow) this.cancel(runtime);
      else { runtime.task.status = "queued"; this.pump(); }
    }
    this.deps.changed();
    return { ok: true };
  }

  async requestWrite(id: string, detail: string): Promise<boolean> {
    const runtime = this.entries.get(id);
    if (!runtime || !this.isActive(id)) return false;
    if (!runtime.task.readOnly) return true;
    const allow = await (runtime.approval?.promise ?? this.ask(runtime, "write", detail.slice(0, 500)));
    return allow && this.isActive(id);
  }

  stop(id: string, actorUserId: string): Result {
    const runtime = this.entries.get(id);
    const actor = this.deps.members().find(m => m.userId === actorUserId);
    if (!runtime || !actor) return { ok: false, error: "任务或成员不存在" };
    if (actor.role !== "host" && actor.role !== "admin" && runtime.task.initiatorUserId !== actorUserId) {
      return { ok: false, error: "普通成员只能停止自己发起的任务" };
    }
    this.cancelTree(id);
    this.deps.changed();
    return { ok: true };
  }

  private cancelTree(id: string): void {
    for (const child of this.entries.values()) if (child.task.parentTaskId === id) this.cancelTree(child.task.id);
    const runtime = this.entries.get(id);
    if (runtime) this.cancel(runtime);
  }

  private cancel(runtime: Runtime): void {
    if (TERMINAL.has(runtime.task.status) || runtime.signal.signal.aborted) return;
    runtime.signal.abort();
    this.resolveApproval(runtime, false);
    runtime.task.status = runtime.started ? "stopping" : "cancelled";
    if (runtime.started) this.deps.abort(runtime.task);
    else runtime.task.finishedAt = Date.now();
  }

  setWaitingWorkspace(id: string, waiting: boolean): void {
    const r = this.entries.get(id);
    if (!r || !this.isActive(id)) return;
    r.waitingWorkspace = waiting;
    if (!r.approval) r.task.status = waiting ? "awaiting-workspace" : "running";
    this.deps.changed();
  }

  pump(): void {
    if (this.disposed) return;
    for (const runtime of this.entries.values()) {
      const task = runtime.task;
      if (runtime.started || task.status !== "queued" || this.activeSeats.has(task.seatId) || this.deps.ready?.(task.seatId) === false) continue;
      this.activeSeats.add(task.seatId);
      runtime.started = true;
      task.status = "running";
      void this.execute(runtime);
    }
  }

  private async execute(runtime: Runtime): Promise<void> {
    try {
      await this.deps.execute(runtime.task, { signal: runtime.signal.signal, requestWrite: detail => this.requestWrite(runtime.task.id, detail) });
      runtime.task.status = runtime.signal.signal.aborted ? "cancelled" : "completed";
    } catch (error) {
      runtime.task.status = runtime.signal.signal.aborted && !(error instanceof Error && error.name === "RoomStopUnconfirmedError") ? "cancelled" : "failed";
      runtime.task.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.resolveApproval(runtime, false);
      runtime.task.finishedAt = Date.now();
      this.activeSeats.delete(runtime.task.seatId);
      this.deps.changed();
      this.pump();
    }
  }

  private prune(): void {
    if (this.entries.size <= 128) return;
    for (const [id, r] of this.entries) {
      if (this.entries.size <= 96) break;
      if (TERMINAL.has(r.task.status) && !this.list().some(t => t.rootTaskId === r.task.rootTaskId && !TERMINAL.has(t.status))) this.entries.delete(id);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const runtime of this.entries.values()) this.cancel(runtime);
  }
}
