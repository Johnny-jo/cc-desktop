import React, { useEffect, useState } from "react";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState("");
  const available = typeof window.desktop?.controlWindow === "function";
  useEffect(() => {
    if (!available) return;
    let mounted = true;
    const refresh = () => {
      void window.desktop.controlWindow("state").then((result) => {
        if (mounted && result.ok) setMaximized(result.maximized);
      }).catch(() => undefined);
    };
    refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      mounted = false;
      window.removeEventListener("resize", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [available]);
  // An older preload still has native buttons; don't overlap them during HMR.
  if (!available) return <div className="titlebar-caption-space" aria-hidden />;
  const act = async (action: "minimize" | "maximize" | "close") => {
    try {
      const result = await window.desktop.controlWindow(action);
      if (result.ok) { setMaximized(result.maximized); setError(""); }
      else setError("窗口操作失败");
    } catch { setError("窗口操作失败，请完整重启应用"); }
  };
  return <div className="window-controls" role="group" aria-label="窗口控制" title={error || undefined}>
    <button type="button" aria-label="最小化" title="最小化" onClick={() => void act("minimize")}><svg viewBox="0 0 12 12" aria-hidden><path d="M1 6h10" /></svg></button>
    <button type="button" aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"} onClick={() => void act("maximize")}><svg viewBox="0 0 12 12" aria-hidden>{maximized ? <path d="M3 3V1h8v8H9M1 3h8v8H1Z" /> : <rect x="1.5" y="1.5" width="9" height="9" />}</svg></button>
    <button type="button" className="window-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => void act("close")}><svg viewBox="0 0 12 12" aria-hidden><path d="m1 1 10 10M11 1 1 11" /></svg></button>
  </div>;
}
