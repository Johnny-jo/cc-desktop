import { useEffect, useState } from "react";

export const EXIT_DURATION_MS = 200;

/** Keep outgoing UI mounted long enough to animate; reopening cancels removal. */
export function useMotionPresence(open: boolean, duration = EXIT_DURATION_MS): boolean {
  const [retained, setRetained] = useState(open);
  useEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setRetained(false);
      return;
    }
    const timer = window.setTimeout(() => setRetained(false), duration);
    return () => window.clearTimeout(timer);
  }, [open, duration]);
  return open || retained;
}
