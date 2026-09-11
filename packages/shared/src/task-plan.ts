import type { ProgressTask, TaskPlan } from "./models";

export function restoreTaskPlan(value: unknown): TaskPlan | undefined {
  if (!value || typeof value !== "object") return;
  const plan = value as Partial<TaskPlan>;
  if (typeof plan.closedAt !== "number" || !Number.isFinite(plan.closedAt) || plan.closedAt < 0) return;
  return { closedAt: plan.closedAt, changedSinceClose: plan.changedSinceClose === true };
}

/** Compare task facts, ignoring row order and object identity. */
export function taskListsEqual(a: ProgressTask[] = [], b: ProgressTask[] = []): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const facts = (tasks: ProgressTask[]) => tasks.map(task => JSON.stringify([
    task.scope ?? null, task.id, task.title, task.status, task.description ?? null,
    task.activeForm ?? null, task.owner ?? null,
  ])).sort();
  const left = facts(a), right = facts(b);
  return left.every((value, index) => value === right[index]);
}
