import type { DesktopApi } from "../../electron/preload/index";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export function getDesktop(): DesktopApi {
  if (!window.desktop) {
    throw new Error("desktop API missing");
  }
  return window.desktop;
}

export type { DesktopApi };
