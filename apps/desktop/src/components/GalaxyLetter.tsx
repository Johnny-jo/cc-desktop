import React, { useEffect, useRef } from "react";
import { attachGalaxyCanvas } from "../lib/galaxy-canvas";
import "./GalaxyLetter.css";

/** The scene lives in the chat pane, independent of the clickable wordmark. */
export function GalaxyLetter({ enabled = true }: { enabled?: boolean }) {
  const mark = useRef<HTMLSpanElement>(null);
  const letter = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = mark.current;
    const glyph = letter.current;
    const panel = root?.closest<HTMLElement>(".chat-panel");
    if (!enabled || !root || !glyph || !panel) return;
    const canvas = document.createElement("canvas");
    canvas.className = "galaxy-scene";
    canvas.setAttribute("aria-hidden", "true");
    panel.prepend(canvas);
    const dispose = attachGalaxyCanvas(root, canvas, glyph, panel);
    return () => { dispose(); canvas.remove(); };
  }, [enabled]);
  return <span ref={mark} className="agent-letter galaxy-letter">
    <span ref={letter} className="galaxy-letter-base">S</span>
  </span>;
}
