import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as pty from "node-pty";

export type TerminalOutputEvent = {
  id: string;
  stream: "stdout" | "stderr" | "system";
  data: string;
  /** Main-process routing metadata; stripped before sending to the renderer. */
  ownerWebContentsId?: number;
};

export type TerminalExitEvent = {
  id: string;
  code: number | null;
  /** Main-process routing metadata; stripped before sending to the renderer. */
  ownerWebContentsId?: number;
};

/**
 * Real PTY-backed terminal host (Windows Terminal style): persistent shell
 * sessions, full keyboard input, multiple tabs, live title from the shell.
 */
export class TerminalHost {
  private sessions = new Map<
    string,
    {
      pty: pty.IPty;
      cwd: string;
      shellName: string;
      ownerWebContentsId?: number;
    }
  >();

  constructor(
    private readonly emitOutput: (e: TerminalOutputEvent) => void,
    private readonly emitExit: (e: TerminalExitEvent) => void,
  ) {}

  create(
    cwd?: string,
    opts?: {
      file?: string;
      args?: string[];
      env?: Record<string, string>;
      label?: string;
      ownerWebContentsId?: number;
    },
  ): { id: string; cwd: string; shell: string } {
    const dir =
      cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()
        ? cwd
        : process.cwd();
    const id = randomUUID();
    const isWin = process.platform === "win32";
    const shellPath =
      opts?.file ||
      (isWin
        ? process.env.WT_SHELL || "powershell.exe"
        : process.env.SHELL || "/bin/bash");
    const args = opts?.args ?? (isWin && !opts?.file ? ["-NoLogo"] : []);

    const term = pty.spawn(shellPath, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: dir,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...(opts?.env ?? {}),
      } as Record<string, string>,
    });

    term.onData((data) => {
      this.emitOutput({
        id,
        stream: "stdout",
        data,
        ...(opts?.ownerWebContentsId != null
          ? { ownerWebContentsId: opts.ownerWebContentsId }
          : {}),
      });
    });
    term.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      this.emitExit({
        id,
        code: exitCode,
        ...(opts?.ownerWebContentsId != null
          ? { ownerWebContentsId: opts.ownerWebContentsId }
          : {}),
      });
    });

    this.sessions.set(id, {
      pty: term,
      cwd: dir,
      shellName: opts?.label || path.basename(shellPath),
      ...(opts?.ownerWebContentsId != null
        ? { ownerWebContentsId: opts.ownerWebContentsId }
        : {}),
    });

    return { id, cwd: dir, shell: path.basename(shellPath) };
  }

  /** Raw keystrokes / paste text — forwarded verbatim to the PTY. */
  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      s.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      if (cols > 0 && rows > 0) s.pty.resize(cols, rows);
    } catch {
      // ignore
    }
  }

  /** Title reported by the shell (OSC), falling back to shell name. */
  getLabel(id: string): string {
    const s = this.sessions.get(id);
    return s?.shellName ?? "shell";
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      s.pty.kill();
    } catch {
      // ignore
    }
    this.sessions.delete(id);
    return true;
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
  }

  /** Renderer windows own their PTYs; closing one must not leak shell children. */
  killOwnedBy(ownerWebContentsId: number): void {
    for (const [id, session] of this.sessions) {
      if (session.ownerWebContentsId === ownerWebContentsId) this.kill(id);
    }
  }

  list(): Array<{ id: string; cwd: string }> {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      cwd: s.cwd,
    }));
  }
}
