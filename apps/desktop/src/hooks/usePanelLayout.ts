import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "claude-desktop.panel-layout.v1";

export type PanelLayout = {
  sidebarOpen: boolean;
  changesOpen: boolean;
  terminalOpen: boolean;
  sidebarWidth: number;
  changesWidth: number;
  terminalHeight: number;
};

const DEFAULTS: PanelLayout = {
  sidebarOpen: true,
  changesOpen: true,
  terminalOpen: false,
  sidebarWidth: 260,
  changesWidth: 300,
  terminalHeight: 180,
};

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const CHANGES_MIN = 220;
const CHANGES_MAX = 560;
const TERMINAL_MIN = 100;
/** Cap so the chat composer is never fully covered. */
const TERMINAL_MAX = 260;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function load(): PanelLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PanelLayout>;
    return {
      sidebarOpen: parsed.sidebarOpen ?? DEFAULTS.sidebarOpen,
      changesOpen: parsed.changesOpen ?? DEFAULTS.changesOpen,
      terminalOpen: parsed.terminalOpen ?? DEFAULTS.terminalOpen,
      sidebarWidth: clamp(
        Number(parsed.sidebarWidth) || DEFAULTS.sidebarWidth,
        SIDEBAR_MIN,
        SIDEBAR_MAX,
      ),
      changesWidth: clamp(
        Number(parsed.changesWidth) || DEFAULTS.changesWidth,
        CHANGES_MIN,
        CHANGES_MAX,
      ),
      terminalHeight: clamp(
        Number(parsed.terminalHeight) || DEFAULTS.terminalHeight,
        TERMINAL_MIN,
        TERMINAL_MAX,
      ),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function usePanelLayout() {
  const [layout, setLayout] = useState<PanelLayout>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // ignore quota
    }
  }, [layout]);

  const patch = useCallback((p: Partial<PanelLayout>) => {
    setLayout((prev) => ({ ...prev, ...p }));
  }, []);

  const toggleSidebar = useCallback(() => {
    setLayout((prev) => ({ ...prev, sidebarOpen: !prev.sidebarOpen }));
  }, []);

  const toggleChanges = useCallback(() => {
    setLayout((prev) => ({ ...prev, changesOpen: !prev.changesOpen }));
  }, []);

  const toggleTerminal = useCallback(() => {
    setLayout((prev) => ({ ...prev, terminalOpen: !prev.terminalOpen }));
  }, []);

  const setSidebarWidth = useCallback((w: number) => {
    setLayout((prev) => ({
      ...prev,
      sidebarWidth: clamp(w, SIDEBAR_MIN, SIDEBAR_MAX),
    }));
  }, []);

  const setChangesWidth = useCallback((w: number) => {
    setLayout((prev) => ({
      ...prev,
      changesWidth: clamp(w, CHANGES_MIN, CHANGES_MAX),
    }));
  }, []);

  const setTerminalHeight = useCallback((h: number) => {
    setLayout((prev) => ({
      ...prev,
      terminalHeight: clamp(h, TERMINAL_MIN, TERMINAL_MAX),
    }));
  }, []);

  return {
    layout,
    patch,
    toggleSidebar,
    toggleChanges,
    toggleTerminal,
    setSidebarWidth,
    setChangesWidth,
    setTerminalHeight,
    limits: {
      SIDEBAR_MIN,
      SIDEBAR_MAX,
      CHANGES_MIN,
      CHANGES_MAX,
      TERMINAL_MIN,
      TERMINAL_MAX,
    },
  };
}
