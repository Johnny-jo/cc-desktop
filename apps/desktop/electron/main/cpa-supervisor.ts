import net from "node:net";
import { spawn } from "node:child_process";
import type { AppSettings, CpaStatus } from "@claude-desktop/shared";

export type SpawnedProcess = {
  pid?: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export type CpaSupervisorDeps = {
  getSettings: () => AppSettings;
  getToken: () => string | null;
  probePort?: (port: number) => Promise<boolean>;
  spawnProcess?: (
    command: string,
    args: string[],
    options?: { stdio?: "ignore" | "inherit" | "pipe" },
  ) => SpawnedProcess;
  onStatusChange?: (status: CpaStatus) => void;
  /** poll interval while waiting for port after spawn (ms) */
  pollIntervalMs?: number;
  /** max wait after spawn (ms) */
  readyTimeoutMs?: number;
};

const DEFAULT_POLL_MS = 250;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 300;

export function defaultProbePort(
  port: number,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options?: { stdio?: "ignore" | "inherit" | "pipe" },
): SpawnedProcess {
  return spawn(command, args, {
    stdio: options?.stdio ?? "ignore",
    windowsHide: true,
    detached: false,
  }) as SpawnedProcess;
}

export class CpaSupervisor {
  private readonly getSettings: CpaSupervisorDeps["getSettings"];
  private readonly getToken: CpaSupervisorDeps["getToken"];
  private readonly probePort: (port: number) => Promise<boolean>;
  private readonly spawnProcess: NonNullable<CpaSupervisorDeps["spawnProcess"]>;
  private readonly onStatusChange?: (status: CpaStatus) => void;
  private readonly pollIntervalMs: number;
  private readonly readyTimeoutMs: number;

  private status: CpaStatus = { state: "unknown" };
  private child: SpawnedProcess | null = null;
  private managedByApp = false;
  private ensurePromise: Promise<CpaStatus> | null = null;

  constructor(deps: CpaSupervisorDeps) {
    this.getSettings = deps.getSettings;
    this.getToken = deps.getToken;
    this.probePort = deps.probePort ?? defaultProbePort;
    this.spawnProcess = deps.spawnProcess ?? defaultSpawnProcess;
    this.onStatusChange = deps.onStatusChange;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  getStatus(): CpaStatus {
    return this.status;
  }

  buildProcessEnv(model?: string): Record<string, string> {
    const settings = this.getSettings();
    const token = this.getToken() ?? "";
    const selected = model ?? settings.defaultModel;
    return {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${settings.cpaPort}`,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_MODEL: selected,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    } as Record<string, string>;
  }

  async ensureReady(): Promise<CpaStatus> {
    if (this.ensurePromise) {
      return this.ensurePromise;
    }
    this.ensurePromise = this.doEnsureReady().finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  stopIfManaged(): void {
    if (!this.managedByApp || !this.child) {
      return;
    }
    try {
      this.child.kill();
    } catch {
      // ignore kill errors
    }
    this.child = null;
    this.managedByApp = false;
    this.setStatus({ state: "stopped" });
  }

  private async doEnsureReady(): Promise<CpaStatus> {
    const settings = this.getSettings();
    const port = settings.cpaPort;

    const alreadyUp = await this.probePort(port);
    if (alreadyUp) {
      const status: CpaStatus = {
        state: "ready",
        port,
        managedByApp: this.managedByApp,
      };
      this.setStatus(status);
      return status;
    }

    // Avoid leaking a previous managed child on retry/restart.
    if (this.managedByApp && this.child) {
      this.stopIfManaged();
    }

    this.setStatus({ state: "starting" });

    try {
      this.child = this.spawnProcess(
        settings.cpaExePath,
        ["--config", settings.cpaConfigPath],
        { stdio: "ignore" },
      );
      this.managedByApp = true;

      if (this.child.on) {
        this.child.on("exit", () => {
          if (this.managedByApp) {
            this.managedByApp = false;
            this.child = null;
            if (this.status.state === "ready" || this.status.state === "starting") {
              this.setStatus({ state: "stopped" });
            }
          }
        });
        this.child.on("error", (err: unknown) => {
          this.managedByApp = false;
          this.child = null;
          this.setStatus({
            state: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      this.clearManagedChild();
      const message = err instanceof Error ? err.message : String(err);
      const status: CpaStatus = { state: "error", message };
      this.setStatus(status);
      return status;
    }

    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      const up = await this.probePort(port);
      if (up) {
        const status: CpaStatus = {
          state: "ready",
          port,
          managedByApp: true,
        };
        this.setStatus(status);
        return status;
      }
      await sleep(this.pollIntervalMs);
    }

    // Timed out waiting for readiness — kill the managed child so retries
    // do not leave orphaned processes behind.
    this.clearManagedChild();
    const status: CpaStatus = {
      state: "error",
      message: `CPA did not become ready on port ${port} within ${this.readyTimeoutMs}ms`,
    };
    this.setStatus(status);
    return status;
  }

  /** Kill managed child (if any) and clear ownership flags without status change. */
  private clearManagedChild(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore kill errors
      }
    }
    this.child = null;
    this.managedByApp = false;
  }

  private setStatus(status: CpaStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
