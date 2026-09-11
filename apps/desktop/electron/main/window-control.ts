import type { BrowserWindow } from "electron";

export function controlWindow(win: Pick<BrowserWindow, "isDestroyed" | "isMaximized" | "minimize" | "maximize" | "unmaximize" | "close"> | null, action: string) {
  if (!win || win.isDestroyed()) return { ok: false, maximized: false };
  if (action === "minimize") win.minimize();
  else if (action === "maximize") {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  } else if (action === "close") {
    win.close();
    return { ok: true, maximized: false };
  } else if (action !== "state") return { ok: false, maximized: win.isMaximized() };
  return { ok: true, maximized: win.isMaximized() };
}
