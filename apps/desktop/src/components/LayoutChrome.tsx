import React from "react";

export type LayoutChromeProps = {
  sidebarOpen: boolean;
  changesOpen: boolean;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleChanges: () => void;
  onToggleTerminal: () => void;
};

/** 会话：圆角框 + 左侧竖条（侧栏） */
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
        fillOpacity={active ? 0.12 : 0}
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

/** 变更：空心圆角方框 */
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
        fillOpacity={active ? 0.12 : 0}
      />
    </svg>
  );
}

/** 终端：横向圆角条 */
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
        fillOpacity={active ? 0.12 : 0}
      />
    </svg>
  );
}

/**
 * Panel toggles in the frameless title bar (icon-only, reference style).
 */
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
 * Drag handle. onDrag receives delta since last move; parent must use
 * functional state updates (prev + delta).
 */
export function ResizeHandle({
  axis,
  onDrag,
}: {
  axis: ResizeAxis;
  onDrag: (delta: number) => void;
}) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add(
      axis === "terminal" ? "is-resizing-row" : "is-resizing-col",
    );
    let lastX = e.clientX;
    let lastY = e.clientY;

    const onMove = (ev: PointerEvent) => {
      ev.preventDefault();
      if (axis === "terminal") {
        const dy = lastY - ev.clientY;
        lastY = ev.clientY;
        if (dy !== 0) onDrag(dy);
      } else if (axis === "sidebar") {
        const dx = ev.clientX - lastX;
        lastX = ev.clientX;
        if (dx !== 0) onDrag(dx);
      } else {
        // changes: handle sits left of panel; drag left → wider
        const dx = lastX - ev.clientX;
        lastX = ev.clientX;
        if (dx !== 0) onDrag(dx);
      }
    };
    const onUp = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      document.body.classList.remove("is-resizing-col", "is-resizing-row");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      className={`resize-handle resize-handle-${axis}`}
      role="separator"
      aria-orientation={axis === "terminal" ? "horizontal" : "vertical"}
      onPointerDown={onPointerDown}
    />
  );
}
