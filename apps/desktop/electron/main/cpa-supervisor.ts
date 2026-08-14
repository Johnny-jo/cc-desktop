import fs from "node:fs";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import type { AppSettings, CpaStatus, ModelInfo } from "@claude-desktop/shared";
import { parseModelContextLimit } from "@claude-desktop/shared";
export type SpawnedProcess = {
  pid?: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  stderr?: { on?: (event: string, listener: (...args: unknown[]) => void) => unknown } | null;
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
  }) as ChildProcess as SpawnedProcess;
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
  private modelCatalog: ModelInfo[] = [];

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

  /**
   * Fetch OpenAI-compatible /v1/models and cache ModelInfo with context limits.
   * Prefers unprefixed aliases for the returned ids, but keeps the best available
   * context limit (preferring direct rows, then any prefixed sibling).
   */
  async listModelCatalog(): Promise<ModelInfo[]> {
    const settings = this.getSettings();
    const token = this.getToken();
    if (!token) {
      throw new Error("CPA token is not set");
    }
    const port = settings.cpaPort;
    const url = `http://127.0.0.1:${port}/v1/models`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `CPA /v1/models failed: ${res.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
      );
    }
    const json = (await res.json()) as { data?: unknown[] };
    const rawItems = Array.isArray(json.data) ? json.data : [];

    // Map id -> best ModelInfo (prefer entry that has contextLimit)
    const byId = new Map<string, ModelInfo>();
    for (const item of rawItems) {
      if (!item || typeof item !== "object") continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id !== "string" || !id) continue;
      const contextLimit = parseModelContextLimit(item);
      const next: ModelInfo = {
        id,
        ...(contextLimit != null ? { contextLimit } : {}),
      };
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, next);
      } else if (next.contextLimit != null && prev.contextLimit == null) {
        byId.set(id, next);
      } else if (
        next.contextLimit != null &&
        prev.contextLimit != null &&
        next.contextLimit > prev.contextLimit
      ) {
        byId.set(id, next);
      }
    }

    const ids = preferUnprefixedModels([...byId.keys()]);
    const catalog: ModelInfo[] = ids.map((id) => {
      // Prefer unprefixed row; fall back to any prefixed sibling's limit
      const direct = byId.get(id);
      if (direct?.contextLimit != null) {
        return { id, contextLimit: direct.contextLimit };
      }
      for (const [k, v] of byId) {
        if (k === id || k.endsWith(`/${id}`)) {
          if (v.contextLimit != null) {
            return { id, contextLimit: v.contextLimit };
          }
        }
      }
      return { id };
    });

    this.modelCatalog = catalog;
    return this.getModelCatalog();
  }

  getModelCatalog(): ModelInfo[] {
    return this.modelCatalog.map((m) => ({ ...m }));
  }

  async listModels(): Promise<string[]> {
    const catalog = await this.listModelCatalog();
    return catalog.map((m) => m.id);
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

    const exe = settings.cpaExePath;
    if (!exe || !fs.existsSync(exe)) {
      const status: CpaStatus = {
        state: "error",
        message:
          `找不到 CPA 程序：${exe || "(空路径)"}\n` +
          `请完全退出后重装，或确认安装目录 resources\\bin\\cpa\\cli-proxy-api.exe 存在。`,
      };
      this.setStatus(status);
      return status;
    }
    if (settings.cpaConfigPath && !fs.existsSync(settings.cpaConfigPath)) {
      const status: CpaStatus = {
        state: "error",
        message: `找不到 CPA 配置：${settings.cpaConfigPath}`,
      };
      this.setStatus(status);
      return status;
    }

    this.setStatus({ state: "starting" });

    const stderrChunks: string[] = [];
    try {
      this.child = this.spawnProcess(
        exe,
        ["--config", settings.cpaConfigPath],
        { stdio: "pipe" },
      );
      this.managedByApp = true;

      this.child.stderr?.on?.("data", (buf: unknown) => {
        const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
        if (text) {
          stderrChunks.push(text);
          if (stderrChunks.length > 20) stderrChunks.shift();
        }
      });

      if (this.child.on) {
        this.child.on("exit", (code: unknown, signal: unknown) => {
          if (this.managedByApp) {
            this.managedByApp = false;
            this.child = null;
            const detail = stderrChunks.join("").trim().slice(0, 400);
            const why = [
              code != null ? `exit ${code}` : null,
              signal ? `signal ${String(signal)}` : null,
              detail || null,
            ]
              .filter(Boolean)
              .join(" · ");
            if (this.status.state === "starting") {
              this.setStatus({
                state: "error",
                message: `CPA 启动后立即退出${why ? `（${why}）` : ""}。exe: ${exe}`,
              });
            } else if (this.status.state === "ready") {
              this.setStatus({
                state: "error",
                message: `CPA 意外退出${why ? `（${why}）` : ""}`,
              });
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
      if (this.status.state === "error") {
        return this.status;
      }
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

/** Keep unprefixed ids; drop `provider/model` duplicates of the same leaf name. */
export function preferUnprefixedModels(ids: string[]): string[] {
  const unprefixed = new Set(ids.filter((id) => !id.includes("/")));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (id.includes("/")) {
      const leaf = id.split("/").pop() ?? id;
      if (unprefixed.has(leaf)) continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
