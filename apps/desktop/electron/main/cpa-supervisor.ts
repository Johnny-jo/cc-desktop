import fs from "node:fs";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import type { AppSettings, CpaStatus, ModelInfo, ModelQuotaInfo } from "@claude-desktop/shared";
import {
  parseModelContextLimit,
  parseModelDefaultReasoningEffort,
  parseModelReasoningEfforts,
} from "@claude-desktop/shared";
import { parseCpaQuotaObservation } from "./cpa-quota";
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
    options?: { stdio?: "ignore" | "inherit" | "pipe"; env?: NodeJS.ProcessEnv },
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

function modelsMatch(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

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
  options?: { stdio?: "ignore" | "inherit" | "pipe"; env?: NodeJS.ProcessEnv },
): SpawnedProcess {
  return spawn(command, args, {
    stdio: options?.stdio ?? "ignore",
    windowsHide: true,
    detached: false,
    env: options?.env,
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

  /** Loopback origin + token for borrowing this machine's CPA. Null if no token. */
  getProxyTarget(): { origin: string; token: string } | null {
    const token = this.getToken();
    if (!token) return null;
    const port = this.getSettings().cpaPort;
    return { origin: `http://127.0.0.1:${port}`, token };
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
   * Fetch CPA's live model registry and cache its exact model capabilities.
   * CPA 7.2.146+ exposes registry ModelInfo (including Thinking.Levels) through
   * the Grok Shell catalog selected by User-Agent. Older CPA versions safely
   * fall back to the four-field OpenAI list and therefore advertise no guessed
   * effort levels.
   *
   * Prefers unprefixed aliases for the returned ids, but keeps the best available
   * metadata from provider-prefixed siblings.
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
        // CPA routes this catalog from the live registry and preserves exact
        // reasoning_efforts. This is not a model-name heuristic.
        "User-Agent": "grok-shell/0.2.119 cc-desktop/0.3",
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
      const reasoningEfforts = parseModelReasoningEfforts(item);
      const defaultReasoningEffort = parseModelDefaultReasoningEffort(item);
      const next: ModelInfo = {
        id,
        ...(contextLimit != null ? { contextLimit } : {}),
        ...(reasoningEfforts?.length ? { reasoningEfforts } : {}),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      };
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, next);
      } else {
        const mergedEfforts = [
          ...(prev.reasoningEfforts ?? []),
          ...(next.reasoningEfforts ?? []),
        ];
        byId.set(id, {
          id,
          contextLimit:
            next.contextLimit != null &&
            (prev.contextLimit == null || next.contextLimit > prev.contextLimit)
              ? next.contextLimit
              : prev.contextLimit,
          ...(mergedEfforts.length
            ? { reasoningEfforts: [...new Set(mergedEfforts)] }
            : {}),
          ...(prev.defaultReasoningEffort || next.defaultReasoningEffort
            ? {
                defaultReasoningEffort:
                  prev.defaultReasoningEffort ?? next.defaultReasoningEffort!,
              }
            : {}),
        });
      }
    }

    const ids = preferUnprefixedModels([...byId.keys()]);
    const catalog: ModelInfo[] = ids.map((id) => {
      // Prefer an exact row; otherwise inherit all available metadata from a
      // provider-prefixed sibling of the same model.
      const candidates = [...byId].filter(([key]) => key === id || key.endsWith(`/${id}`));
      const direct = byId.get(id);
      const contextLimit = candidates.reduce<number | undefined>(
        (best, [, info]) =>
          info.contextLimit != null && (best == null || info.contextLimit > best)
            ? info.contextLimit
            : best,
        undefined,
      );
      const reasoningEfforts = [...new Set(candidates.flatMap(([, info]) => info.reasoningEfforts ?? []))];
      const defaultReasoningEffort =
        direct?.defaultReasoningEffort ??
        candidates.find(([, info]) => info.defaultReasoningEffort)?.[1].defaultReasoningEffort;
      return {
        id,
        ...(contextLimit != null ? { contextLimit } : {}),
        ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      };
    });

    this.modelCatalog = catalog;
    return this.getModelCatalog();
  }

  getModelCatalog(): ModelInfo[] {
    return this.modelCatalog.map((m) => ({
      ...m,
      ...(m.reasoningEfforts ? { reasoningEfforts: [...m.reasoningEfforts] } : {}),
    }));
  }

  /** Return only quota CPA actually observed in provider response headers. */
  async getModelQuota(modelId: string): Promise<ModelQuotaInfo | null> {
    const token = this.getToken();
    if (!token || !modelId.trim()) return null;
    const origin = `http://127.0.0.1:${this.getSettings().cpaPort}`;
    const headers = { Authorization: `Bearer ${token}` };
    const response = await fetch(`${origin}/v0/management/auth-files`, { headers });
    if (!response.ok) return null;
    const payload = (await response.json()) as { files?: unknown[] };
    const files = Array.isArray(payload.files) ? payload.files : [];
    const candidates: Array<{
      provider: string;
      parsed: NonNullable<ReturnType<typeof parseCpaQuotaObservation>>;
    }> = [];

    for (const raw of files) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const provider = typeof entry.provider === "string" ? entry.provider : "";
      if (provider !== "claude" && provider !== "codex") continue;
      const modelQuotas = entry.model_quotas && typeof entry.model_quotas === "object"
        ? entry.model_quotas as Record<string, unknown>
        : {};
      const exactQuota = Object.entries(modelQuotas).find(([id]) => modelsMatch(id, modelId))?.[1];
      let observation = exactQuota as Parameters<typeof parseCpaQuotaObservation>[1];

      if (!observation) {
        const generic = entry.quota as Parameters<typeof parseCpaQuotaObservation>[1];
        if (!parseCpaQuotaObservation(provider, generic)) continue;
        const name = typeof entry.name === "string"
          ? entry.name
          : typeof entry.id === "string" ? entry.id : "";
        if (!name) continue;
        const modelsResponse = await fetch(
          `${origin}/v0/management/auth-files/models?name=${encodeURIComponent(name)}`,
          { headers },
        );
        if (!modelsResponse.ok) continue;
        const modelsPayload = (await modelsResponse.json()) as { models?: unknown[] };
        const supportsModel = (modelsPayload.models ?? []).some((item) => {
          if (!item || typeof item !== "object") return false;
          const id = (item as { id?: unknown }).id;
          return typeof id === "string" && modelsMatch(id, modelId);
        });
        if (!supportsModel) continue;
        observation = generic;
      }

      const parsed = parseCpaQuotaObservation(provider, observation);
      if (parsed) candidates.push({ provider, parsed });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) =>
      Math.max(...a.parsed.windows.map((w) => w.usedPercent)) -
      Math.max(...b.parsed.windows.map((w) => w.usedPercent)),
    );
    const best = candidates[0]!;
    return {
      modelId,
      provider: best.provider,
      ...best.parsed,
      accountCount: candidates.length,
    };
  }

  /**
   * Fill capability gaps from Claude Agent SDK initialize. Exact levels already
   * returned by CPA's live registry remain authoritative; the SDK must not
   * replace them with its generic proxy fallback.
   */
  mergeSdkModelCapabilities(
    models: Array<{
      value?: string;
      resolvedModel?: string;
      supportsEffort?: boolean;
      supportedEffortLevels?: string[];
    }>,
  ): void {
    this.modelCatalog = this.modelCatalog.map((model) => {
      if (model.reasoningEfforts?.length) return model;
      const matches = models.filter((candidate) => {
        const ids = [candidate.value, candidate.resolvedModel].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        return ids.some(
          (id) =>
            id === model.id ||
            id.endsWith(`/${model.id}`) ||
            model.id.endsWith(`/${id}`),
        );
      });
      const exact = matches.find(
        (candidate) =>
          candidate.value === model.id || candidate.resolvedModel === model.id,
      );
      const source = exact ?? matches[0];
      if (!source) return model;
      if (source.supportsEffort === false) return model;
      const reasoningEfforts = parseModelReasoningEfforts(source);
      return reasoningEfforts?.length
        ? { ...model, reasoningEfforts }
        : model;
    });
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
        {
          stdio: "pipe",
          ...(this.getToken()
            ? { env: { ...process.env, MANAGEMENT_PASSWORD: this.getToken()! } }
            : {}),
        },
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
