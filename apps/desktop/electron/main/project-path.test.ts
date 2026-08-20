import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInside } from "./project-path";

const win = path.win32;
const posix = path.posix;

describe("resolveInside (win32)", () => {
  const cwd = "D:\\gitRep\\ccDesktop";

  it("allows a posix-style relative path under the project", () => {
    expect(resolveInside(cwd, "docs/通信架构评审意见.md", win)).toBe(
      "D:\\gitRep\\ccDesktop\\docs\\通信架构评审意见.md",
    );
  });

  it("allows an absolute path that only differs by drive-letter case", () => {
    const rel = "d:\\gitRep\\ccDesktop\\docs\\通信架构评审意见.md";
    expect(resolveInside(cwd, rel, win)?.toLowerCase()).toBe(
      "d:\\gitrep\\ccdesktop\\docs\\通信架构评审意见.md",
    );
  });

  it("allows an absolute path when cwd drive letter is lowercase", () => {
    const lowerCwd = "d:\\gitRep\\ccDesktop";
    const rel = "D:\\gitRep\\ccDesktop\\docs\\foo.md";
    const got = resolveInside(lowerCwd, rel, win);
    expect(got).not.toBeNull();
    expect(got!.toLowerCase()).toBe("d:\\gitrep\\ccdesktop\\docs\\foo.md");
  });

  it("treats a leading-slash path as project-relative on Windows", () => {
    expect(resolveInside(cwd, "/docs/foo.md", win)).toBe(
      "D:\\gitRep\\ccDesktop\\docs\\foo.md",
    );
    expect(resolveInside(cwd, "\\docs\\foo.md", win)).toBe(
      "D:\\gitRep\\ccDesktop\\docs\\foo.md",
    );
  });

  it("unwraps a POSIX-wrapped Windows absolute path", () => {
    expect(resolveInside(cwd, "/D:/gitRep/ccDesktop/docs/foo.md", win)).toBe(
      "D:\\gitRep\\ccDesktop\\docs\\foo.md",
    );
  });

  it("maps Git-bash /d/proj paths instead of joining them as relative", () => {
    const gitBash = "/d/gitRep/ccDesktop/docs/通信架构补充条款.md";
    const normalized = "\\d\\gitRep\\ccDesktop\\docs\\通信架构补充条款.md";
    const noLead = "d/gitRep/ccDesktop/docs/通信架构补充条款.md";
    for (const rel of [gitBash, normalized, noLead]) {
      const got = resolveInside(cwd, rel, win);
      expect(got, rel).not.toBeNull();
      expect(got!.toLowerCase()).toBe(
        "d:\\gitrep\\ccdesktop\\docs\\通信架构补充条款.md",
      );
      expect(got!.toLowerCase()).not.toContain("\\d\\gitrep\\");
    }
  });

  it("does not treat a real single-letter folder as a drive", () => {
    expect(resolveInside(cwd, "d/notes.md", win)).toBe(
      "D:\\gitRep\\ccDesktop\\d\\notes.md",
    );
  });

  it("rejects a true parent escape", () => {
    expect(resolveInside(cwd, "..\\secret.txt", win)).toBeNull();
    expect(resolveInside(cwd, "docs/../../outside.txt", win)).toBeNull();
  });

  it("rejects a different drive", () => {
    expect(resolveInside(cwd, "C:\\Windows\\notepad.exe", win)).toBeNull();
  });

  it("rejects a prefix-sibling (proj vs proj-evil)", () => {
    expect(resolveInside("D:\\proj", "D:\\proj-evil\\x.ts", win)).toBeNull();
  });

  it("does not treat a '..foo' filename as an escape", () => {
    expect(resolveInside(cwd, "..foo.txt", win)).toBe(
      "D:\\gitRep\\ccDesktop\\..foo.txt",
    );
  });
});

describe("resolveInside (posix)", () => {
  const cwd = "/home/user/proj";

  it("allows a relative path", () => {
    expect(resolveInside(cwd, "docs/a.md", posix)).toBe("/home/user/proj/docs/a.md");
  });

  it("rejects an absolute path outside the project", () => {
    expect(resolveInside(cwd, "/etc/passwd", posix)).toBeNull();
  });

  it("rejects .. escape", () => {
    expect(resolveInside(cwd, "../other/x", posix)).toBeNull();
  });
});
