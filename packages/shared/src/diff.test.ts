import { describe, expect, it } from "vitest";
import {
  buildEditHunk,
  buildWriteHunk,
  truncateFileChange,
  upsertFileChange,
} from "./diff";
import type { FileChange } from "./models";

describe("buildEditHunk", () => {
  it("builds a unified-ish hunk for old/new strings", () => {
    const hunk = buildEditHunk({
      path: "src/a.ts",
      oldString: "const x = 1;\n",
      newString: "const x = 2;\n",
    });
    expect(hunk).toContain("--- a/src/a.ts");
    expect(hunk).toContain("+++ b/src/a.ts");
    expect(hunk).toContain("-const x = 1;");
    expect(hunk).toContain("+const x = 2;");
  });
});

describe("buildWriteHunk", () => {
  it("marks added file when no previous content", () => {
    const hunk = buildWriteHunk({
      path: "src/new.ts",
      previousContent: null,
      nextContent: "export const a = 1;\n",
    });
    expect(hunk).toContain("new file");
    expect(hunk).toContain("+export const a = 1;");
  });

  it("diffs against previous content when present", () => {
    const hunk = buildWriteHunk({
      path: "src/a.ts",
      previousContent: "a\n",
      nextContent: "b\n",
    });
    expect(hunk).toContain("-a");
    expect(hunk).toContain("+b");
  });
});

describe("upsertFileChange", () => {
  it("aggregates multiple edits on same path", () => {
    const t0 = 1000;
    let map = new Map<string, FileChange>();
    map = upsertFileChange(map, {
      id: "ev-1",
      path: "src/a.ts",
      tool: "Edit",
      hunk: "h1",
      at: t0,
      status: "M",
    });
    map = upsertFileChange(map, {
      id: "ev-2",
      path: "src/a.ts",
      tool: "Edit",
      hunk: "h2",
      at: t0 + 1,
      status: "M",
    });
    const item = map.get("src/a.ts")!;
    expect(item.events).toHaveLength(2);
    expect(item.events.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    expect(item.hunks).toContain("h2");
    expect(item.status).toBe("M");
  });
});

describe("truncateFileChange", () => {
  const change: FileChange = {
    path: "src/a.ts",
    status: "M",
    hunks: "h3",
    updatedAt: 3,
    events: [
      { id: "ev-1", tool: "Write", at: 1, hunk: "h1" },
      { id: "ev-2", tool: "Edit", at: 2, hunk: "h2" },
      { id: "ev-3", tool: "Edit", at: 3, hunk: "h3" },
    ],
  };

  it("drops the target event and all later events", () => {
    const t = truncateFileChange(change, "ev-2");
    expect(t?.events.map((e) => e.id)).toEqual(["ev-1"]);
    expect(t?.hunks).toBe("h1");
    expect(t?.updatedAt).toBe(1);
  });

  it("returns undefined when no events remain", () => {
    expect(truncateFileChange(change, "ev-1")).toBeUndefined();
  });

  it("returns the change unchanged for an unknown event id", () => {
    expect(truncateFileChange(change, "nope")).toBe(change);
  });
});
