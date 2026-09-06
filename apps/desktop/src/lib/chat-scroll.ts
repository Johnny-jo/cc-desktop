/**
 * Return the scrollTop that aligns the real content end with the viewport end.
 * Reserved layout space is intentionally excluded from the scroll target.
 */
export function contentEndScrollTopForMetrics(
  scrollHeight: number,
  clientHeight: number,
  reservedSpace: number,
): number {
  return Math.max(0, scrollHeight - reservedSpace - clientHeight);
}

export const TURN_RESPONSE_VIEWPORT_Y = 0.55;
export const CHAT_COMPOSER_CLEARANCE = 24;

/** Space required to keep an initial reading position, not a fixed screenful. */
export function getTurnTrailingSpace(
  scrollTop: number,
  viewportHeight: number,
  naturalHeight: number,
): number {
  return Math.max(0, Math.round(scrollTop + viewportHeight - naturalHeight));
}

/** All positions are relative to the transcript's content box before reserves. */
export function getTurnAnchorLayout(metrics: {
  viewportHeight: number;
  composerHeight: number;
  statusTop: number;
  naturalHeight: number;
}): { scrollTop: number; leadingSpace: number; trailingSpace: number } {
  const visibleHeight = Math.max(0, metrics.viewportHeight - metrics.composerHeight);
  const desiredTop = Math.round(visibleHeight * TURN_RESPONSE_VIEWPORT_Y);
  const leadingSpace = Math.max(0, desiredTop - metrics.statusTop);
  const scrollTop = Math.max(0, metrics.statusTop - desiredTop);
  return {
    scrollTop,
    leadingSpace,
    trailingSpace: getTurnTrailingSpace(
      scrollTop, metrics.viewportHeight, metrics.naturalHeight + leadingSpace,
    ),
  };
}

/** Null means the reader owns scrolling; no layout update may steal it. */
export function getTranscriptFollowTarget(metrics: {
  following: boolean;
  anchorScrollTop: number | null;
  viewportHeight: number;
  naturalHeight: number;
}): number | null {
  if (!metrics.following) return null;
  const tail = Math.max(0, metrics.naturalHeight - metrics.viewportHeight);
  return metrics.anchorScrollTop === null ? tail : Math.max(metrics.anchorScrollTop, tail);
}
