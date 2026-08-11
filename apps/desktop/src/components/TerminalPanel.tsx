import React, { useCallback, useEffect, useRef, useState } from "react";
import { IPC } from "@claude-desktop/shared";
import { getDesktop } from "../lib/desktop-api";
import { useAppStore } from "../state/store";

type Props = {
  open: boolean;
  height: number;
};

/**
 * Codex-style bottom shell panel. Line-oriented input + streamed
 * stdout/stderr (not a full PTY). Enough for project commands and logs.
 */
export function TerminalPanel({ open, height }: Props) {
  const projectPath = useAppStore((s) => s.projectPath);
  const [termId, setTermId] = useState<string | null>(null);
  const [shellLabel, setShellLabel] = useState("shell");
  const [cwdLabel, setCwdLabel] = useState("");
  const [output, setOutput] = useState("");
  const [line, setLine] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "exited">("idle");
  const scrollerRef = useRef<HTMLPreElement | null>(null);
  const termIdRef = useRef<string | null>(null);

  const append = useCallback((chunk: string) => {
    setOutput((prev) => {
      const next = prev + chunk;
      return next.length > 200_000 ? next.slice(-160_000) : next;
    });
  }, []);

  useEffect(() => {
    termIdRef.current = termId;
  }, [termId]);

  useEffect(() => {
    if (!open) {
      const id = termIdRef.current;
      if (id) {
        try {
          void getDesktop().killTerminal(id);
        } catch {
          // ignore
        }
        termIdRef.current = null;
        setTermId(null);
        setStatus("idle");
      }
      return;
    }

    let cancelled = false;
    let createdId: string | null = null;
    const desktop = getDesktop();

    const unsubData = desktop.on(IPC.terminalData, (payload) => {
      const p = payload as { id: string; stream: string; data: string };
      if (!p?.data || !createdId || p.id !== createdId) return;
      append(p.data);
    });
    const unsubExit = desktop.on(IPC.terminalExit, (payload) => {
      const p = payload as { id: string; code: number | null };
      if (!createdId || p.id !== createdId) return;
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
        createdId = res.id;
        termIdRef.current = res.id;
        setTermId(res.id);
        setShellLabel(res.shell);
        setCwdLabel(res.cwd);
        setStatus("running");
        setOutput("");
      } catch (err) {
        if (cancelled) return;
        append(
          `[failed to start shell] ${err instanceof Error ? err.message : String(err)}\r\n`,
        );
        setStatus("exited");
      }
    })();

    return () => {
      cancelled = true;
      unsubData();
      unsubExit();
      if (createdId) {
        try {
          void desktop.killTerminal(createdId);
        } catch {
          // ignore
        }
      }
    };
  }, [open, projectPath, append]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [output]);

  const sendLine = async () => {
    if (!termId || status !== "running") return;
    const text = line;
    setLine("");
    append(`\r\n$ ${text}\r\n`);
    try {
      await getDesktop().writeTerminal(termId, `${text}\n`);
    } catch (err) {
      append(
        `[write failed] ${err instanceof Error ? err.message : String(err)}\r\n`,
      );
    }
  };

  const restart = async () => {
    if (termId) {
      try {
        await getDesktop().killTerminal(termId);
      } catch {
        // ignore
      }
    }
    setTermId(null);
    termIdRef.current = null;
    setOutput("");
    setStatus("idle");
    try {
      const res = await getDesktop().createTerminal(projectPath ?? undefined);
      termIdRef.current = res.id;
      setTermId(res.id);
      setShellLabel(res.shell);
      setCwdLabel(res.cwd);
      setStatus("running");
    } catch (err) {
      append(
        `[failed to restart] ${err instanceof Error ? err.message : String(err)}\r\n`,
      );
      setStatus("exited");
    }
  };

  if (!open) return null;

  return (
    <div className="terminal-panel" style={{ height: "100%" }}>
      <div className="terminal-toolbar">
        <span className="terminal-title">Terminal</span>
        <span className="terminal-meta" title={cwdLabel}>
          {shellLabel}
          {cwdLabel ? ` · ${cwdLabel}` : ""}
          {status === "exited" ? " · exited" : ""}
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
        {output || (status === "running" ? "Starting shell…\n" : "")}
      </pre>
      <div className="terminal-input-row">
        <span className="terminal-prompt">$</span>
        <input
          className="terminal-input"
          value={line}
          disabled={status !== "running"}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            status === "running" ? "Enter command…" : "Shell not running"
          }
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendLine();
            }
          }}
        />
      </div>
    </div>
  );
}
