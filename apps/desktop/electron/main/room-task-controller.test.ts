import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomDelegationPolicy, RoomRole } from "@claude-desktop/shared";
import { RoomTaskController } from "./room-task-controller";

const controllers = new Set<RoomTaskController>();
afterEach(() => {
  for (const control of controllers) control.dispose();
  controllers.clear();
  vi.useRealTimers();
});

function fixture() {
  let serial = 0;
  const finish = new Map<string, () => void>();
  const fail = new Map<string, (error: Error) => void>();
  const execute = vi.fn((task: { id: string }) => new Promise<void>((resolve, reject) => {
    finish.set(task.id, resolve);
    fail.set(task.id, reject);
  }));
  const members: { userId: string; role: RoomRole }[] = [{ userId: "owner", role: "host" }, { userId: "admin", role: "admin" }, { userId: "a", role: "member" }, { userId: "b", role: "member" }];
  const policy = { value: "ask" as RoomDelegationPolicy };
  const policies = new Map<string, RoomDelegationPolicy>();
  const abort = vi.fn();
  const control = new RoomTaskController({ members: () => members, policy: userId => policies.get(userId) ?? policy.value, execute, abort, changed: () => {}, id: () => `t${++serial}` });
  controllers.add(control);
  const submit = (seatId = "dev", initiatorUserId = "a", readOnly = false) => control.submit({ seatId, initiatorUserId, text: "work", readOnly }).task!;
  return { control, execute, abort, finish, fail, submit, policy, policies, members };
}

describe("room task ownership and scheduling", () => {
  it("serializes a seat but lets different Agents run independently", async () => {
    const f = fixture();
    const a = f.submit(); const b = f.submit(); const c = f.submit("review");
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(b.status).toBe("queued");
    f.finish.get(a.id)!();
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(3));
    expect(c.status).toBe("running");
    f.control.dispose();
  });
  it("rejects another member and permits the initiator, admin and host", () => {
    const f = fixture(); const t = f.submit();
    expect(f.control.stop(t.id, "b").ok).toBe(false);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.control.stop(t.id, "a").ok).toBe(true);
    expect(t.status).toBe("stopping");
    const u = f.submit("other", "b");
    expect(f.control.stop(u.id, "admin").ok).toBe(true);
    const v = f.submit("third", "b");
    expect(f.control.stop(v.id, "owner").ok).toBe(true);
    f.control.dispose();
  });
  it("keeps stopping until execution settles and does not run a cancelled queued task", async () => {
    const f = fixture(); const t = f.submit(); const next = f.submit();
    f.control.stop(next.id, "a");
    expect(next.status).toBe("cancelled");
    f.control.stop(t.id, "admin");
    expect(t.status).toBe("stopping");
    f.finish.get(t.id)!();
    await vi.waitFor(() => expect(t.status).toBe("cancelled"));
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.control.dispose();
  });
  it("inherits original initiator and requires their approval for every delegation", async () => {
    const f = fixture(); const root = f.submit();
    const child = f.control.submit({ seatId: "review", initiatorUserId: "b", parentTaskId: root.id, text: "review", readOnly: true }).task!;
    expect(child.initiatorUserId).toBe("a");
    expect(child.status).toBe("awaiting-approval");
    expect(f.control.approve(child.id, child.approvalRequestId!, "admin", true).ok).toBe(false);
    expect(f.control.approve(child.id, child.approvalRequestId!, "a", true).ok).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(child.status).toBe("running");
    f.control.dispose();
  });
  it("applies the read-only and auto delegation tiers without weakening a read-only parent", () => {
    const f = fixture(); const root = f.submit();
    f.policy.value = "read-only";
    const read = f.control.submit({ seatId: "r", initiatorUserId: "a", parentTaskId: root.id, text: "read", readOnly: true }).task!;
    const write = f.control.submit({ seatId: "w", initiatorUserId: "a", parentTaskId: root.id, text: "write" }).task!;
    expect(read.status).toBe("running"); expect(read.readOnly).toBe(true);
    expect(write.status).toBe("awaiting-approval");
    f.policy.value = "auto";
    const auto = f.control.submit({ seatId: "auto", initiatorUserId: "a", parentTaskId: root.id, text: "work" }).task!;
    expect(auto.status).toBe("running");
    const escalation = f.control.submit({ seatId: "escape", initiatorUserId: "a", parentTaskId: read.id, text: "write" }).task!;
    expect(escalation.status).toBe("awaiting-approval");
    f.control.dispose();
  });
  it("cancels descendants and rejects late approvals and stale Agent calls", () => {
    const f = fixture(); const root = f.submit();
    const child = f.control.submit({ seatId: "review", initiatorUserId: "a", parentTaskId: root.id, text: "review" }).task!;
    const request = child.approvalRequestId!;
    f.control.stop(root.id, "a");
    expect(child.status).toBe("cancelled");
    expect(f.control.approve(child.id, request, "a", true).ok).toBe(false);
    expect(f.control.submit({ seatId: "r", initiatorUserId: "a", parentTaskId: root.id, text: "late" }).ok).toBe(false);
    f.control.dispose();
  });
  it("pauses write escalation until the original initiator approves", async () => {
    const f = fixture(); const t = f.submit("dev", "a", true);
    const permission = f.control.requestWrite(t.id, "Edit file");
    expect(t.status).toBe("awaiting-approval");
    const request = t.approvalRequestId!;
    expect(f.control.approve(t.id, request, "a", true).ok).toBe(true);
    expect(await permission).toBe(true);
    expect(t.readOnly).toBe(false);
    expect(t.status).toBe("running");
    f.control.dispose();
  });
});

describe("room task write approval concurrency", () => {
  it.each(["allow", "deny", "cancel"] as const)("shares a pending write upgrade until %s", async decision => {
    vi.useFakeTimers();
    const f = fixture(); const t = f.submit("dev", "a", true);
    const settled: boolean[] = [];
    const first = f.control.requestWrite(t.id, "Edit first file");
    const request = t.approvalRequestId!;
    const second = f.control.requestWrite(t.id, "Edit second file");
    void first.then(value => settled.push(value));
    void second.then(value => settled.push(value));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toEqual([]);
    expect(t.approvalRequestId).toBe(request);
    expect(t.approvalDetail).toBe("Edit first file");
    expect(t.status).toBe("awaiting-approval");
    expect(t.readOnly).toBe(true);

    if (decision === "cancel") expect(f.control.stop(t.id, "a").ok).toBe(true);
    else expect(f.control.approve(t.id, request, "a", decision === "allow").ok).toBe(true);
    const allowed = decision === "allow";
    expect(await Promise.all([first, second])).toEqual([allowed, allowed]);
    expect(t.readOnly).toBe(!allowed);
    expect(t.status).toBe(decision === "cancel" ? "stopping" : "running");
    expect(t.approvalRequestId).toBeUndefined();
    expect(f.control.approve(t.id, request, "a", true).ok).toBe(false);
  });

  it.each(["deny", "timeout"] as const)("preserves a newer write approval when older waiters resume after %s", async decision => {
    vi.useFakeTimers();
    const f = fixture(); const t = f.submit("dev", "a", true);
    const old = [f.control.requestWrite(t.id, "Old edit"), f.control.requestWrite(t.id, "Old concurrent edit")];
    const oldRequest = t.approvalRequestId!;
    if (decision === "deny") f.control.approve(t.id, oldRequest, "a", false);
    else vi.advanceTimersByTime(300_000);

    const next = [f.control.requestWrite(t.id, "New edit"), f.control.requestWrite(t.id, "New concurrent edit")];
    const nextRequest = t.approvalRequestId!;
    const nextSettled = vi.fn();
    for (const permission of next) void permission.then(nextSettled);
    expect(nextRequest).not.toBe(oldRequest);
    expect(await Promise.all(old)).toEqual([false, false]);
    expect(nextSettled).not.toHaveBeenCalled();
    expect(t.status).toBe("awaiting-approval");
    expect(t.readOnly).toBe(true);
    expect(t.approvalRequestId).toBe(nextRequest);
    expect(t.approvalDetail).toBe("New edit");
    expect(vi.getTimerCount()).toBe(1);
    expect(f.control.approve(t.id, oldRequest, "a", true).ok).toBe(false);
    expect(f.control.approve(t.id, nextRequest, "a", true).ok).toBe(true);
    expect(await Promise.all(next)).toEqual([true, true]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not open another approval after an allowed upgrade while waiters are resuming", async () => {
    const f = fixture(); const t = f.submit("dev", "a", true);
    const first = f.control.requestWrite(t.id, "First edit");
    const second = f.control.requestWrite(t.id, "Second edit");
    expect(f.control.approve(t.id, t.approvalRequestId!, "a", true).ok).toBe(true);
    const third = f.control.requestWrite(t.id, "Third edit");

    expect(t.approvalRequestId).toBeUndefined();
    expect(t.readOnly).toBe(false);
    expect(t.status).toBe("running");
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
  });

  it.each([
    [true, "allow"], [false, "allow"],
    [true, "deny"], [false, "deny"],
    [true, "timeout"], [false, "timeout"],
  ] as const)("keeps approval visible for workspace=%s until %s, then restores the latest workspace state", async (waiting, decision) => {
    vi.useFakeTimers();
    const f = fixture(); const t = f.submit("dev", "a", true);
    f.control.setWaitingWorkspace(t.id, !waiting);
    const permissions = [f.control.requestWrite(t.id, "Edit"), f.control.requestWrite(t.id, "Concurrent edit")];
    const request = t.approvalRequestId!;

    f.control.setWaitingWorkspace(t.id, waiting);
    expect(t.status).toBe("awaiting-approval");
    expect(t.approvalRequestId).toBe(request);
    expect(t.readOnly).toBe(true);
    if (decision === "timeout") await vi.advanceTimersByTimeAsync(300_000);
    else expect(f.control.approve(t.id, request, "a", decision === "allow").ok).toBe(true);

    const allowed = decision === "allow";
    expect(await Promise.all(permissions)).toEqual([allowed, allowed]);
    expect(t.status).toBe(waiting ? "awaiting-workspace" : "running");
    expect(t.readOnly).toBe(!allowed);
    expect(t.approvalRequestId).toBeUndefined();
  });

  it.each(["stop", "dispose", "complete"] as const)("settles all pending write waiters on %s and rejects late permission", async action => {
    vi.useFakeTimers();
    const f = fixture(); const t = f.submit("dev", "a", true);
    const permissions = [f.control.requestWrite(t.id, "Edit"), f.control.requestWrite(t.id, "Concurrent edit")];
    const request = t.approvalRequestId!;
    if (action === "stop") f.control.stop(t.id, "a");
    else if (action === "dispose") f.control.dispose();
    else f.finish.get(t.id)!();

    expect(await Promise.all(permissions)).toEqual([false, false]);
    expect(t.readOnly).toBe(true);
    expect(t.status).toBe(action === "complete" ? "completed" : "stopping");
    expect(f.control.approve(t.id, request, "a", true).ok).toBe(false);
    expect(await f.control.requestWrite(t.id, "Late edit")).toBe(false);
    f.control.setWaitingWorkspace(t.id, false);
    expect(t.status).toBe(action === "complete" ? "completed" : "stopping");
    if (action !== "complete") {
      f.finish.get(t.id)!();
      await Promise.resolve();
      expect(t.status).toBe("cancelled");
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns false to concurrent waiters if stopped after approval but before they resume", async () => {
    const f = fixture(); const t = f.submit("dev", "a", true);
    const permissions = [f.control.requestWrite(t.id, "Edit"), f.control.requestWrite(t.id, "Concurrent edit")];
    const request = t.approvalRequestId!;
    expect(f.control.approve(t.id, request, "a", true).ok).toBe(true);
    expect(f.control.stop(t.id, "a").ok).toBe(true);
    expect(await Promise.all(permissions)).toEqual([false, false]);
    expect(t.status).toBe("stopping");
    expect(f.control.approve(t.id, request, "a", true).ok).toBe(false);
    f.finish.get(t.id)!();
    await Promise.resolve();
    expect(t.status).toBe("cancelled");
  });

  it("keeps concurrent writes pending until the timeout boundary and then denies all of them", async () => {
    vi.useFakeTimers();
    const f = fixture(); const t = f.submit("dev", "a", true);
    const permissions = [f.control.requestWrite(t.id, "Edit"), f.control.requestWrite(t.id, "Concurrent edit")];
    const request = t.approvalRequestId!;
    const settled = vi.fn();
    for (const permission of permissions) void permission.then(settled);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(settled).not.toHaveBeenCalled();
    expect(t.status).toBe("awaiting-approval");
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(permissions)).toEqual([false, false]);
    expect(t.readOnly).toBe(true);
    expect(t.status).toBe("running");
    expect(f.control.approve(t.id, request, "a", true).ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["ask", "read-only", "auto"] as const)("requires the original initiator to release read-only under the %s delegation policy", async policy => {
    const f = fixture(); f.policy.value = policy;
    const t = f.submit("dev", "a", true);
    const permissions = [f.control.requestWrite(t.id, "Edit"), f.control.requestWrite(t.id, "Concurrent edit")];
    const request = t.approvalRequestId!;
    expect(t.status).toBe("awaiting-approval");
    for (const actor of ["owner", "admin", "b"]) expect(f.control.approve(t.id, request, actor, true).ok).toBe(false);
    expect(t.readOnly).toBe(true);
    expect(f.control.approve(t.id, request, "a", true).ok).toBe(true);
    expect(await Promise.all(permissions)).toEqual([true, true]);
    expect(await f.control.requestWrite(t.id, "Later edit in the same task")).toBe(true);
    expect(t.approvalRequestId).toBeUndefined();
  });
});

describe("room task authority and lifecycle boundaries", () => {
  it("checks current roles and membership at stop time", () => {
    const f = fixture(); const t = f.submit();
    f.members.find(member => member.userId === "admin")!.role = "member";
    expect(f.control.stop(t.id, "admin").ok).toBe(false);
    expect(t.status).toBe("running");
    f.members.find(member => member.userId === "b")!.role = "admin";
    expect(f.control.stop(t.id, "b").ok).toBe(true);
    const other = f.submit("other");
    f.members.splice(f.members.findIndex(member => member.userId === "owner"), 1);
    expect(f.control.stop(other.id, "owner").ok).toBe(false);
    expect(other.status).toBe("running");
  });

  it("invalidates approval authority when the original initiator leaves", async () => {
    const f = fixture(); const t = f.submit("dev", "a", true);
    const permissions = [f.control.requestWrite(t.id, "Edit"), f.control.requestWrite(t.id, "Concurrent edit")];
    const request = t.approvalRequestId!;
    f.members.splice(f.members.findIndex(member => member.userId === "a"), 1);
    expect(f.control.approve(t.id, request, "a", true).ok).toBe(false);
    expect(f.control.approve(t.id, request, "admin", true).ok).toBe(false);
    expect(f.control.submit({ seatId: "other", initiatorUserId: "a", text: "late" }).ok).toBe(false);
    expect(f.control.stop(t.id, "admin").ok).toBe(true);
    expect(await Promise.all(permissions)).toEqual([false, false]);
  });

  it("uses the original member's current policy at every handoff", () => {
    const f = fixture(); const root = f.submit();
    f.policies.set("a", "ask"); f.policies.set("b", "auto");
    const child = f.control.submit({ seatId: "review", initiatorUserId: "b", parentTaskId: root.id, text: "review", readOnly: true }).task!;
    expect(child.initiatorUserId).toBe("a");
    expect(child.status).toBe("awaiting-approval");
    f.control.approve(child.id, child.approvalRequestId!, "a", true);
    const grandchild = f.control.submit({ seatId: "check", initiatorUserId: "b", parentTaskId: child.id, text: "check", readOnly: true }).task!;
    expect(grandchild.initiatorUserId).toBe("a");
    expect(grandchild.status).toBe("awaiting-approval");
    expect(f.control.approve(grandchild.id, grandchild.approvalRequestId!, "b", true).ok).toBe(false);
    f.control.approve(grandchild.id, grandchild.approvalRequestId!, "a", true);
    f.policies.set("a", "read-only");
    const read = f.control.submit({ seatId: "read", initiatorUserId: "b", parentTaskId: grandchild.id, text: "read", readOnly: true }).task!;
    const write = f.control.submit({ seatId: "write", initiatorUserId: "b", parentTaskId: grandchild.id, text: "write" }).task!;
    expect(read.status).toBe("running");
    expect(write.status).toBe("awaiting-approval");
  });

  it("does not start an approved queued child when its parent is stopped before the approval continuation", async () => {
    const f = fixture(); const root = f.submit(); const blocker = f.submit("review", "b");
    const child = f.control.submit({ seatId: "review", initiatorUserId: "a", parentTaskId: root.id, text: "child" }).task!;
    const request = child.approvalRequestId!;
    f.control.approve(child.id, request, "a", true);
    expect(child.status).toBe("queued");
    f.control.stop(root.id, "a");
    expect(blocker.status).toBe("running");
    f.finish.get(blocker.id)!();
    await Promise.resolve();
    expect(child.status).toBe("cancelled");
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.control.approve(child.id, request, "a", true).ok).toBe(false);
  });

  it.each(["deny", "timeout"] as const)("cancels a delegated task after %s and rejects late approval", async decision => {
    vi.useFakeTimers();
    const f = fixture(); const root = f.submit();
    const child = f.control.submit({ seatId: "review", initiatorUserId: "a", parentTaskId: root.id, text: "child" }).task!;
    const request = child.approvalRequestId!;
    if (decision === "deny") f.control.approve(child.id, request, "a", false);
    else {
      await vi.advanceTimersByTimeAsync(299_999);
      expect(child.status).toBe("awaiting-approval");
      await vi.advanceTimersByTimeAsync(1);
    }
    await Promise.resolve();
    expect(child.status).toBe("cancelled");
    expect(child.finishedAt).toBeDefined();
    expect(root.status).toBe("running");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.control.approve(child.id, request, "a", true).ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not report cancelled when execution rejects with an unconfirmed stop", async () => {
    const f = fixture(); const t = f.submit();
    f.control.stop(t.id, "a");
    expect(t.status).toBe("stopping");
    const error = new Error("Remote stop was not confirmed"); error.name = "RoomStopUnconfirmedError";
    f.fail.get(t.id)!(error);
    await Promise.resolve();
    expect(t.status).toBe("failed");
    expect(t.error).toBe(error.message);
  });
});

describe("room task chain limits and history", () => {
  it("allows four handoffs and rejects a fifth without changing the original initiator", () => {
    const f = fixture(); f.policy.value = "auto";
    const root = f.submit(); let parent = root;
    for (let depth = 1; depth <= 4; depth++) {
      const result = f.control.submit({ seatId: `depth-${depth}`, initiatorUserId: "b", parentTaskId: parent.id, text: "next", readOnly: true });
      expect(result.ok).toBe(true);
      expect(result.task!.initiatorUserId).toBe("a");
      expect(result.task!.rootTaskId).toBe(root.id);
      parent = result.task!;
    }
    expect(f.control.submit({ seatId: "depth-5", initiatorUserId: "a", parentTaskId: parent.id, text: "overflow", readOnly: true }).ok).toBe(false);
    expect(f.control.list()).toHaveLength(5);
  });

  it("counts stopping tasks toward the 32-task cap until execution settles", async () => {
    const f = fixture(); const tasks = [];
    for (let index = 0; index < 32; index++) tasks.push(f.submit(`seat-${index}`));
    const overflow = { seatId: "overflow", initiatorUserId: "a", text: "overflow" };
    expect(f.control.submit(overflow).ok).toBe(false);
    f.control.stop(tasks[0].id, "a");
    expect(f.control.submit(overflow).ok).toBe(false);
    f.finish.get(tasks[0].id)!();
    await Promise.resolve();
    expect(tasks[0].status).toBe("cancelled");
    expect(f.control.submit(overflow).ok).toBe(true);
  });

  it("retains the 16-task lifetime chain cap across completed children and history pruning", async () => {
    const f = fixture(); f.policy.value = "auto";
    const root = f.submit();
    for (let index = 0; index < 15; index++) {
      const result = f.control.submit({ seatId: "child", initiatorUserId: "a", parentTaskId: root.id, text: `child-${index}`, readOnly: true });
      expect(result.ok).toBe(true);
      f.finish.get(result.task!.id)!();
      await Promise.resolve();
    }
    const overflow = { seatId: "child", initiatorUserId: "a", parentTaskId: root.id, text: "seventeenth", readOnly: true };
    expect(f.control.submit(overflow).ok).toBe(false);
    for (let index = 0; index < 130; index++) {
      const historical = f.submit("history", "b");
      f.finish.get(historical.id)!();
      await Promise.resolve();
    }
    expect(f.control.list().length).toBeLessThanOrEqual(128);
    expect(f.control.list().filter(task => task.rootTaskId === root.id)).toHaveLength(16);
    expect(f.control.submit(overflow).ok).toBe(false);
  });

  it("preserves completed ancestors through pruning so stopping the root cancels pending descendants only", async () => {
    const f = fixture(); f.policy.value = "auto";
    const root = f.submit();
    const child = f.control.submit({ seatId: "child", initiatorUserId: "b", parentTaskId: root.id, text: "child", readOnly: true }).task!;
    f.policy.value = "ask";
    const grandchild = f.control.submit({ seatId: "grandchild", initiatorUserId: "b", parentTaskId: child.id, text: "grandchild", readOnly: true }).task!;
    const request = grandchild.approvalRequestId!;
    f.finish.get(child.id)!(); f.finish.get(root.id)!();
    await Promise.resolve();
    const independent = f.submit("independent", "b");
    for (let index = 0; index < 130; index++) {
      const historical = f.submit("history", "b");
      f.finish.get(historical.id)!();
      await Promise.resolve();
    }
    expect(f.control.get(root.id)?.status).toBe("completed");
    expect(f.control.get(child.id)?.status).toBe("completed");
    expect(f.control.stop(root.id, "b").ok).toBe(false);
    expect(f.control.stop(root.id, "a").ok).toBe(true);
    expect(grandchild.status).toBe("cancelled");
    expect(f.finish.has(grandchild.id)).toBe(false);
    expect(independent.status).toBe("running");
    expect(f.control.approve(grandchild.id, request, "a", true).ok).toBe(false);
  });

  it("prunes completed history from 129 entries to 96 while retaining the active task", async () => {
    const f = fixture(); let oldestId = "";
    for (let index = 0; index < 128; index++) {
      const historical = f.submit("history");
      if (index === 0) oldestId = historical.id;
      f.finish.get(historical.id)!();
      await Promise.resolve();
    }
    expect(f.control.list()).toHaveLength(128);
    const active = f.submit("history");
    expect(f.control.list()).toHaveLength(96);
    expect(f.control.get(oldestId)).toBeUndefined();
    expect(f.control.get(active.id)?.status).toBe("running");
  });
});
