import { describe, expect, it } from "vitest";
import { lineMarksFromHunks } from "./editor-diff-deco";

describe("lineMarksFromHunks runs", () => {
  it("groups a replacement as one run (dels + consecutive adds)", () => {
    const hunk = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,4 @@",
      " a",
      "-old",
      "+n1",
      "+n2",
      " c",
    ].join("\n");
    const marks = lineMarksFromHunks(hunk);
    expect([...marks.added].sort((a, b) => a - b)).toEqual([2, 3]);
    expect(marks.runs).toEqual([
      { startNewNo: 2, endNewNo: 3, dels: ["old"] },
    ]);
    expect(marks.delsBefore.get(2)).toEqual(["old"]);
  });

  it("splits runs when a context line sits between changes", () => {
    const hunk = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,5 +1,5 @@",
      "-a",
      "+A",
      " keep",
      "-b",
      "+B",
    ].join("\n");
    const marks = lineMarksFromHunks(hunk);
    expect(marks.runs).toHaveLength(2);
    expect(marks.runs[0]).toMatchObject({ startNewNo: 1, endNewNo: 1, dels: ["a"] });
    expect(marks.runs[1]).toMatchObject({ startNewNo: 3, endNewNo: 3, dels: ["b"] });
  });

  it("anchors a pure-delete run on the following new line", () => {
    const hunk = [
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,2 @@",
      " keep1",
      "-gone",
      " keep2",
    ].join("\n");
    const marks = lineMarksFromHunks(hunk);
    expect(marks.added.size).toBe(0);
    expect(marks.runs).toEqual([
      { startNewNo: 2, endNewNo: 2, dels: ["gone"] },
    ]);
    expect(marks.delsBefore.get(2)).toEqual(["gone"]);
  });
});
