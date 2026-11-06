type Point = { x: number; y: number };
type Sample = Point & { distance: number; curveIndex: number; t: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Advance the collection only when a card loops beyond an offscreen endpoint. */
export function photoFlowImageIndex(slot: number, cycle: number, slots: number, imageCount: number) {
  return ((slot - cycle * slots) % imageCount + imageCount) % imageCount;
}

/** An open S ribbon: its two ends sit outside the pane so cards can loop unseen. */
export function createPhotoFlowPath(width: number, height: number) {
  // Draw one rounded bowl, then rotate it around the pane's center to form
  // the other. Both halves retain identical radii, margins and tangent handles.
  const firstHalf = [
    [[0.10, -Math.max(0.28, 260 / height)], [0.10, -0.04], [0.10, 0.19], [0.10, 0.43]],
    [[0.10, 0.43], [0.10, 0.67], [0.172, 0.84], [0.285, 0.84]],
    [[0.285, 0.84], [0.398, 0.84], [0.449, 0.67], [0.50, 0.50]],
  ];
  const curves = [...firstHalf, ...firstHalf.slice().reverse().map(curve =>
    curve.slice().reverse().map(([x, y]) => [1 - x, 1 - y]),
  )].map(curve => curve.map(([x, y]) => ({ x: x * width, y: y * height })));
  const pointAt = (curveIndex: number, t: number) => {
    const [a, b, c, d] = curves[curveIndex];
    const u = 1 - t;
    const x = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x;
    const y = u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y;
    // Use the curve's continuous derivative, not the direction of a sampled
    // chord: at idle speed a chord otherwise holds its angle for many frames.
    const dx = u * u * (b.x - a.x) + 2 * u * t * (c.x - b.x) + t * t * (d.x - c.x);
    const dy = u * u * (b.y - a.y) + 2 * u * t * (c.y - b.y) + t * t * (d.y - c.y);
    return { x, y, tilt: clamp(dx / Math.max(0.001, Math.hypot(dx, dy)) * -18, -18, 18) };
  };
  const stepsPerCurve = 100;
  const samples: Sample[] = [];
  let length = 0;
  for (let curveIndex = 0; curveIndex < curves.length; curveIndex++) {
    for (let step = samples.length ? 1 : 0; step <= stepsPerCurve; step++) {
      const t = step / stepsPerCurve;
      const { x, y } = pointAt(curveIndex, t);
      const previous = samples.at(-1);
      if (previous) length += Math.hypot(x - previous.x, y - previous.y);
      samples.push({ x, y, distance: length, curveIndex, t });
    }
  }
  return {
    length,
    samples,
    at(distance: number) {
      const wrapped = ((distance % length) + length) % length;
      let low = 1;
      let high = samples.length - 1;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (samples[mid].distance < wrapped) low = mid + 1;
        else high = mid;
      }
      const a = samples[low - 1];
      const b = samples[low];
      const fraction = (wrapped - a.distance) / Math.max(0.001, b.distance - a.distance);
      // The lookup table only maps distance to a parameter. Both position and
      // orientation are evaluated on the actual Bezier at that parameter.
      return pointAt(b.curveIndex, b.t - (1 - fraction) / stepsPerCurve);
    },
  };
}

/** Wheel impulses ease in, decay, and have a hard speed cap (pixels / second). */
export function createPhotoFlowMotion() {
  let impulse = 0;
  let velocity = 0;
  let quietTime = 10;
  return {
    push(delta: number) {
      impulse = clamp(impulse + clamp(delta, -160, 160) * 0.65, -190, 190);
      quietTime = 0;
    },
    step(seconds: number, autoplay: boolean) {
      const dt = clamp(seconds, 0, 0.05);
      quietTime += dt;
      impulse *= Math.exp(-dt / 0.48);
      const drift = autoplay ? 10 * clamp((quietTime - 0.8) / 1.2, 0, 1) : 0;
      velocity += (impulse + drift - velocity) * (1 - Math.exp(-dt / 0.16));
      if (!autoplay && Math.abs(impulse) < 0.02 && Math.abs(velocity) < 0.02) {
        impulse = 0;
        velocity = 0;
      }
      return velocity * dt;
    },
    moving: () => Math.abs(impulse) > 0.02 || Math.abs(velocity) > 0.02,
    reset() { impulse = 0; velocity = 0; quietTime = 10; },
  };
}
