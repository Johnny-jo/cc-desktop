import { describe, expect, it } from "vitest";
import { contentEndScrollTopForMetrics } from "./chat-scroll";

describe("contentEndScrollTopForMetrics", () => {
  it("keeps reserved turn space outside the viewport", () => {
    expect(contentEndScrollTopForMetrics(2500, 1000, 800)).toBe(700);
  });

  it("clamps short transcripts to the top", () => {
    expect(contentEndScrollTopForMetrics(1400, 1000, 800)).toBe(0);
  });
});
