import { describe, expect, it } from "vitest";
import { restoreTaskPlan, taskListsEqual } from "./task-plan";
import type { ProgressTask } from "./models";

describe("task plan closure", () => {
  const tasks: ProgressTask[] = [
    { id: "1", title: "Review", status: "completed" },
    { id: "1", scope: "worker", title: "Inspect", status: "pending" },
  ];
  it("ignores ordering but detects changes in task facts and scope", () => {
    expect(taskListsEqual(tasks, [...tasks].reverse().map(task => ({ ...task })))).toBe(true);
    for (const patch of [{ status: "in_progress" as const }, { title: "New title" }, { description: "Details" },
      { activeForm: "Working" }, { owner: "Worker" }, { scope: "other" }]) {
      expect(taskListsEqual(tasks, [{ ...tasks[0], ...patch }, tasks[1]])).toBe(false);
    }
    expect(taskListsEqual(tasks, tasks.slice(1))).toBe(false);
    expect(taskListsEqual(undefined, [])).toBe(true);
  });
  it("validates persisted closure without inventing closed plans for old archives", () => {
    for (const value of [undefined, null, {}, { closedAt: "10" }, { closedAt: NaN }, { closedAt: -1 }]) {
      expect(restoreTaskPlan(value)).toBeUndefined();
    }
    expect(restoreTaskPlan({ closedAt: 10 })).toEqual({ closedAt: 10, changedSinceClose: false });
    expect(restoreTaskPlan({ closedAt: 10, changedSinceClose: true })).toEqual({ closedAt: 10, changedSinceClose: true });
  });
});
