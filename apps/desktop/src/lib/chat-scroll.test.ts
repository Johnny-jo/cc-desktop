import { describe, expect, it } from "vitest";
import {
  contentEndScrollTopForMetrics,
  getTurnAnchorLayout,
  getTurnTrailingSpace,
  getTranscriptFollowTarget,
} from "./chat-scroll";

describe("contentEndScrollTopForMetrics", () => {
  it("keeps reserved turn space outside the viewport", () => {
    expect(contentEndScrollTopForMetrics(2500, 1000, 800)).toBe(700);
  });

  it("clamps short transcripts to the top", () => {
    expect(contentEndScrollTopForMetrics(1400, 1000, 800)).toBe(0);
  });
});

describe("adaptive turn positioning", () => {
  it("places the response at 55% of the area above the composer", () => {
    expect(getTurnAnchorLayout({
      viewportHeight: 1000, composerHeight: 200,
      statusTop: 900, naturalHeight: 1200,
    })).toEqual({ scrollTop: 460, leadingSpace: 0, trailingSpace: 260 });
  });

  it("adds only the leading room needed for a short first turn", () => {
    expect(getTurnAnchorLayout({
      viewportHeight: 1000, composerHeight: 200,
      statusTop: 100, naturalHeight: 400,
    })).toEqual({ scrollTop: 0, leadingSpace: 340, trailingSpace: 260 });
  });

  it("does not reserve 80% of the viewport when natural content already fills it", () => {
    expect(getTurnAnchorLayout({
      viewportHeight: 1000, composerHeight: 200,
      statusTop: 900, naturalHeight: 2000,
    }).trailingSpace).toBe(0);
  });

  it("accounts for the extra composer height occupied by progress buttons", () => {
    const before = getTurnAnchorLayout({ viewportHeight: 1000, composerHeight: 200, statusTop: 900, naturalHeight: 1200 });
    const after = getTurnAnchorLayout({ viewportHeight: 1000, composerHeight: 300, statusTop: 900, naturalHeight: 1300 });
    expect(after.scrollTop - before.scrollTop).toBe(55);
    expect(after.trailingSpace).toBe(215);
  });

  it("consumes reserved room as the answer grows and never reserves negative space", () => {
    expect(getTurnTrailingSpace(460, 1000, 1200)).toBe(260);
    expect(getTurnTrailingSpace(460, 1000, 1400)).toBe(60);
    expect(getTurnTrailingSpace(460, 1000, 1800)).toBe(0);
  });

  it("clamps unusable viewport dimensions without NaN layout values", () => {
    expect(getTurnAnchorLayout({ viewportHeight: 100, composerHeight: 200, statusTop: 10, naturalHeight: 120 }))
      .toEqual({ scrollTop: 10, leadingSpace: 0, trailingSpace: 0 });
  });
});

describe("manual history reading", () => {
  it("never requests a scroll while the reader has paused following", () => {
    expect(getTranscriptFollowTarget({ following: false, anchorScrollTop: 460, viewportHeight: 1000, naturalHeight: 2100 })).toBeNull();
  });

  it("holds the initial anchor while new content fits below it", () => {
    expect(getTranscriptFollowTarget({ following: true, anchorScrollTop: 460, viewportHeight: 1000, naturalHeight: 1200 })).toBe(460);
  });

  it("follows the real tail once content grows past the anchor", () => {
    expect(getTranscriptFollowTarget({ following: true, anchorScrollTop: 460, viewportHeight: 1000, naturalHeight: 1800 })).toBe(800);
  });

  it("jumps to the real content end without including artificial reserve", () => {
    expect(getTranscriptFollowTarget({ following: true, anchorScrollTop: null, viewportHeight: 1000, naturalHeight: 1800 })).toBe(800);
  });
});
