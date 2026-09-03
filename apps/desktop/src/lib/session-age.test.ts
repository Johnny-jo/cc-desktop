import { describe, expect, it } from "vitest";
import { formatSessionAge } from "./session-age";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 500 * DAY;

describe("formatSessionAge", () => {
  it.each([
    [0, "1d"],
    [1, "1d"],
    [6, "6d"],
    [7, "1w"],
    [21, "3w"],
    [30, "1mo"],
    [60, "2mo"],
    [90, "3mo"],
    [270, "9mo"],
    [360, "12mo"],
    [361, "1y"],
    [720, "2y"],
  ])("formats %i elapsed days as %s", (days, expected) => {
    expect(formatSessionAge(NOW - days * DAY, NOW)).toBe(expected);
  });
});
