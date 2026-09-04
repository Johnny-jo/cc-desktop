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
