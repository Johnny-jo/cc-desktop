import { describe, expect, it } from "vitest";
import {
  droppedPathsPayload,
  isCopyChord,
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

describe("isCopyChord", () => {
  const chord = (over: Partial<Parameters<typeof isCopyChord>[0]>) => ({
    key: "c",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it("treats Ctrl+Shift+C and Cmd+C as copy", () => {
    expect(isCopyChord(chord({ shiftKey: true }), false)).toBe(true);
    expect(isCopyChord(chord({ ctrlKey: false, metaKey: true }), false)).toBe(true);
  });

  it("treats plain Ctrl+C as copy only while a selection exists", () => {
    expect(isCopyChord(chord({}), true)).toBe(true);
    expect(isCopyChord(chord({}), false)).toBe(false);
  });

  it("ignores Alt+C and bare C", () => {
    expect(isCopyChord(chord({ altKey: true }), true)).toBe(false);
    expect(isCopyChord(chord({ ctrlKey: false }), true)).toBe(false);
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
