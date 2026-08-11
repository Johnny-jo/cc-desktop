import React, { useRef } from "react";

export type LayoutChromeProps = {
  sidebarOpen: boolean;
  changesOpen: boolean;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleChanges: () => void;
  onToggleTerminal: () => void;
};

/*
 * Reference-style panel icons: thin ~1px strokes on a 3:4 rounded rectangle
 * (x 4.5–13.5, y 3.5–14.5, r 2). A filled segment marks the "on" panel side.
 */

/** 会话 (sidebar left): left segment filled when open. */
function IconSidebar({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      {active ? (
        <path
          d="M4.5 5.5 a2 2 0 0 1 2 -2 H6.8 V14.5 H6.5 a2 2 0 0 1 -2 -2 Z"
          fill="currentColor"
        />
      ) : null}
      <rect
        x="4.5"
        y="3.5"
        width="9"
        height="11"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      {!active ? (
        <path d="M7.2 3.5v11" stroke="currentColor" strokeWidth="1.1" />
      ) : null}
    </svg>
  );
}

/** 变更 (panel right): right segment filled when open. */
function IconChanges({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      {active ? (
        <path
          d="M13.5 5.5 a2 2 0 0 0 -2 -2 H11.2 V14.5 H11.5 a2 2 0 0 0 2 -2 Z"
          fill="currentColor"
        />
      ) : null}
      <rect
        x="4.5"
        y="3.5"
        width="9"
        height="11"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      {!active ? (
        <path d="M10.8 3.5v11" stroke="currentColor" strokeWidth="1.1" />
      ) : null}
    </svg>
  );
}

/** 终端 (panel bottom): bottom segment filled when open. */
function IconTerminal({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
      {active ? (
        <path
          d="M4.5 12.2 V12.5 a2 2 0 0 0 2 2 H11.5 a2 2 0 0 0 2 -2 V12.2 Z"
          fill="currentColor"
        />
      ) : null}
      <rect
        x="4.5"
        y="3.5"
        width="9"
        height="11"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.1"
      />
      {!active ? (
        <path d="M4.5 12.2h9" stroke="currentColor" strokeWidth="1.1" />
      ) : null}
    </svg>
  );
}

export function TitlebarToggles({
  sidebarOpen,
  changesOpen,
  terminalOpen,
  onToggleSidebar,
  onToggleChanges,
  onToggleTerminal,
}: LayoutChromeProps) {
  return (
    <div className="titlebar-toggles" role="toolbar" aria-label="面板">
      <button
        type="button"
        className={sidebarOpen ? "titlebar-btn active" : "titlebar-btn"}
        title={sidebarOpen ? "收起会话" : "展开会话"}
        aria-label="会话"
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
      >
        <IconSidebar active={sidebarOpen} />
      </button>
      <button
        type="button"
        className={changesOpen ? "titlebar-btn active" : "titlebar-btn"}
        title={changesOpen ? "收起变更" : "展开变更"}
        aria-label="变更"
        aria-pressed={changesOpen}
        onClick={onToggleChanges}
      >
        <IconChanges active={changesOpen} />
      </button>
      <button
        type="button"
        className={terminalOpen ? "titlebar-btn active" : "titlebar-btn"}
        title={terminalOpen ? "收起终端" : "展开终端"}
        aria-label="终端"
        aria-pressed={terminalOpen}
        onClick={onToggleTerminal}
      >
        <IconTerminal active={terminalOpen} />
      </button>
    </div>
  );
}

type ResizeAxis = "sidebar" | "changes" | "terminal";

/**
 * Resize grip. Uses start-position + start-size so every move sets an absolute
 * size (no stale React state / dropped deltas).
 */
export function ResizeHandle({
  axis,
  /** Current size in px (width for sidebar/changes, height for terminal). */
  size,
  onResize,
}: {
  axis: ResizeAxis;
  size: number;
  onResize: (nextSize: number) => void;
}) {
  const startRef = useRef({ pos: 0, size: 0 });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only primary button
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // ignore
    }
    // Capture size at drag start (absolute math — no stale React state).
    startRef.current = {
      pos: axis === "terminal" ? e.clientY : e.clientX,
      size,
    };
    document.body.classList.add(
      axis === "terminal" ? "is-resizing-row" : "is-resizing-col",
    );

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      const { pos, size: startSize } = startRef.current;
      if (axis === "terminal") {
        onResize(startSize + (pos - ev.clientY));
      } else if (axis === "sidebar") {
        onResize(startSize + (ev.clientX - pos));
      } else {
        // changes: grip is LEFT of panel; drag left → wider
        onResize(startSize + (pos - ev.clientX));
      }
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        // ignore
      }
      document.body.classList.remove("is-resizing-col", "is-resizing-row");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      className={`resize-handle resize-handle-${axis}`}
      role="separator"
      aria-orientation={axis === "terminal" ? "horizontal" : "vertical"}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onDragStart={(e) => e.preventDefault()}
    />
  );
}
