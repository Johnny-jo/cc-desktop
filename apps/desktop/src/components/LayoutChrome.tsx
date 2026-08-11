import React from "react";

export type LayoutChromeProps = {
  sidebarOpen: boolean;
  changesOpen: boolean;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleChanges: () => void;
  onToggleTerminal: () => void;
};

/**
 * Codex-style edge controls: collapse/expand sidebar, changes, and terminal.
 * Sits in a fixed rail so toggles stay available when panels are hidden.
 */
export function LayoutChrome({
  sidebarOpen,
  changesOpen,
  terminalOpen,
  onToggleSidebar,
  onToggleChanges,
  onToggleTerminal,
}: LayoutChromeProps) {
  return (
    <>
      <div className="edge-rail edge-rail-left" role="toolbar" aria-label="Sidebar">
        <button
          type="button"
          className="edge-btn"
          title={sidebarOpen ? "收起会话列表" : "展开会话列表"}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          {sidebarOpen ? "⟨" : "⟩"}
        </button>
      </div>

      <div className="edge-rail edge-rail-right" role="toolbar" aria-label="Changes">
        <button
          type="button"
          className="edge-btn"
          title={changesOpen ? "收起 Changes" : "展开 Changes"}
          aria-pressed={changesOpen}
          onClick={onToggleChanges}
        >
          {changesOpen ? "⟩" : "⟨"}
        </button>
      </div>

      <div className="edge-rail edge-rail-bottom" role="toolbar" aria-label="Terminal">
        <button
          type="button"
          className="edge-btn edge-btn-wide"
          title={terminalOpen ? "收起终端" : "展开终端"}
          aria-pressed={terminalOpen}
          onClick={onToggleTerminal}
        >
          {terminalOpen ? "▾ Terminal" : "▴ Terminal"}
        </button>
      </div>
    </>
  );
}

type ResizeAxis = "sidebar" | "changes" | "terminal";

export function ResizeHandle({
  axis,
  onDrag,
}: {
  axis: ResizeAxis;
  onDrag: (delta: number) => void;
}) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let lastX = e.clientX;
    let lastY = e.clientY;

    const onMove = (ev: PointerEvent) => {
      if (axis === "terminal") {
        const dy = lastY - ev.clientY; // drag up → taller terminal
        lastY = ev.clientY;
        if (dy !== 0) onDrag(dy);
      } else if (axis === "sidebar") {
        const dx = ev.clientX - lastX;
        lastX = ev.clientX;
        if (dx !== 0) onDrag(dx);
      } else {
        // changes: drag handle on left edge of panel; moving left grows width
        const dx = lastX - ev.clientX;
        lastX = ev.clientX;
        if (dx !== 0) onDrag(dx);
      }
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
