import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TerminalOutputEvent = {
  id: string;
  stream: "stdout" | "stderr" | "system";
  data: string;
};

export type TerminalExitEvent = {
  id: string;
  code: number | null;
};

type Session = {
  /** Optional long-lived shell (unused on Windows one-shot mode) */
  child: ChildProcessWithoutNullStreams | null;
  cwd: string;
  /** In-flight one-shot command process */
  running: ChildProcessWithoutNullStreams | null;
};

/**
 * Project terminal host.
 *
 * Windows has no easy PTY in Electron without native deps, so we use
 * **one-shot commands** (`cmd /d /s /c …`) per Enter. That is reliable for
 * typing + running builds/tests. Unix keeps a simple interactive bash.
 */
export class TerminalHost {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly emitOutput: (e: TerminalOutputEvent) => void,
    private readonly emitExit: (e: TerminalExitEvent) => void,
  ) {}

  create(cwd?: string): { id: string; cwd: string; shell: string } {
    const dir =
      cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()
        ? cwd
        : process.cwd();
    const id = randomUUID();
    const isWin = process.platform === "win32";

    this.sessions.set(id, { child: null, cwd: dir, running: null });

    const shellLabel = isWin ? "cmd" : path.basename(process.env.SHELL || "bash");
    setImmediate(() => {
      if (!this.sessions.has(id)) return;
      this.emitOutput({
        id,
        stream: "system",
        data: isWin
          ? `终端就绪 · ${dir}\r\n输入命令后按回车执行（每次一条）。\r\n\r\n`
          : `Shell: ${shellLabel} · cwd: ${dir}\r\n`,
      });
    });

    // Unix: start a real interactive shell for a closer terminal feel.
    if (!isWin) {
      const shell = process.env.SHELL || "/bin/bash";
      const child = spawn(shell, ["-i"], {
        cwd: dir,
        env: { ...process.env, TERM: "dumb" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        this.emitOutput({ id, stream: "stdout", data });
      });
      child.stderr.on("data", (data: string) => {
        this.emitOutput({ id, stream: "stderr", data });
      });
      child.on("close", (code) => {
        const s = this.sessions.get(id);
        if (s) s.child = null;
        this.emitExit({ id, code });
      });
      const s = this.sessions.get(id);
      if (s) s.child = child;
    }

    return { id, cwd: dir, shell: shellLabel };
  }

  /**
   * Write data to the session.
   * - Windows: treat as a full command line (run via cmd /c).
   * - Unix: write to interactive shell stdin when available; else one-shot.
   */
  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;

    const text = data.replace(/\r?\n$/, "");
    // Empty enter → just a newline in the UI; no process.
    if (!text.trim()) {
      this.emitOutput({ id, stream: "stdout", data: "\r\n" });
      return true;
    }

    if (process.platform === "win32") {
      return this.runOneShot(id, s, text);
    }

    if (s.child && !s.child.killed && s.child.exitCode == null) {
      try {
        s.child.stdin.write(data.endsWith("\n") ? data : `${data}\n`);
        return true;
      } catch {
        return false;
      }
    }
    return this.runOneShot(id, s, text);
  }

  writeLine(id: string, line: string): boolean {
    return this.write(id, `${line}\n`);
  }

  private runOneShot(id: string, s: Session, command: string): boolean {
    if (s.running) {
      this.emitOutput({
        id,
        stream: "system",
        data: "\r\n[已有命令在运行，请等待结束或 Restart]\r\n",
      });
      return false;
    }

    const isWin = process.platform === "win32";
    const shell = isWin
      ? process.env.ComSpec || "cmd.exe"
      : process.env.SHELL || "/bin/bash";
    const args = isWin
      ? ["/d", "/s", "/c", command]
      : ["-lc", command];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(shell, args, {
        cwd: s.cwd,
        env: { ...process.env, TERM: "dumb" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      this.emitOutput({
        id,
        stream: "system",
        data: `\r\n[无法启动] ${err instanceof Error ? err.message : String(err)}\r\n`,
      });
      return false;
    }

    s.running = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.emitOutput({ id, stream: "stdout", data: chunk });
    });
    child.stderr.on("data", (chunk: string) => {
      this.emitOutput({ id, stream: "stderr", data: chunk });
    });
    child.on("error", (err) => {
      this.emitOutput({
        id,
        stream: "system",
        data: `\r\n[error] ${err.message}\r\n`,
      });
    });
    child.on("close", (code) => {
      if (s.running === child) s.running = null;
      this.emitOutput({
        id,
        stream: "system",
        data: `\r\n[exit ${code ?? "?"}] ${s.cwd}\r\n\r\n`,
      });
    });
    return true;
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.killProc(s.running);
    this.killProc(s.child);
    s.running = null;
    s.child = null;
    this.sessions.delete(id);
    return true;
  }

  private killProc(child: ChildProcessWithoutNullStreams | null): void {
    if (!child || child.killed) return;
    try {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
  }

  list(): Array<{ id: string; cwd: string }> {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      cwd: s.cwd,
    }));
  }
}
