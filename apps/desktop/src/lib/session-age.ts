const DAY_MS = 24 * 60 * 60 * 1000;

/** Compact age used by the session sidebar. Months stay explicit through 12mo. */
export function formatSessionAge(updatedAt: number, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - updatedAt) / DAY_MS));

  if (days < 7) return `${Math.max(1, days)}d`;
  if (days < 30) return `${Math.max(1, Math.floor(days / 7))}w`;
  if (days <= 360) return `${Math.max(1, Math.floor(days / 30))}mo`;
  return `${Math.max(1, Math.floor(days / 360))}y`;
}
