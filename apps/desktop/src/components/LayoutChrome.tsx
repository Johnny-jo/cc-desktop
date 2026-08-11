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
 * Panel toggles live in the frameless title bar (Codex-style top chrome).
 * Resize handles stay between panels.
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
        title={sidebarOpen ? "收起会话列表" : "展开会话列表"}
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
      >
        会话
      </button>
      <button
        type="button"
        className={changesOpen ? "titlebar-btn active" : "titlebar-btn"}
        title={changesOpen ? "收起 Changes" : "展开 Changes"}
        aria-pressed={changesOpen}
        onClick={onToggleChanges}
      >
        Changes
      </button>
      <button
        type="button"
        className={terminalOpen ? "titlebar-btn active" : "titlebar-btn"}
        title={terminalOpen ? "收起终端" : "展开终端"}
        aria-pressed={terminalOpen}
        onClick={onToggleTerminal}
      >
        Terminal
      </button>
    </div>
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
        const dy = lastY - ev.clientY;
        lastY = ev.clientY;
        if (dy !== 0) onDrag(dy);
      } else if (axis === "sidebar") {
        const dx = ev.clientX - lastX;
        lastX = ev.clientX;
        if (dx !== 0) onDrag(dx);
      } else {
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
