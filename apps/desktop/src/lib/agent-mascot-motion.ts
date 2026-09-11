type Point = { x: number; y: number; time: number };

/** Recognizes a short, deliberate mouse shake; the caller owns any cooldown. */
export function createDizzyDetector() {
  const windowMs = 1000;
  const pauseMs = 180;
  const minSpeed = 0.45; // CSS pixels per millisecond, independent of display density.
  // Small batches retain short strokes at low event rates; minStroke below
  // still rejects jitter without mistaking its direction changes for a shake.
  const minSegment = 8;
  const minStroke = 32;
  let anchor: Point | undefined;
  let lastTime: number | undefined;
  let lastFastTime: number | undefined;
  let direction: { x: number; y: number } | undefined;
  let strokeDistance = 0;
  let distance = 0;
  let segments: { time: number; distance: number }[] = [];
  let turns: number[] = [];

  const clearShake = () => {
    direction = undefined;
    strokeDistance = 0;
    lastFastTime = undefined;
    distance = 0;
    segments = [];
    turns = [];
  };
  const reset = () => {
    anchor = undefined;
    lastTime = undefined;
    clearShake();
  };

  return {
    reset,
    sample(x: number, y: number, time: number): boolean {
      if (![x, y, time].every(Number.isFinite)) {
        reset();
        return false;
      }
      // Ignore duplicate/out-of-order events without moving the sampling anchor.
      if (lastTime !== undefined && time <= lastTime) return false;
      if (!anchor || (lastTime !== undefined && time - lastTime > pauseMs)) {
        clearShake();
        anchor = { x, y, time };
        lastTime = time;
        return false;
      }
      lastTime = time;
      const dx = x - anchor.x;
      const dy = y - anchor.y;
      const length = Math.hypot(dx, dy);
      const elapsed = time - anchor.time;
      // Aggregate tiny pointer events so high polling rates and coordinate noise
      // do not create extra turns. A lingering pointer also ends the gesture.
      if (length < minSegment && elapsed < 64) return false;
      anchor = { x, y, time };
      if (length < minSegment || length / elapsed < minSpeed) {
        // A real hand briefly decelerates at each turn. Preserve that turn
        // through a short slowdown, while sustained slow motion ends the shake.
        if (lastFastTime === undefined || time - lastFastTime >= pauseMs) clearShake();
        return false;
      }
      if (lastFastTime !== undefined && time - lastFastTime >= pauseMs) clearShake();
      lastFastTime = time;

      const cutoff = time - windowMs;
      while (segments.length && segments[0].time < cutoff) distance -= segments.shift()!.distance;
      turns = turns.filter((turn) => turn >= cutoff);
      segments.push({ time, distance: length });
      distance += length;
      const next = { x: dx / length, y: dy / length };
      if (direction && direction.x * next.x + direction.y * next.y < -0.5) {
        if (strokeDistance >= minStroke) turns.push(time);
        strokeDistance = length;
      } else {
        strokeDistance += length;
      }
      direction = next;

      if (turns.length >= 2 && distance >= 200) {
        reset();
        return true;
      }
      return false;
    },
  };
}
