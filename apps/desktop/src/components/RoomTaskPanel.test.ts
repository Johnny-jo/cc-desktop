import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RoomTask, RoomRole } from "@claude-desktop/shared";
import { RoomTaskPanel, RoomTaskRow } from "./RoomTaskPanel";
import { ThemedSelect } from "./Select";
import { readFileSync } from "node:fs";

const task: RoomTask = { id: "child", seatId: "agent", initiatorUserId: "owner", parentTaskId: "parent", rootTaskId: "root", status: "awaiting-approval", text: "审查变更", readOnly: true, createdAt: 1, approvalKind: "delegation", approvalRequestId: "request-1", approvalDetail: "转交检查" };
function room(userId = "owner", role: RoomRole = "member") {
  return { roomId: "r", status: "open" as const, localUserId: userId,
    members: [{ userId, name: userId === "owner" ? "发起人" : "管理员", role }], seats: [], tasks: [task] };
}
function nodes(element: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  return React.Children.toArray(element).flatMap(child => {
    if (!React.isValidElement<Record<string, unknown>>(child)) return [];
    return [child, ...nodes(child.props.children as React.ReactNode)];
  });
}
function buttons(element: React.ReactNode) { return nodes(element).filter(node => node.type === "button"); }

describe("RoomTaskPanel", () => {
  it("uses scalable typography throughout the task panel", () => {
    const css = readFileSync(new URL("./RoomTaskPanel.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/font-size:\s*\d+(?:\.\d+)?px\b/);
    expect(css).toMatch(/font-size:\s*1rem/);
  });
  it("keeps personal delegation settings collapsed with their current choice visible", () => {
    const panel = RoomTaskPanel({ room: room(), onControl: () => {} });
    const disclosure = nodes(panel).find(node => node.type === "details" && node.props.className === "room-task-policy-wrap");
    expect(disclosure).toBeDefined();
    expect(disclosure?.props.open).not.toBe(true);
    const summary = nodes(disclosure).find(node => node.type === "summary");
    expect(renderToStaticMarkup(summary!)).toContain("逐次确认");
    expect(nodes(disclosure).some(node => node.type === ThemedSelect)).toBe(true);
  });
  it("puts real running and queued counts in the task panel instead of the chat header", () => {
    const html = renderToStaticMarkup(RoomTaskPanel({ room: { ...room(), tasks: [
      { ...task, status: "running" }, { ...task, id: "queue", status: "queued" },
    ] }, onControl: () => {} }));
    expect(html).toContain("1 项执行中");
    expect(html).toContain("1 项排队");
  });
  it("places actionable own approvals first without duplicating them in current tasks", () => {
    const tasks: RoomTask[] = [
      { ...task, id: "running", status: "running", createdAt: 0 },
      { ...task, id: "someone-else", initiatorUserId: "other" },
      { ...task, id: "mine-later", createdAt: 4 },
      { ...task, id: "mine-first", createdAt: 2 },
      { ...task, id: "stale", approvalRequestId: undefined },
    ];
    const panel = RoomTaskPanel({ room: { ...room(), tasks }, onControl: () => {} });
    const approval = nodes(panel).find(node => node.props["aria-label"] === "待我确认");
    expect(approval).toBeDefined();
    expect(nodes(approval).filter(node => node.type === RoomTaskRow).map(node => (node.props.task as RoomTask).id)).toEqual(["mine-first", "mine-later"]);
    const rows = nodes(panel).filter(node => node.type === RoomTaskRow);
    expect(rows.map(node => (node.props.task as RoomTask).id)).toEqual(["mine-first", "mine-later", "running", "someone-else", "stale"]);
    expect(new Set(rows.map(node => (node.props.task as RoomTask).id)).size).toBe(tasks.length);
  });
  it("keeps personal policy after task content and recent history initially collapsed", () => {
    const panel = RoomTaskPanel({ room: { ...room(), tasks: [task, { ...task, id: "done", status: "completed" }] }, onControl: () => {} });
    const elements = nodes(panel);
    expect(elements.findIndex(node => node.type === ThemedSelect)).toBeGreaterThan(elements.findIndex(node => node.type === RoomTaskRow));
    expect(elements.find(node => node.type === "details")?.props.open).not.toBe(true);
  });
  it("has a useful empty state without an empty approval group", () => {
    const panel = RoomTaskPanel({ room: { ...room(), tasks: [] }, onControl: () => {} });
    expect(nodes(panel).find(node => node.props["aria-label"] === "待我确认")).toBeUndefined();
    const html = renderToStaticMarkup(panel);
    expect(html).toContain("暂无进行中的任务");
    expect(html).toContain("从 @ 候选中选择 Agent");
  });
  it("shows active/recent state, original initiator and backend parent identity", () => {
    const html = renderToStaticMarkup(React.createElement(RoomTaskPanel, { room: { ...room(), tasks: [task, { ...task, id: "done", status: "completed" }] }, onControl: () => {} }));
    for (const label of ["当前任务", "近期任务", "等待确认", "已完成", "发起人", "parent", "审查变更"]) expect(html).toContain(label);
  });
  it("approves each request separately with the original requestId", () => {
    const onControl = vi.fn();
    for (const requestId of ["request-1", "request-2"]) {
      const row = RoomTaskRow({ room: room(), task: { ...task, approvalRequestId: requestId }, onControl });
      const approve = buttons(row).find(node => node.props.children === "批准")!;
      const deny = buttons(row).find(node => node.props.children === "拒绝")!;
      (approve.props.onClick as () => void)();
      expect(onControl).toHaveBeenLastCalledWith({ roomId: "r", action: "approve", taskId: "child", requestId, allow: true });
      (deny.props.onClick as () => void)();
      expect(onControl).toHaveBeenLastCalledWith({ roomId: "r", action: "approve", taskId: "child", requestId, allow: false });
    }
  });
  it.each(["host", "admin", "member"] as const)("does not let non-initiator %s approve", role => {
    const row = RoomTaskRow({ room: room("other", role), task, onControl: () => {} });
    expect(buttons(row).some(button => button.props.children === "批准")).toBe(false);
    expect(buttons(row).some(button => button.props.children === "停止")).toBe(role !== "member");
  });
  it("lets the initiator stop their child task using its ID", () => {
    const onControl = vi.fn();
    const stop = buttons(RoomTaskRow({ room: room(), task, onControl })).find(node => node.props.children === "停止")!;
    (stop.props.onClick as () => void)();
    expect(onControl).toHaveBeenCalledWith({ roomId: "r", action: "stop", taskId: "child" });
  });
  it("hides stale approvals and terminal stop actions; disables disconnected controls", () => {
    for (const status of ["stopping", "cancelled", "completed", "failed"] as const) {
      expect(buttons(RoomTaskRow({ room: room(), task: { ...task, status }, onControl: () => {} }))).toHaveLength(0);
    }
    expect(buttons(RoomTaskRow({ room: room(), task: { ...task, approvalRequestId: undefined }, onControl: () => {} })).some(node => node.props.children === "批准")).toBe(false);
    expect(buttons(RoomTaskRow({ room: room(), task, offline: true, onControl: () => {} })).every(node => node.props.disabled)).toBe(true);
  });
  it("defaults personal delegation to ask and submits only the selected personal policy", () => {
    const onControl = vi.fn();
    const select = nodes(RoomTaskPanel({ room: room(), onControl })).find(node => node.type === ThemedSelect)!;
    expect(select.props.value).toBe("ask");
    for (const policy of ["ask", "read-only", "auto"]) {
      (select.props.onChange as (value: string) => void)(policy);
      expect(onControl).toHaveBeenLastCalledWith({ roomId: "r", action: "policy", policy });
    }
    const configured = room();
    const html = renderToStaticMarkup(React.createElement(RoomTaskPanel, { room: { ...configured, members: [{ ...configured.members[0], delegationPolicy: "read-only" }] }, onControl }));
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain("只读自动，修改需批");
  });
});
