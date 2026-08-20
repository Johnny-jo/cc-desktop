import { describe, expect, it } from "vitest";
import { resolvePath, toProjectRel } from "./project-path";

describe("toProjectRel", () => {
  const root = "D:\\gitRep\\ccDesktop";

  it("converts an absolute Windows path to a project-relative path", () => {
    expect(
      toProjectRel(root, "D:\\gitRep\\ccDesktop\\docs\\通信架构评审意见.md"),
    ).toBe("docs/通信架构评审意见.md");
  });

  it("ignores drive-letter case", () => {
    expect(
      toProjectRel(root, "d:\\gitRep\\ccDesktop\\docs\\foo.md"),
    ).toBe("docs/foo.md");
  });

  it("keeps an already-relative path", () => {
    expect(toProjectRel(root, "docs/foo.md")).toBe("docs/foo.md");
  });

  it("strips a leading slash so POSIX-style tool paths stay in-project", () => {
    expect(toProjectRel(root, "/docs/foo.md")).toBe("docs/foo.md");
    expect(toProjectRel(root, "\\docs\\foo.md")).toBe("docs/foo.md");
  });

  it("unwraps a POSIX-wrapped Windows absolute path", () => {
    expect(
      toProjectRel(root, "/D:/gitRep/ccDesktop/docs/foo.md"),
    ).toBe("docs/foo.md");
  });

  it("maps Git-bash /d/proj paths to a project-relative path", () => {
    expect(
      toProjectRel(root, "/d/gitRep/ccDesktop/docs/通信架构补充条款.md"),
    ).toBe("docs/通信架构补充条款.md");
    expect(
      toProjectRel(root, "\\d\\gitRep\\ccDesktop\\docs\\通信架构补充条款.md"),
    ).toBe("docs/通信架构补充条款.md");
    expect(
      toProjectRel(root, "d/gitRep/ccDesktop/docs/通信架构补充条款.md"),
    ).toBe("docs/通信架构补充条款.md");
  });

  it("does not return a leading-slash relative (breaks Windows resolve)", () => {
    const stored = "\\docs\\foo.md";
    const rel = toProjectRel(root, stored);
    expect(rel).toBe("docs/foo.md");
    expect(rel?.startsWith("/")).toBe(false);
  });

  it("returns null for a path outside the project", () => {
    expect(toProjectRel(root, "C:\\Windows\\x.txt")).toBeNull();
    expect(toProjectRel(root, "D:\\other\\x.txt")).toBeNull();
  });

  it("returns null for a .. escape after collapse", () => {
    expect(
      toProjectRel(root, "D:\\gitRep\\ccDesktop\\docs\\..\\..\\outside.txt"),
    ).toBeNull();
  });

  it("does not treat ccDesk as a prefix of ccDesktop", () => {
    expect(
      toProjectRel("D:\\gitRep\\ccDesk", "D:\\gitRep\\ccDesktop\\docs\\a.md"),
    ).toBeNull();
  });
});

describe("resolvePath", () => {
  it("returns absolute Windows paths unchanged", () => {
    expect(resolvePath("D:\\proj", "D:\\proj\\a.ts")).toBe("D:\\proj\\a.ts");
  });

  it("joins a relative path with a slash", () => {
    expect(resolvePath("D:\\proj", "docs/a.md")).toBe("D:\\proj/docs/a.md");
  });
});
