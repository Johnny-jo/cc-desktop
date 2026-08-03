import { describe, expect, it, vi } from "vitest";
import { DiffTracker, parseBashWriteTarget } from "./diff-tracker";

describe("DiffTracker", () => {
  it("records Edit as modified file change", () => {
    const tracker = new DiffTracker();
    tracker.onToolUse("s1", "Edit", {
      file_path: "src/a.ts",
      old_string: "a\n",
      new_string: "b\n",
    });
    const changes = tracker.list("s1");
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe("M");
    expect(changes[0].hunks).toContain("+b");
  });

  it("records Bash cat>heredoc as added file change", () => {
    expect(
      parseBashWriteTarget("cat > UIManager.cs <<'EOF'\nhello\nEOF"),
    ).toBe("UIManager.cs");

    const tracker = new DiffTracker();
    tracker.onToolUse("s1", "Bash", {
      command: "cat > UIManager.cs <<'EOF'\nusing UnityEngine;\nEOF",
    });
    const changes = tracker.list("s1");
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe("UIManager.cs");
    expect(changes[0].status).toBe("A");
    expect(changes[0].hunks).toMatch(/Bash|new file|\+/);
  });

  it("records Write without previous content as added (status A)", () => {
    const tracker = new DiffTracker();
    tracker.onToolUse("s1", "Write", {
      file_path: "src/new.ts",
      content: "export const a = 1;\n",
    });
    const changes = tracker.list("s1");
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe("A");
    expect(changes[0].path).toBe("src/new.ts");
    expect(changes[0].hunks).toContain("new file");
    expect(changes[0].hunks).toContain("+export const a = 1;");
  });

  it("uses injected readFile for Write previous content (status M)", () => {
    const readFile = vi.fn().mockReturnValue("old\n");
    const tracker = new DiffTracker({ readFile });
    tracker.onToolUse("s1", "Write", {
      file_path: "src/a.ts",
      content: "new\n",
    });
    expect(readFile).toHaveBeenCalledWith("src/a.ts");
    const changes = tracker.list("s1");
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe("M");
    expect(changes[0].hunks).toContain("-old");
    expect(changes[0].hunks).toContain("+new");
  });

  it("falls back to status A when readFile fails", () => {
    const readFile = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const tracker = new DiffTracker({ readFile });
    tracker.onToolUse("s1", "Write", {
      file_path: "src/missing.ts",
      content: "hello\n",
    });
    const changes = tracker.list("s1");
    expect(changes[0].status).toBe("A");
    expect(changes[0].hunks).toContain("new file");
  });

  it("isolates changes by sessionId", () => {
    const tracker = new DiffTracker();
    tracker.onToolUse("s1", "Edit", {
      file_path: "src/a.ts",
      old_string: "a\n",
      new_string: "b\n",
    });
    tracker.onToolUse("s2", "Write", {
      file_path: "src/b.ts",
      content: "x\n",
    });
    expect(tracker.list("s1")).toHaveLength(1);
    expect(tracker.list("s1")[0].path).toBe("src/a.ts");
    expect(tracker.list("s2")).toHaveLength(1);
    expect(tracker.list("s2")[0].path).toBe("src/b.ts");
    expect(tracker.list("missing")).toEqual([]);
  });

  it("aggregates multiple edits on the same path", () => {
    const tracker = new DiffTracker();
    tracker.onToolUse("s1", "Edit", {
      file_path: "src/a.ts",
      old_string: "a\n",
      new_string: "b\n",
    });
    tracker.onToolUse("s1", "Edit", {
      file_path: "src/a.ts",
      old_string: "b\n",
      new_string: "c\n",
    });
    const changes = tracker.list("s1");
    expect(changes).toHaveLength(1);
    expect(changes[0].events).toHaveLength(2);
    expect(changes[0].hunks).toContain("+c");
    expect(changes[0].status).toBe("M");
  });

  it("ignores non Edit/Write tools", () => {
    const tracker = new DiffTracker();
    tracker.onToolUse("s1", "Bash", { command: "echo hi" });
    tracker.onToolUse("s1", "Read", { file_path: "src/a.ts" });
    expect(tracker.list("s1")).toEqual([]);
  });

  it("clearSession removes session changes", () => {
    const tracker = new DiffTracker();
    tracker.onToolUse("s1", "Edit", {
      file_path: "src/a.ts",
      old_string: "a\n",
      new_string: "b\n",
    });
    tracker.clearSession("s1");
    expect(tracker.list("s1")).toEqual([]);
  });
});
