import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DiffTracker,
  parseBashWriteTarget,
  walkMtimes,
} from "./diff-tracker";

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

  it("threads toolUseId onto Edit/Write change events", () => {
    const tracker = new DiffTracker();
    tracker.onToolUse(
      "s1",
      "Edit",
      { file_path: "src/a.ts", old_string: "a\n", new_string: "b\n" },
      { toolUseId: "tu-123" },
    );
    tracker.onToolUse(
      "s1",
      "Write",
      { file_path: "src/b.ts", content: "x\n" },
      { toolUseId: "tu-456" },
    );
    const a = tracker.list("s1").find((c) => c.path === "src/a.ts")!;
    const b = tracker.list("s1").find((c) => c.path === "src/b.ts")!;
    expect(a.events[0].toolUseId).toBe("tu-123");
    expect(b.events[0].toolUseId).toBe("tu-456");
  });

  it("markDeleted flags missing files D and restores reappeared ones to M", () => {
    const alive = new Set<string>(["src/a.ts", "src/b.ts"]);
    const tracker = new DiffTracker({
      fileExists: (p) => alive.has(p),
    });
    tracker.onToolUse("s1", "Edit", {
      file_path: "src/a.ts",
      old_string: "a\n",
      new_string: "b\n",
    });
    tracker.onToolUse("s1", "Edit", {
      file_path: "src/b.ts",
      old_string: "a\n",
      new_string: "b\n",
    });

    alive.delete("src/a.ts");
    expect(tracker.markDeleted("s1")).toBe(true);
    const after = tracker.list("s1");
    expect(after.find((c) => c.path === "src/a.ts")!.status).toBe("D");
    expect(after.find((c) => c.path === "src/b.ts")!.status).toBe("M");

    // No further changes → no-op
    expect(tracker.markDeleted("s1")).toBe(false);

    // File reappears → back to M
    alive.add("src/a.ts");
    expect(tracker.markDeleted("s1")).toBe(true);
    expect(
      tracker.list("s1").find((c) => c.path === "src/a.ts")!.status,
    ).toBe("M");
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

  it("hydrate restores a full change set", () => {
    const tracker = new DiffTracker();
    tracker.hydrate("s1", [
      {
        path: "a.ts",
        status: "M",
        hunks: "+x",
        updatedAt: 1,
        events: [{ id: "ev-1", tool: "Edit", at: 1, hunk: "+x" }],
      },
    ]);
    expect(tracker.list("s1")).toHaveLength(1);
    expect(tracker.list("s1")[0].path).toBe("a.ts");
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

  it("does not mark a pending Write (status A) as deleted before the file exists", () => {
    const tracker = new DiffTracker({
      fileExists: () => false,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    tracker.onToolUse("s1", "Write", {
      file_path: "src/new.ts",
      content: "hello\n",
    });
    expect(tracker.list("s1")[0].status).toBe("A");
    expect(tracker.markDeleted("s1")).toBe(false);
    expect(tracker.list("s1")[0].status).toBe("A");
  });

  it("resolves Write paths under session cwd so existence checks hit the project", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-cwd-"));
    fs.writeFileSync(path.join(dir, "gen.ts"), "hi\n");
    const tracker = new DiffTracker();
    tracker.onToolUse(
      "s1",
      "Write",
      { file_path: "gen.ts", content: "hi\n" },
      { cwd: dir },
    );
    expect(tracker.markDeleted("s1", dir)).toBe(false);
    const change = tracker.list("s1")[0];
    expect(change.status).toBe("A");
    expect(path.isAbsolute(change.path)).toBe(true);
    expect(fs.existsSync(change.path)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
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

  it("workspace scan records files created after Bash baseline (mtime fallback)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diff-scan-"));
    try {
      // No .git here → mtime baseline path.
      const existing = path.join(root, "keep.py");
      fs.writeFileSync(existing, "print(1)\n", "utf8");

      const readFile = (p: string) => fs.readFileSync(p, "utf8");
      const tracker = new DiffTracker({ readFile });

      await tracker.captureBashBaseline("s1", root);
      // Simulate a script writing a yml that Edit/Write never saw.
      const yml = path.join(root, "config.generated.yml");
      fs.writeFileSync(yml, "port: 8317\n", "utf8");
      // Bump mtime slightly in case FS resolution is coarse.
      const st = fs.statSync(yml);
      fs.utimesSync(yml, st.atime, new Date(st.mtimeMs + 50));

      await tracker.refreshBashWritesFromDisk("s1", root);
      const changes = tracker.list("s1");
      const hit = changes.find(
        (c) => c.path === yml || c.path.endsWith("config.generated.yml"),
      );
      expect(hit).toBeTruthy();
      expect(hit!.status).toBe("A");
      expect(hit!.hunks).toMatch(/workspace scan|Bash/);
      expect(hit!.hunks).toContain("port: 8317");
      // Pre-existing file with unchanged mtime should not appear.
      expect(
        changes.some((c) => c.path === existing || c.path.endsWith("keep.py")),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not dump a dirty git worktree into the session when this turn never used Bash", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diff-noscan-"));
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      const leftover = path.join(root, "legacy.ts");
      fs.writeFileSync(leftover, "old work\n", "utf8");
      const wrote = path.join(root, "fresh.ts");
      const tracker = new DiffTracker({
        readFile: (p) => fs.readFileSync(p, "utf8"),
      });
      tracker.onToolUse(
        "s1",
        "Write",
        { file_path: wrote, content: "new\n" },
        { cwd: root },
      );
      await tracker.refreshBashWritesFromDisk("s1", root);
      const paths = tracker.list("s1").map((c) => c.path);
      expect(paths.some((p) => p === leftover || p.endsWith("legacy.ts"))).toBe(
        false,
      );
      expect(paths.some((p) => p === wrote || p.endsWith("fresh.ts"))).toBe(true);
      expect(tracker.list("s1").find((c) => c.path === wrote)?.events).toHaveLength(
        1,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshes this-turn Bash content in place instead of appending a new event", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diff-inplace-"));
    try {
      const filePath = path.join(root, "via-bash.ts");
      const tracker = new DiffTracker({
        readFile: (p) => fs.readFileSync(p, "utf8"),
      });
      tracker.onToolUse(
        "s1",
        "Bash",
        { command: "cat > via-bash.ts <<'EOF'\nbefore\nEOF" },
        { cwd: root },
      );
      expect(tracker.list("s1")[0]!.events).toHaveLength(1);
      fs.writeFileSync(filePath, "after disk write\n", "utf8");
      await tracker.captureBashBaseline("s1", root);
      await tracker.refreshBashWritesFromDisk("s1", root);
      const change = tracker.list("s1")[0]!;
      expect(change.events).toHaveLength(1);
      expect(change.hunks).toContain("after disk write");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("walkMtimes skips ignored dirs and binary extensions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diff-walk-"));
    try {
      fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
      fs.writeFileSync(path.join(root, "node_modules", "x.js"), "1", "utf8");
      fs.writeFileSync(path.join(root, "ok.ts"), "x", "utf8");
      fs.writeFileSync(path.join(root, "pic.png"), "bin", "utf8");
      const map = await walkMtimes(root);
      const keys = [...map.keys()].map((k) => path.basename(k));
      expect(keys).toContain("ok.ts");
      expect(keys).not.toContain("x.js");
      expect(keys).not.toContain("pic.png");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
