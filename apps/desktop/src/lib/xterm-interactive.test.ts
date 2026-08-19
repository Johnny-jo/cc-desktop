import { describe, expect, it } from "vitest";
import {
  droppedPathsPayload,
  isPasteChord,
  quoteDroppedPath,
} from "./xterm-interactive";

describe("isPasteChord", () => {
  it("treats Ctrl+V and Cmd+V as paste", () => {
    expect(
      isPasteChord({ key: "v", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }),
    ).toBe(true);
    expect(
      isPasteChord({ key: "V", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }),
    ).toBe(true);
  });

  it("treats Shift+Insert as paste", () => {
    expect(
      isPasteChord({
        key: "Insert",
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
  });

  it("does not steal Ctrl+C (TUI interrupt) or bare V", () => {
    expect(
      isPasteChord({ key: "c", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }),
    ).toBe(false);
    expect(
      isPasteChord({ key: "v", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }),
    ).toBe(false);
  });
});

describe("droppedPathsPayload", () => {
  it("joins paths with spaces and quotes those that need it", () => {
    expect(quoteDroppedPath("C:\\\\gitrep\\\\a.ts")).toBe("C:\\\\gitrep\\\\a.ts");
    expect(quoteDroppedPath("C:\\\\My Docs\\\\a.ts")).toBe('"C:\\\\My Docs\\\\a.ts"');
    expect(droppedPathsPayload(["/tmp/a.ts", "/tmp/my file.ts"])).toBe(
      '/tmp/a.ts "/tmp/my file.ts"',
    );
  });

  it("drops empty paths", () => {
    expect(droppedPathsPayload(["", "/tmp/a.ts"])).toBe("/tmp/a.ts");
  });
});
