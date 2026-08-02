import { describe, expect, it } from "vitest";
import {
  isDestructiveBash,
  matchSessionRule,
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
