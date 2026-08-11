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

const XTERM_THEME = {
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

/** One xterm instance bound to a PTY session (kept alive across tab switches). */
function XtermView({
  termId,
  active,
  onExit,
}: {
  termId: string;
  active: boolean;
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
      theme: XTERM_THEME,
      fontFamily: 'Cascadia Mono, Consolas, ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
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

    return () => {
      ro.disconnect();
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

  // Fit when becoming visible again (hidden views have 0 size).
  useEffect(() => {
    if (!active) return;
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
  }, [active, termId]);

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

  const addTab = useCallback(async () => {
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
    }
  }, [projectPath]);

  // Create the first tab when opening.
  useEffect(() => {
    if (open && tabs.length === 0) {
      void addTab();
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

  // Close all on panel close.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    if (open) return;
    for (const t of tabsRef.current) {
      try {
        void getDesktop().killTerminal(t.id);
      } catch {
        // ignore
      }
    }
    if (tabsRef.current.length) setTabs([]);
    setActiveId(null);
  }, [open]);

  const markExited = useCallback((id: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exited: true } : t)),
    );
  }, []);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? null,
    [tabs, activeId],
  );

  if (!open) return null;

  return (
    <div className="terminal-panel">
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
