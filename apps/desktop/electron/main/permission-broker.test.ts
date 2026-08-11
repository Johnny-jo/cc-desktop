import { describe, expect, it, vi } from "vitest";
import type { PermissionDecision, PermissionRequest } from "@claude-desktop/shared";
import { PermissionBroker } from "./permission-broker";

describe("PermissionBroker", () => {
  it("auto-allows Edit in acceptEdits mode", async () => {
    const broker = new PermissionBroker({
      getMode: () => "acceptEdits",
      requestFromUi: vi.fn(),
      timeoutMs: 1000,
    });
    const res = await broker.canUseTool("Edit", { file_path: "src/a.ts" }, "sess1");
    expect(res.behavior).toBe("allow");
  });

  it("auto mode allows non-destructive tools without UI", async () => {
    const requestFromUi = vi.fn();
    const broker = new PermissionBroker({
      getMode: () => "auto",
      requestFromUi,
      timeoutMs: 1000,
    });

    const edit = await broker.canUseTool("Edit", { file_path: "src/a.ts" }, "sess1");
    expect(edit.behavior).toBe("allow");

    const bash = await broker.canUseTool(
      "Bash",
      { command: "git status" },
      "sess1",
    );
    expect(bash.behavior).toBe("allow");
    expect(requestFromUi).not.toHaveBeenCalled();
  });

  it("still asks for destructive Bash even in auto mode", async () => {
    const requestFromUi = vi.fn();
    const broker = new PermissionBroker({
      getMode: () => "auto",
      requestFromUi,
      timeoutMs: 1000,
    });

    const pending = broker.canUseTool(
      "Bash",
      { command: "rm -rf /tmp/foo" },
      "sess1",
    );
    expect(requestFromUi).toHaveBeenCalledTimes(1);
    const req = requestFromUi.mock.calls[0][0] as PermissionRequest;
    broker.respond(req.requestId, { behavior: "allow", scope: "once" });
    const res = await pending;
    expect(res.behavior).toBe("allow");
  });

  it("still asks for destructive Bash even in acceptEdits mode", async () => {
    const requestFromUi = vi.fn();
    const broker = new PermissionBroker({
      getMode: () => "acceptEdits",
      requestFromUi,
      timeoutMs: 1000,
    });

    const pending = broker.canUseTool(
      "Bash",
      { command: "rm -rf /tmp/foo" },
      "sess1",
    );

    expect(requestFromUi).toHaveBeenCalledTimes(1);
    const req = requestFromUi.mock.calls[0][0] as PermissionRequest;
    expect(req.toolName).toBe("Bash");
    expect(req.sessionId).toBe("sess1");

    broker.respond(req.requestId, { behavior: "allow", scope: "once" });
    const res = await pending;
    expect(res.behavior).toBe("allow");
  });

  it("allows after session rule is stored", async () => {
    const requestFromUi = vi.fn();
    const broker = new PermissionBroker({
      getMode: () => "default",
      requestFromUi,
      timeoutMs: 1000,
    });

    const first = broker.canUseTool("Edit", { file_path: "src/a.ts" }, "sess1");
    const req = requestFromUi.mock.calls[0][0] as PermissionRequest;
    broker.respond(req.requestId, { behavior: "allow", scope: "session" });
    await first;

    requestFromUi.mockClear();
    const second = await broker.canUseTool("Edit", { file_path: "src/b.ts" }, "sess1");
    expect(second.behavior).toBe("allow");
    expect(requestFromUi).not.toHaveBeenCalled();
  });

  it("resolves pending promise when respond is called", async () => {
    const requestFromUi = vi.fn();
    const broker = new PermissionBroker({
      getMode: () => "default",
      requestFromUi,
      timeoutMs: 1000,
    });

    const pending = broker.canUseTool("Bash", { command: "git status" }, "sess1");
    const req = requestFromUi.mock.calls[0][0] as PermissionRequest;

    const decision: PermissionDecision = { behavior: "deny", message: "nope" };
    broker.respond(req.requestId, decision);
    const res = await pending;
    expect(res).toEqual({ behavior: "deny", message: "nope" });
  });

  it("denies on timeout", async () => {
    const requestFromUi = vi.fn();
    const broker = new PermissionBroker({
      getMode: () => "default",
      requestFromUi,
      timeoutMs: 30,
    });

    const res = await broker.canUseTool("Bash", { command: "git status" }, "sess1");
    expect(res.behavior).toBe("deny");
    expect(requestFromUi).toHaveBeenCalledTimes(1);
  });

  it("direct-allows read-only tools in default mode without UI", async () => {
    const requestFromUi = vi.fn();
    const broker = new PermissionBroker({
      getMode: () => "default",
      requestFromUi,
      timeoutMs: 1000,
    });

    for (const tool of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"]) {
      const res = await broker.canUseTool(tool, { file_path: "src/a.ts" }, "sess1");
      expect(res.behavior).toBe("allow");
    }
    expect(requestFromUi).not.toHaveBeenCalled();
  });

  it("plan mode still hard-blocks writes even though reads pass through", async () => {
    const requestFromUi = vi.fn();
    const broker = new PermissionBroker({
      getMode: () => "plan",
      requestFromUi,
      timeoutMs: 1000,
    });

    const read = await broker.canUseTool("Read", { file_path: "src/a.ts" }, "sess1");
    expect(read.behavior).toBe("allow");

    const edit = await broker.canUseTool("Edit", { file_path: "src/a.ts" }, "sess1");
    expect(edit.behavior).toBe("deny");
    expect(requestFromUi).not.toHaveBeenCalled();
  });
});
