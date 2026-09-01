import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { IPC } from "@claude-desktop/shared";
import { getDesktop, hasDesktopApi } from "../lib/desktop-api";
import { bindXtermInteractive } from "../lib/xterm-interactive";
import { useAppStore } from "../state/store";
import { useI18n } from "../i18n/useI18n";

function xtermTheme() {
  const explicit = document.documentElement.dataset.theme;
  const light = explicit
    ? explicit === "light"
    : window.matchMedia("(prefers-color-scheme: light)").matches;
  const rootStyle = getComputedStyle(document.documentElement);
  const background = rootStyle.getPropertyValue("--bg-terminal").trim() ||
    (light ? "#ffffff" : "#0e0e0e");
  const foreground = rootStyle.getPropertyValue("--text").trim() ||
    (light ? "#1c1c1e" : "#d4d4d4");
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: light ? "#b6d3f8" : "#264f78",
  };
}

export function CliModePage() {
  const { t } = useI18n();
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const session = sessions.find((s) => s.id === activeSessionId) ?? null;
  const [termId, setTermId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const prev = termIdRef.current;
    if (prev && hasDesktopApi("killTerminal")) {
      void getDesktop().killTerminal(prev);
    }
    termIdRef.current = null;
    setTermId(null);
    setError(null);
    setResumed(false);

    if (!hasDesktopApi("attachCliSession")) {
      setError(
        t.cli.backToDesktop === "Back to desktop"
          ? "Please fully restart the app before using CLI mode (new preload required)"
          : "请完全重启应用后再用 CLI 模式（需要新的 preload）",
      );
      return;
    }

    void getDesktop()
      .attachCliSession(activeSessionId)
      .then((res) => {
        if (cancelled) {
          if (res.ok && res.id) void getDesktop().killTerminal(res.id);
          return;
        }
        if (!res.ok || !res.id) {
          setError(res.error ?? t.cli.startError);
          return;
        }
        termIdRef.current = res.id;
        setTermId(res.id);
        setResumed(Boolean(res.sdkSessionId));
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
      const id = termIdRef.current;
      if (id && hasDesktopApi("killTerminal")) {
        void getDesktop().killTerminal(id);
      }
      termIdRef.current = null;
    };
  }, [activeSessionId]);

  useEffect(() => {
    if (!termId) return;
    const el = containerRef.current;
    if (!el) return;
    const desktop = getDesktop();
    const term = new Terminal({
      theme: xtermTheme(),
      fontFamily: "Cascadia Mono, Consolas, ui-monospace, Menlo, monospace",
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
      // container may not be measured yet
    }
    term.focus();

    const dataSub = term.onData((data) => {
      void desktop.writeTerminal(termId, data);
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      void desktop.resizeTerminal(termId, cols, rows);
    });
    const unbindInteractive = bindXtermInteractive(term, el, {
      paste: (text) => term.paste(text),
    });
    const unsubData = desktop.on(IPC.terminalData, (payload) => {
      const p = payload as { id: string; data: string };
      if (p?.id !== termId || typeof p.data !== "string") return;
      term.write(p.data);
    });
    const unsubExit = desktop.on(IPC.terminalExit, (payload) => {
      const p = payload as { id: string; code: number | null };
      if (p?.id !== termId) return;
      term.write(`\r\n\x1b[90m[claude exited: ${p.code ?? "?"}]\x1b[0m\r\n`);
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // ignore
      }
    });
    ro.observe(el);
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
  }, [termId]);

  return (
    <div className="cli-page">
      <header className="cli-head">
        <span className="cli-title">{session?.title ?? t.sidebar.newChat}</span>
        <span className="cli-meta">
          {resumed ? t.cli.resumed : t.cli.newSession}
          {" · "}
          Ctrl+Shift+L {t.cli.backToDesktop}
        </span>
      </header>
      {error ? <p className="cli-err">{error}</p> : null}
      <div ref={containerRef} className="cli-xterm" />
    </div>
  );
}
