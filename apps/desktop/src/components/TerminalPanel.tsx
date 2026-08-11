import React, { useCallback, useEffect, useRef, useState } from "react";
import { IPC } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import { useAppStore } from "../state/store";

type Props = {
  open: boolean;
  height: number;
};

/**
 * Bottom command panel. Line input is always editable while open;
 * shell I/O is line-oriented (not a full PTY).
 */
export function TerminalPanel({ open }: Props) {
  const projectPath = useAppStore((s) => s.projectPath);
  const [termId, setTermId] = useState<string | null>(null);
  const [shellLabel, setShellLabel] = useState("shell");
  const [cwdLabel, setCwdLabel] = useState("");
  const [output, setOutput] = useState("");
  const [line, setLine] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "exited" | "error">(
    "idle",
  );
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
        setStatus("idle");
      }
      return;
    }

    let cancelled = false;
    const desktop = getDesktop();

    const unsubData = desktop.on(IPC.terminalData, (payload) => {
      const p = payload as { id: string; stream: string; data: string };
      if (!p?.data) return;
      if (activeIdRef.current && p.id !== activeIdRef.current) return;
      // Accept output even before React state catches up (use ref).
      if (!activeIdRef.current) activeIdRef.current = p.id;
      append(p.data);
    });
    const unsubExit = desktop.on(IPC.terminalExit, (payload) => {
      const p = payload as { id: string; code: number | null };
      if (activeIdRef.current && p.id !== activeIdRef.current) return;
      setStatus("exited");
      append(`\r\n[process exited: ${p.code ?? "?"}]\r\n`);
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
        setStatus("running");
        // Focus the command line so the user can type immediately.
        requestAnimationFrame(() => inputRef.current?.focus());
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        append(
          `[failed to start shell] ${err instanceof Error ? err.message : String(err)}\r\n`,
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
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [output]);

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const sendLine = async () => {
    const text = line;
    const id = termId ?? activeIdRef.current;
    if (!text.trim() && !id) return;
    setLine("");
    append(`$ ${text}\r\n`);
    if (!id || status === "exited" || status === "error") {
      append("[shell not running — click Restart]\r\n");
      return;
    }
    try {
      const res = await getDesktop().writeTerminal(id, `${text}\n`);
      if (!res.ok) {
        append("[write failed — shell may have exited]\r\n");
        setStatus("exited");
      }
    } catch (err) {
      append(
        `[write failed] ${err instanceof Error ? err.message : String(err)}\r\n`,
      );
    }
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
    setOutput("");
    setStatus("idle");
    try {
      const res = await getDesktop().createTerminal(projectPath ?? undefined);
      activeIdRef.current = res.id;
      setTermId(res.id);
      setShellLabel(res.shell);
      setCwdLabel(res.cwd);
      setStatus("running");
      inputRef.current?.focus();
    } catch (err) {
      setStatus("error");
      append(
        `[failed to restart] ${err instanceof Error ? err.message : String(err)}\r\n`,
      );
    }
  };

  if (!open) return null;

  const canSend = Boolean(termId ?? activeIdRef.current) && status === "running";

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <span className="terminal-title">Terminal</span>
        <span className="terminal-meta" title={cwdLabel}>
          {shellLabel}
          {cwdLabel ? ` · ${cwdLabel}` : ""}
          {status === "exited" ? " · exited" : ""}
          {status === "error" ? " · error" : ""}
          {status === "idle" ? " · starting…" : ""}
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
        {output ||
          (status === "running" || status === "idle"
            ? "Starting shell…\n"
            : "")}
      </pre>
      <div className="terminal-input-row">
        <span className="terminal-prompt">$</span>
        <input
          ref={inputRef}
          className="terminal-input"
          value={line}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={
            canSend
              ? "输入命令后回车…"
              : status === "idle"
                ? "正在启动 shell…"
                : "Shell 未运行 — 点 Restart"
          }
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              void sendLine();
            }
          }}
        />
      </div>
    </div>
  );
}
