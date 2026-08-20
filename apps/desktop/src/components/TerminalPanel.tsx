import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IPC } from "@claude-desktop/shared";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getDesktop } from "../lib/desktop-api";
import { bindXtermInteractive } from "../lib/xterm-interactive";
import { useAppStore } from "../state/store";

type Props = {
  open: boolean;
  height: number;
};

type Tab = {
  id: string;
  title: string;
  exited: boolean;
};

const XTERM_THEME_DARK = {
  background: "#0e0e0e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#0e0e0e",
  selectionBackground: "#264f78",
  black: "#0e0e0e",
  brightBlack: "#666666",
  red: "#f14c4c",
  brightRed: "#f14c4c",
  green: "#23d18b",
  brightGreen: "#23d18b",
  yellow: "#f5f543",
  brightYellow: "#f5f543",
  blue: "#3b8eea",
  brightBlue: "#3b8eea",
  magenta: "#d670d6",
  brightMagenta: "#d670d6",
  cyan: "#29b8db",
  brightCyan: "#29b8db",
  white: "#d4d4d4",
  brightWhite: "#e8e8e8",
};

const XTERM_THEME_LIGHT = {
  background: "#f4f4f6",
  foreground: "#2a2a2e",
  cursor: "#2a2a2e",
  cursorAccent: "#f4f4f6",
  selectionBackground: "#b6d3f8",
  black: "#2a2a2e",
  brightBlack: "#7a7a82",
  red: "#c72e2e",
  brightRed: "#c72e2e",
  green: "#0e7a4f",
  brightGreen: "#0e7a4f",
  yellow: "#9a6700",
  brightYellow: "#9a6700",
  blue: "#1d4ed8",
  brightBlue: "#1d4ed8",
  magenta: "#a21caf",
  brightMagenta: "#a21caf",
  cyan: "#0e7490",
  brightCyan: "#0e7490",
  white: "#2a2a2e",
  brightWhite: "#101014",
};

function xtermTheme() {
  return document.documentElement.dataset.theme === "light"
    ? XTERM_THEME_LIGHT
    : XTERM_THEME_DARK;
}

/** One xterm instance bound to a PTY session (kept alive across tab switches). */
function XtermView({
  termId,
  active,
  visible,
  onExit,
}: {
  termId: string;
  active: boolean;
  visible: boolean;
  onExit: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const desktop = getDesktop();

    const term = new Terminal({
      theme: xtermTheme(),
      fontFamily: 'Cascadia Mono, Consolas, ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 2000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;

    try {
      fit.fit();
      if (term.cols > 0 && term.rows > 0) {
        void desktop.resizeTerminal(termId, term.cols, term.rows);
      }
    } catch {
      // container may be hidden; fit on activate
    }

    // Keystrokes → PTY
    const dataSub = term.onData((data) => {
      void desktop.writeTerminal(termId, data);
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      void desktop.resizeTerminal(termId, cols, rows);
    });
    const unbindInteractive = bindXtermInteractive(term, el, {
      paste: (text) => term.paste(text),
    });

    // PTY → xterm
    const unsubData = desktop.on(IPC.terminalData, (payload) => {
      const p = payload as { id: string; data: string };
      if (p?.id !== termId || typeof p.data !== "string") return;
      term.write(p.data);
    });
    const unsubExit = desktop.on(IPC.terminalExit, (payload) => {
      const p = payload as { id: string; code: number | null };
      if (p?.id !== termId) return;
      term.write(`\r\n\x1b[90m[process exited: ${p.code ?? "?"}]\x1b[0m\r\n`);
      onExit();
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore while hidden
      }
    });
    ro.observe(el);

    // Follow app theme switches without recreating the PTY session.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = xtermTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      ro.disconnect();
      themeObserver.disconnect();
      unbindInteractive();
      dataSub.dispose();
      resizeSub.dispose();
      unsubData();
      unsubExit();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId]);

  // Fit when becoming visible again (hidden views / collapsed panel have 0 size).
  useEffect(() => {
    if (!active || !visible) return;
    const el = containerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const t = termRef.current;
        if (t && t.cols > 0 && t.rows > 0) {
          void getDesktop().resizeTerminal(termId, t.cols, t.rows);
        }
        termRef.current?.focus();
      } catch {
        // ignore
      }
    });
  }, [active, visible, termId]);

  return (
    <div
      ref={containerRef}
      className="terminal-xterm"
      style={{ display: active ? "block" : "none" }}
    />
  );
}

export function TerminalPanel({ open }: Props) {
  const projectPath = useAppStore((s) => s.projectPath);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const nextIndex = useRef(1);
  /** Guard against double-add (effect re-run / rapid toggle). */
  const addingRef = useRef(false);

  const addTab = useCallback(async () => {
    if (addingRef.current) return;
    addingRef.current = true;
    const desktop = getDesktop();
    try {
      const res = await desktop.createTerminal(projectPath ?? undefined);
      const n = nextIndex.current++;
      setTabs((prev) => [
        ...prev,
        { id: res.id, title: `${res.shell} ${n}`, exited: false },
      ]);
      setActiveId(res.id);
    } catch {
      // surface as a dead tab note
    } finally {
      addingRef.current = false;
    }
  }, [projectPath]);

  // Create the first tab when opening.
  useEffect(() => {
    if (open) {
      setTabs((cur) => {
        if (cur.length === 0) void addTab();
        return cur;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const closeTab = useCallback(
    (id: string) => {
      try {
        void getDesktop().killTerminal(id);
      } catch {
        // ignore
      }
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id);
        const next = prev.filter((t) => t.id !== id);
        setActiveId((cur) => {
          if (cur !== id) return cur;
          if (next.length === 0) return null;
          const pick = next[Math.min(idx, next.length - 1)];
          return pick?.id ?? null;
        });
        return next;
      });
    },
    [],
  );

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    return () => {
      for (const t of tabsRef.current) {
        try {
          void getDesktop().killTerminal(t.id);
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const markExited = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exited: true } : t)),
    );
  }, []);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? null,
    [tabs, activeId],
  );

  return (
    <div className="terminal-panel" aria-hidden={!open}>
      <div className="terminal-tabbar">
        <div className="terminal-tabs" role="tablist">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              className={
                t.id === activeId ? "terminal-tab active" : "terminal-tab"
              }
              onClick={() => setActiveId(t.id)}
              title={t.title}
            >
              <span className="terminal-tab-title">
                {t.title}
                {t.exited ? " ✕" : ""}
              </span>
              <button
                type="button"
                className="terminal-tab-close"
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="terminal-tab-add"
          title="New terminal"
          onClick={() => void addTab()}
        >
          ＋
        </button>
        <span className="terminal-cwd" title={projectPath ?? ""}>
          {activeTab && projectPath
            ? projectPath.replace(/\\/g, "/").split("/").filter(Boolean).pop()
            : ""}
        </span>
      </div>
      <div className="terminal-views">
        {tabs.map((t) => (
          <XtermView
            key={t.id}
            termId={t.id}
            active={t.id === activeId}
            visible={open}
            onExit={() => markExited(t.id)}
          />
        ))}
        {tabs.length === 0 ? (
          <div className="terminal-empty">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void addTab()}
            >
              ＋ New terminal
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
