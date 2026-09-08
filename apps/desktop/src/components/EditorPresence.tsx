import React, { useLayoutEffect, useRef } from "react";
import { useMotionPresence } from "../hooks/useMotionPresence";

/** Retain the last open view during exit without delaying file/tab state changes. */
export function EditorPresence({ open, children }: { open: boolean; children: React.ReactNode }) {
  const mounted = useMotionPresence(open, 220);
  const lastView = useRef(children);
  useLayoutEffect(() => {
    if (open) lastView.current = children;
    else if (!mounted) lastView.current = null;
  }, [open, mounted, children]);
  return mounted ? <div className={`editor-presence${open ? "" : " is-exiting"}`} inert={!open}>
    {open ? children : lastView.current}
  </div> : null;
}
