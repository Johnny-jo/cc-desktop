import { describe, expect, it } from "vitest";
import {
  applyEditToContent,
  buildEditHunk,
  buildWriteHunk,
  extractLineRangeSummary,
  findSnippetStartLine,
  mergeFullTextWithHunks,
  parseHunkForDisplay,
  truncateFileChange,
  upsertFileChange,
} from "./diff";
import type { FileChange } from "./models";

describe("buildEditHunk", () => {
  it("builds a unified-ish hunk for old/new strings with line numbers", () => {
    const hunk = buildEditHunk({
      path: "src/a.ts",
      oldString: "const x = 1;\n",
      newString: "const x = 2;\n",
    });
    expect(hunk).toContain("--- a/src/a.ts");
    expect(hunk).toContain("+++ b/src/a.ts");
    expect(hunk).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(hunk).toContain("-const x = 1;");
    expect(hunk).toContain("+const x = 2;");
    expect(hunk).toMatch(/lines/);
  });

  it("uses absolute file line numbers when previousContent is provided", () => {
    const file = ["line1", "line2", "const x = 1;", "line4", ""].join("\n");
    const hunk = buildEditHunk({
      path: "src/a.ts",
      oldString: "const x = 1;\n",
      newString: "const x = 2;\n",
      previousContent: file,
    });
    // Change is on line 3 of the full file, not line 1 of the snippet
    expect(hunk).toMatch(/@@ -3,/);
    expect(hunk).toMatch(/\+3,/);
    expect(hunk).toMatch(/lines −3/);
    expect(hunk).toMatch(/\+3/);
    expect(hunk).toContain("-const x = 1;");
    expect(hunk).toContain("+const x = 2;");
  });

  it("absolute numbers work for multi-line edit mid-file", () => {
    const file = "a\nb\nc\nd\ne\n";
    const hunk = buildEditHunk({
      path: "f.ts",
      oldString: "c\nd\n",
      newString: "C\nD\nE\n",
      previousContent: file,
    });
    expect(hunk).toMatch(/@@ -3,/);
    expect(hunk).toMatch(/lines −3–4/);
    expect(hunk).toMatch(/\+3–5/);
  });

  it("findSnippetStartLine returns 1-based absolute line", () => {
    const file = "a\nb\nc\n";
    expect(findSnippetStartLine(file, "b\n")).toBe(2);
    expect(findSnippetStartLine(file, "a\n")).toBe(1);
    expect(findSnippetStartLine(file, "missing")).toBe(1);
  });

  it("applyEditToContent replaces first match", () => {
    expect(applyEditToContent("a\nb\na\n", "a\n", "X\n")).toBe("X\nb\na\n");
    expect(applyEditToContent("a\nb\na\n", "a\n", "X\n", true)).toBe("X\nb\nX\n");
  });
});

describe("buildWriteHunk", () => {
  it("marks added file when no previous content with line range", () => {
    const hunk = buildWriteHunk({
      path: "src/new.ts",
      previousContent: null,
      nextContent: "export const a = 1;\n",
    });
    expect(hunk).toContain("new file");
    expect(hunk).toMatch(/@@ -0,0 \+1,1 @@/);
    expect(hunk).toContain("lines +1");
    expect(hunk).toContain("+export const a = 1;");
  });

  it("diffs against previous content when present", () => {
    const hunk = buildWriteHunk({
      path: "src/a.ts",
      previousContent: "a\n",
      nextContent: "b\n",
    });
    expect(hunk).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(hunk).toContain("-a");
    expect(hunk).toContain("+b");
  });

  it("skips full preview for huge Write (does not hang)", () => {
    const big = "x\n".repeat(50_000);
    const t0 = Date.now();
    const hunk = buildWriteHunk({
      path: "huge.txt",
      previousContent: big,
      nextContent: `${big}y\n`,
    });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(hunk).toMatch(/large file|skipped|large change/i);
    expect(hunk.length).toBeLessThan(2000);
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

describe("parseHunkForDisplay", () => {
  it("assigns old/new line numbers for add/del/ctx", () => {
    const hunk = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,3 @@  lines −2, +2",
      " line1",
      "-old",
      "+new",
      " line3",
    ].join("\n");
    const rows = parseHunkForDisplay(hunk);
    const body = rows.filter((r) => r.kind !== "meta" && r.kind !== "hunk");
    expect(body[0]).toMatchObject({ kind: "ctx", oldNo: 1, newNo: 1 });
    expect(body[1]).toMatchObject({ kind: "del", oldNo: 2, newNo: null });
    expect(body[2]).toMatchObject({ kind: "add", oldNo: null, newNo: 2 });
    expect(body[3]).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 3 });
  });

  it("extractLineRangeSummary reads @@ annotation", () => {
    const hunk = "@@ -1,1 +1,1 @@  lines −1, +1\n-a\n+b\n";
    expect(extractLineRangeSummary(hunk)).toContain("lines");
  });
});

describe("mergeFullTextWithHunks", () => {
  it("marks added lines and keeps the rest as ctx", () => {
    const full = "alpha\nbeta\ngamma";
    const hunk = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,2 +1,3 @@  lines +2",
      " alpha",
      "+beta",
      " gamma",
    ].join("\n");
    const rows = mergeFullTextWithHunks(full, hunk);
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "add", "ctx"]);
    expect(rows[1]).toMatchObject({ newNo: 2, text: "+beta" });
    expect(rows[0]).toMatchObject({ newNo: 1 });
    expect(rows[2]).toMatchObject({ newNo: 3 });
  });

  it("splices deleted lines back before the following new line", () => {
    const full = "keep1\nkeep2";
    const hunk = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,2 @@  lines −2",
      " keep1",
      "-gone",
      " keep2",
    ].join("\n");
    const rows = mergeFullTextWithHunks(full, hunk);
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "del", "ctx"]);
    expect(rows[1]).toMatchObject({ kind: "del", text: "-gone", oldNo: 2 });
    expect(rows[2]).toMatchObject({ kind: "ctx", newNo: 2 });
  });

  it("anchors trailing deletions after the last line", () => {
    const full = "only";
    const hunk = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,2 +1,1 @@  lines −2",
      " only",
      "-tail",
    ].join("\n");
    const rows = mergeFullTextWithHunks(full, hunk);
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "del"]);
  });

  it("handles add+del replacement pairs", () => {
    const full = "a\nb2\nc";
    const hunk = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,3 @@  lines −2, +2",
      " a",
      "-b1",
      "+b2",
      " c",
    ].join("\n");
    const rows = mergeFullTextWithHunks(full, hunk);
    expect(rows.map((r) => r.kind)).toEqual(["ctx", "del", "add", "ctx"]);
    expect(rows[1].text).toBe("-b1");
    expect(rows[2].text).toBe("+b2");
  });

  it("treats every line as add for a brand-new file hunk", () => {
    const full = "x\ny";
    const hunk = [
      "--- /dev/null",
      "+++ b/f.ts",
      "@@ -0,0 +1,2 @@  new file · lines +1–2",
      "+x",
      "+y",
    ].join("\n");
    const rows = mergeFullTextWithHunks(full, hunk);
    expect(rows.map((r) => r.kind)).toEqual(["add", "add"]);
  });

  it("caps output and notes truncation", () => {
    const full = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");
    const rows = mergeFullTextWithHunks(full, "", 3);
    expect(rows.filter((r) => r.kind === "ctx")).toHaveLength(3);
    const meta = rows[rows.length - 1]!;
    expect(meta.kind).toBe("meta");
    expect(meta.text).toContain("capped");
  });
});
