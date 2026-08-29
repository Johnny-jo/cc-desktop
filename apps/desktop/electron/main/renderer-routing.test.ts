import { describe, expect, it } from "vitest";
import { acceptsRoom, acceptsSession } from "./renderer-routing";

describe("renderer routing", () => {
  it("sends session streams only to main and the matching detached session", () => {
    expect(acceptsSession({ kind: "main" }, "s1")).toBe(true);
    expect(
      acceptsSession({ kind: "session", sessionId: "s1" }, "s1"),
    ).toBe(true);
    expect(
      acceptsSession({ kind: "session", sessionId: "s2" }, "s1"),
    ).toBe(false);
    expect(acceptsSession({ kind: "room", roomId: "r1" }, "s1")).toBe(false);
    expect(
      acceptsSession({ kind: "room", roomId: "r1" }, "s1", "r1"),
    ).toBe(true);
  });

  it("sends room streams only to main and the matching detached room", () => {
    expect(acceptsRoom({ kind: "main" }, "r1")).toBe(true);
    expect(acceptsRoom({ kind: "room", roomId: "r1" }, "r1")).toBe(true);
    expect(acceptsRoom({ kind: "room", roomId: "r2" }, "r1")).toBe(false);
    expect(
      acceptsRoom({ kind: "session", sessionId: "s1" }, "r1"),
    ).toBe(false);
  });
});
