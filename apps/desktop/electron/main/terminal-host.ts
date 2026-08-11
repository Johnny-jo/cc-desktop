import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

/**
 * Lightweight project shell (PowerShell on Windows, $SHELL elsewhere).
 * Not a full PTY — good enough for Codex-style bottom terminal MVP.
 */
export class TerminalHost {
  private sessions = new Map<
    string,
    {
      child: ChildProcessWithoutNullStreams;
      cwd: string;
    }
  >();

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
    // Windows: cmd.exe /K keeps a shell open and accepts piped stdin lines.
    const shell = isWin
      ? process.env.ComSpec || "cmd.exe"
      : process.env.SHELL || "/bin/bash";
    const args = isWin ? ["/d", "/q", "/k"] : ["-i"];

    const child = spawn(shell, args, {
      cwd: dir,
      env: {
        ...process.env,
        // Reduce interactive prompts that hang without a TTY.
        TERM: process.env.TERM || "dumb",
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Ensure stdin stays open for multiple commands.
    child.stdin.setDefaultEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      this.emitOutput({ id, stream: "stdout", data });
    });
    child.stderr.on("data", (data: string) => {
      this.emitOutput({ id, stream: "stderr", data });
    });
    child.on("error", (err) => {
      this.emitOutput({
        id,
        stream: "system",
        data: `\r\n[shell error] ${err.message}\r\n`,
      });
    });
    child.on("close", (code) => {
      this.sessions.delete(id);
      this.emitExit({ id, code });
    });

    this.sessions.set(id, { child, cwd: dir });
    // Defer banner so renderer has subscribed to terminal:data.
    setImmediate(() => {
      if (!this.sessions.has(id)) return;
      this.emitOutput({
        id,
        stream: "system",
        data: `Shell: ${path.basename(shell)} · cwd: ${dir}\r\n`,
      });
    });

    return { id, cwd: dir, shell: path.basename(shell) };
  }

  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.child.killed || s.child.exitCode != null) return false;
    try {
      // Normalize to platform newlines for cmd.exe without a PTY.
      const payload =
        process.platform === "win32"
          ? data.replace(/\r?\n/g, "\r\n")
          : data;
      const ok = s.child.stdin.write(payload);
      if (!ok) {
        // Backpressure — still accepted by stream buffer.
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Send a line (appends newline) — convenience for simple UI input. */
  writeLine(id: string, line: string): boolean {
    const nl = process.platform === "win32" ? "\r\n" : "\n";
    return this.write(id, `${line}${nl}`);
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(s.child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        s.child.kill("SIGTERM");
      }
    } catch {
      try {
        s.child.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.delete(id);
    return true;
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

export function defaultShellLabel(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC?.toLowerCase().includes("powershell")
      ? "PowerShell"
      : "cmd";
  }
  return path.basename(process.env.SHELL || "bash");
}

// silence unused import if tree-shaken oddly
void os;
