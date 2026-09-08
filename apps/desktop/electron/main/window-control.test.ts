import { expect, it, vi } from "vitest";
import { controlWindow } from "./window-control";

it("minimizes, toggles maximize/restore, and uses normal close", () => {
  let maximized = false;
  const win = { isDestroyed: () => false, isMaximized: () => maximized,
    minimize: vi.fn(), maximize: vi.fn(() => { maximized = true; }),
    unmaximize: vi.fn(() => { maximized = false; }), close: vi.fn() };
  expect(controlWindow(win, "maximize")).toEqual({ ok: true, maximized: true });
  expect(controlWindow(win, "maximize")).toEqual({ ok: true, maximized: false });
  controlWindow(win, "minimize");
  controlWindow(win, "close");
  expect(win.minimize).toHaveBeenCalledOnce();
  expect(win.close).toHaveBeenCalledOnce();
  expect(controlWindow(win, "invalid").ok).toBe(false);
  expect(controlWindow(null, "close").ok).toBe(false);
});
