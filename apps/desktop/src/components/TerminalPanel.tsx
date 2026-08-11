import React, { useCallback, useEffect, useRef, useState } from "react";
import { IPC } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import { useAppStore } from "../state/store";

type Props = {
  open: boolean;
  height: number;
};

/**
 * Bottom command panel. Always typeable; each Enter runs a command in the
 * project directory (Windows: one-shot cmd /c — reliable without a PTY).
 */
export function TerminalPanel({ open }: Props) {
  const projectPath = useAppStore((s) => s.projectPath);
  const [termId, setTermId] = useState<string | null>(null);
  const [shellLabel, setShellLabel] = useState("cmd");
  const [cwdLabel, setCwdLabel] = useState("");
  const [output, setOutput] = useState("");
  const [line, setLine] = useState("");
  const [ready, setReady] = useState(false);
  const scrollerRef = useRef<HTMLPreElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeIdRef = useRef<string | null>(null);

  const append = useCallback((chunk: string) => {
    setOutput((prev) => {
      const next = prev + chunk;
      return next.length > 200_000 ? next.slice(-160_000) : next;
    });
  }, []);

  useEffect(() => {
    if (!open) {
      const id = activeIdRef.current;
      if (id) {
        try {
          void getDesktop().killTerminal(id);
        } catch {
          // ignore
        }
        activeIdRef.current = null;
        setTermId(null);
        setReady(false);
      }
      return;
    }

    let cancelled = false;
    const desktop = getDesktop();

    const unsubData = desktop.on(IPC.terminalData, (payload) => {
      const p = payload as { id: string; stream: string; data: string };
      if (!p?.data) return;
      if (activeIdRef.current && p.id !== activeIdRef.current) return;
      if (!activeIdRef.current) activeIdRef.current = p.id;
      append(p.data);
    });
    const unsubExit = desktop.on(IPC.terminalExit, (payload) => {
      const p = payload as { id: string; code: number | null };
      if (activeIdRef.current && p.id !== activeIdRef.current) return;
      append(`\r\n[session ended: ${p.code ?? "?"}]\r\n`);
      setReady(false);
    });

    void (async () => {
      try {
        const res = await desktop.createTerminal(projectPath ?? undefined);
        if (cancelled) {
          void desktop.killTerminal(res.id);
          return;
        }
        activeIdRef.current = res.id;
        setTermId(res.id);
        setShellLabel(res.shell);
        setCwdLabel(res.cwd);
        setReady(true);
        setOutput("");
        requestAnimationFrame(() => inputRef.current?.focus());
      } catch (err) {
        if (cancelled) return;
        setReady(false);
        append(
          `[无法启动终端] ${err instanceof Error ? err.message : String(err)}\r\n`,
        );
      }
    })();

    return () => {
      cancelled = true;
      unsubData();
      unsubExit();
      const id = activeIdRef.current;
      if (id) {
        try {
          void desktop.killTerminal(id);
        } catch {
          // ignore
        }
        activeIdRef.current = null;
      }
    };
  }, [open, projectPath, append]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(t);
  }, [open, ready]);

  const sendLine = async () => {
    const text = line;
    setLine("");
    const id = termId ?? activeIdRef.current;
    if (!id) {
      append("[终端未就绪，点 Restart]\r\n");
      return;
    }
    if (text.trim()) {
      append(`$ ${text}\r\n`);
    }
    try {
      const res = await getDesktop().writeTerminal(id, `${text}\n`);
      if (!res.ok) {
        append("[执行失败 — 可点 Restart 重试]\r\n");
      }
    } catch (err) {
      append(
        `[write failed] ${err instanceof Error ? err.message : String(err)}\r\n`,
      );
    }
    inputRef.current?.focus();
  };

  const restart = async () => {
    const old = termId ?? activeIdRef.current;
    if (old) {
      try {
        await getDesktop().killTerminal(old);
      } catch {
        // ignore
      }
    }
    activeIdRef.current = null;
    setTermId(null);
    setReady(false);
    setOutput("");
    try {
      const res = await getDesktop().createTerminal(projectPath ?? undefined);
      activeIdRef.current = res.id;
      setTermId(res.id);
      setShellLabel(res.shell);
      setCwdLabel(res.cwd);
      setReady(true);
      inputRef.current?.focus();
    } catch (err) {
      append(
        `[restart failed] ${err instanceof Error ? err.message : String(err)}\r\n`,
      );
    }
  };

  if (!open) return null;

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <span className="terminal-title">Terminal</span>
        <span className="terminal-meta" title={cwdLabel}>
          {shellLabel}
          {cwdLabel ? ` · ${cwdLabel}` : ""}
          {!ready ? " · …" : ""}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void restart()}
        >
          Restart
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setOutput("")}
        >
          Clear
        </button>
      </div>
      <pre className="terminal-output" ref={scrollerRef}>
        {output || (ready ? "" : "Starting…\n")}
      </pre>
      <form
        className="terminal-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void sendLine();
        }}
      >
        <span className="terminal-prompt">$</span>
        <input
          ref={inputRef}
          className="terminal-input"
          value={line}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="输入命令，回车执行…"
          onChange={(e) => setLine(e.target.value)}
        />
        <button type="submit" className="btn btn-sm terminal-run">
          运行
        </button>
      </form>
    </div>
  );
}
