import React, { useRef } from "react";

export type LayoutChromeProps = {
  sidebarOpen: boolean;
  changesOpen: boolean;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleChanges: () => void;
  onToggleTerminal: () => void;
};

function IconSidebar({ active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect
        x="2.75"
        y="3.75"
        width="14.5"
        height="12.5"
        rx="3.25"
        stroke="currentColor"
        strokeWidth="1.5"
        fill={active ? "currentColor" : "none"}
        fillOpacity={active ? 0.14 : 0}
      />
      <path
        d="M8 3.75v12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconChanges({ active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect
        x="3.75"
        y="3.75"
        width="12.5"
        height="12.5"
        rx="3.25"
        stroke="currentColor"
        strokeWidth="1.5"
        fill={active ? "currentColor" : "none"}
        fillOpacity={active ? 0.14 : 0}
      />
    </svg>
  );
}

function IconTerminal({ active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <rect
        x="2.75"
        y="6"
        width="14.5"
        height="8"
        rx="2.75"
        stroke="currentColor"
        strokeWidth="1.5"
        fill={active ? "currentColor" : "none"}
        fillOpacity={active ? 0.14 : 0}
      />
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
