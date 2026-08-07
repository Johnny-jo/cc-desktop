import { describe, expect, it } from "vitest";
import {
  CONTEXT_LIMIT_MAX,
  CONTEXT_LIMIT_MIN,
  buildModelContextLimitsPatch,
  parseContextLimitInput,
} from "./model-context-limits";

describe("parseContextLimitInput", () => {
  it("treats empty as clear", () => {
    expect(parseContextLimitInput("")).toEqual({ kind: "clear" });
    expect(parseContextLimitInput("   ")).toEqual({ kind: "clear" });
  });

  it("accepts integers in range", () => {
    expect(parseContextLimitInput("256000")).toEqual({
      kind: "value",
      value: 256000,
    });
    expect(parseContextLimitInput("1024.9")).toEqual({
      kind: "value",
      value: 1024,
    });
  });

  it("rejects out of range and non-numeric", () => {
    expect(parseContextLimitInput("abc").kind).toBe("error");
    expect(parseContextLimitInput(String(CONTEXT_LIMIT_MIN - 1)).kind).toBe(
      "error",
    );
    expect(parseContextLimitInput(String(CONTEXT_LIMIT_MAX + 1)).kind).toBe(
      "error",
    );
  });
});

describe("buildModelContextLimitsPatch", () => {
  it("sets override for visible model", () => {
    const res = buildModelContextLimitsPatch({
      existing: {},
      visibleIds: ["k3", "grok-4.5"],
      draft: { k3: "256000", "grok-4.5": "" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.modelContextLimits).toEqual({ k3: 256000 });
    }
  });

  it("clears override for visible model and keeps orphan keys", () => {
    const res = buildModelContextLimitsPatch({
      existing: { k3: 256000, "old-model": 64000 },
      visibleIds: ["k3"],
      draft: { k3: "" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.modelContextLimits).toEqual({ "old-model": 64000 });
    }
  });

  it("returns error without mutating when one row invalid", () => {
    const res = buildModelContextLimitsPatch({
      existing: { k3: 100000 },
      visibleIds: ["k3", "grok-4.5"],
      draft: { k3: "200000", "grok-4.5": "nope" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/grok-4.5/i);
    }
  });
});
