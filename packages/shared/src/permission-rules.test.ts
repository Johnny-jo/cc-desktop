import { describe, expect, it } from "vitest";
import {
  globMatch,
  isDestructiveBash,
  matchPersistedRule,
  matchPersistedRules,
  matchSessionRule,
  normalizeRuleString,
  parsePermissionRule,
  type SessionAllowRule,
} from "./permission-rules";

describe("isDestructiveBash", () => {
  it("flags rm -rf", () => {
    expect(isDestructiveBash("rm -rf /tmp/foo")).toBe(true);
  });
  it("allows harmless command", () => {
    expect(isDestructiveBash("ls -la")).toBe(false);
  });
});

describe("matchSessionRule", () => {
  const rules: SessionAllowRule[] = [
    { toolName: "Edit", pathPrefix: "src/" },
    { toolName: "Bash", commandPrefix: "git status" },
  ];

  it("matches Edit under path prefix", () => {
    expect(
      matchSessionRule(rules, {
        toolName: "Edit",
        path: "src/a.ts",
      }),
    ).toBe(true);
  });

  it("rejects Edit outside prefix", () => {
    expect(
      matchSessionRule(rules, {
        toolName: "Edit",
        path: "docs/a.md",
      }),
    ).toBe(false);
  });
});

describe("parsePermissionRule", () => {
  it("parses bare tool name", () => {
    expect(parsePermissionRule("Edit")).toEqual({ toolName: "Edit" });
  });

  it("parses tool with glob spec", () => {
    expect(parsePermissionRule("Bash(npm run *)")).toEqual({
      toolName: "Bash",
      spec: "npm run *",
    });
    expect(parsePermissionRule("Edit(src/**)")).toEqual({
      toolName: "Edit",
      spec: "src/**",
    });
  });

  it("rejects empty / malformed rules", () => {
    expect(parsePermissionRule("")).toBeNull();
    expect(parsePermissionRule("  ")).toBeNull();
    expect(parsePermissionRule("Edit(")).toBeNull();
    expect(parsePermissionRule("()")).toBeNull();
  });
});

describe("globMatch", () => {
  it("matches * across segments", () => {
    expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatch("npm run *", "npm run build")).toBe(true);
    expect(globMatch("npm run *", "npm test")).toBe(false);
  });
});

describe("matchPersistedRule", () => {
  it("bare tool name matches any input of that tool", () => {
    expect(
      matchPersistedRule({ toolName: "Edit" }, { toolName: "Edit", path: "x" }),
    ).toBe(true);
    expect(
      matchPersistedRule({ toolName: "Edit" }, { toolName: "Write", path: "x" }),
    ).toBe(false);
  });

  it("path glob matches normalized paths", () => {
    const rule = { toolName: "Edit", spec: "src/**" };
    expect(
      matchPersistedRule(rule, { toolName: "Edit", path: "src/a/b.ts" }),
    ).toBe(true);
    expect(
      matchPersistedRule(rule, { toolName: "Edit", path: "src\\a\\b.ts" }),
    ).toBe(true);
    expect(
      matchPersistedRule(rule, { toolName: "Edit", path: "test/a.ts" }),
    ).toBe(false);
  });

  it("command glob matches pattern; non-wildcard spec is a prefix", () => {
    expect(
      matchPersistedRule(
        { toolName: "Bash", spec: "npm run *" },
        { toolName: "Bash", command: "npm run build" },
      ),
    ).toBe(true);
    expect(
      matchPersistedRule(
        { toolName: "Bash", spec: "git status" },
        { toolName: "Bash", command: "git status -s" },
      ),
    ).toBe(true);
    expect(
      matchPersistedRule(
        { toolName: "Bash", spec: "git status" },
        { toolName: "Bash", command: "git diff" },
      ),
    ).toBe(false);
  });
});

describe("matchPersistedRules / normalizeRuleString", () => {
  it("matches any rule in the list", () => {
    expect(
      matchPersistedRules(["Edit(src/**)", "Bash(npm *)"], {
        toolName: "Bash",
        command: "npm test",
      }),
    ).toBe(true);
  });

  it("normalizes rule strings and rejects invalid", () => {
    expect(normalizeRuleString("  Edit(src/**)  ")).toBe("Edit(src/**)");
    expect(normalizeRuleString("Bash(npm run *)")).toBe("Bash(npm run *)");
    expect(normalizeRuleString("bad(")).toBeNull();
    expect(normalizeRuleString("")).toBeNull();
  });
});
