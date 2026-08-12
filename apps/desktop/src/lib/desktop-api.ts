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

/** True when the running preload exposes a method (guards stale builds). */
export function hasDesktopApi<K extends keyof DesktopApi>(name: K): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean(window.desktop) &&
    typeof window.desktop[name] === "function"
  );
}

export type { DesktopApi };
