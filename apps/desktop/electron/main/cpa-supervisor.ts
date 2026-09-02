import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { AppSettings, CpaStatus, ModelInfo, ModelQuotaInfo } from "@claude-desktop/shared";
import {
  parseModelContextLimit,
  parseModelDefaultReasoningEffort,
  parseModelReasoningEfforts,
} from "@claude-desktop/shared";
import {
  normalizeQuotaProvider,
  parseCpaQuotaObservation,
  parseCpaQuotaPayload,
  type ParsedQuota,
} from "./cpa-quota";
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
    options?: {
      stdio?: "ignore" | "inherit" | "pipe";
      env?: NodeJS.ProcessEnv;
      cwd?: string;
    },
  ) => SpawnedProcess;
  onStatusChange?: (status: CpaStatus) => void;
  /** poll interval while waiting for port after spawn (ms) */
  pollIntervalMs?: number;
  /** max wait after spawn (ms) */
  readyTimeoutMs?: number;
};

const DEFAULT_POLL_MS = 250;
/** First launch after install often waits on Defender scanning the 60MB exe. */
const DEFAULT_READY_TIMEOUT_MS = 45_000;
const DEFAULT_PROBE_TIMEOUT_MS = 300;
const QUOTA_REQUEST_TIMEOUT_MS = 15_000;
const ACTIVE_QUOTA_PROVIDERS = new Set(["kimi", "xai", "antigravity"]);
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const XAI_BILLING_URLS = [
  "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
  "https://cli-chat-proxy.grok.com/v1/billing",
] as const;
const ANTIGRAVITY_QUOTA_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
] as const;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function nestedString(source: UnknownRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return null;
}

function authProvider(entry: UnknownRecord): string {
  return normalizeQuotaProvider(entry.provider ?? entry.type);
}

function authIndex(entry: UnknownRecord): string | null {
  return nonEmptyString(entry.auth_index ?? entry.authIndex);
}

function authFileDisabled(entry: UnknownRecord): boolean {
  const value = entry.disabled;
  return value === true || value === 1 || String(value ?? "").trim().toLowerCase() === "true";
}

function quotaApiHeaders(provider: string): Record<string, string> {
  if (provider === "kimi") return { Authorization: "Bearer $TOKEN$" };
  if (provider === "xai") {
    return {
      Authorization: "Bearer $TOKEN$",
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-version": "0.2.91",
      accept: "*/*",
      "user-agent": "grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)",
    };
  }
  return {
    Authorization: "Bearer $TOKEN$",
    "Content-Type": "application/json",
    "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
  };
}

function quotaForSelectedModel(
  provider: string,
  parsed: ParsedQuota,
  modelId: string,
): ParsedQuota {
  if (provider !== "antigravity" || parsed.windows.length < 2) return parsed;
  const ignored = new Set([
    "thinking", "preview", "latest", "high", "medium", "low", "exp", "experimental",
  ]);
  const modelTokens = modelId.toLowerCase().split(/[^a-z0-9.]+/)
    .filter((token) => token.length > 1 && !ignored.has(token));
  if (modelTokens.length < 2) return parsed;
  const matches = parsed.windows.filter((window) => {
    const label = window.label.toLowerCase();
    return modelTokens.filter((token) => label.includes(token)).length >= 2;
  });
  return matches.length ? { ...parsed, windows: matches } : parsed;
}

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
  options?: {
    stdio?: "ignore" | "inherit" | "pipe";
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  },
): SpawnedProcess {
  return spawn(command, args, {
    stdio: options?.stdio ?? "ignore",
    windowsHide: true,
    detached: false,
    env: options?.env,
    cwd: options?.cwd,
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
  private readonly modelQuotaCache = new Map<string, ModelQuotaInfo>();
  private readonly modelQuotaRefreshes = new Map<string, Promise<ModelQuotaInfo | null>>();

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

  /** Return real provider quota observed by CPA or queried through its credential proxy. */
  async getModelQuota(modelId: string): Promise<ModelQuotaInfo | null> {
    const token = this.getToken();
    if (!token || !modelId.trim()) return null;
    const cacheKey = modelId.trim().toLowerCase();
    try {
      let refresh = this.modelQuotaRefreshes.get(cacheKey);
      if (!refresh) {
        refresh = this.refreshModelQuota(modelId.trim(), token).finally(() => {
          this.modelQuotaRefreshes.delete(cacheKey);
        });
        this.modelQuotaRefreshes.set(cacheKey, refresh);
      }
      const fresh = await refresh;
      if (fresh) this.modelQuotaCache.set(cacheKey, fresh);
      else this.modelQuotaCache.delete(cacheKey);
      return fresh;
    } catch {
      const cached = this.modelQuotaCache.get(cacheKey);
      return cached
        ? { ...cached, stale: true, refreshFailedAt: Date.now() }
        : null;
    }
  }

  private async refreshModelQuota(
    modelId: string,
    token: string,
  ): Promise<ModelQuotaInfo | null> {
    const origin = `http://127.0.0.1:${this.getSettings().cpaPort}`;
    const headers = { Authorization: `Bearer ${token}` };
    const response = await this.fetchQuotaUrl(
      `${origin}/v0/management/auth-files`,
      { headers },
    );
    if (!response.ok) throw new Error(`CPA quota credentials failed (${response.status})`);
    const payload = (await response.json()) as { files?: unknown[] };
    const files = Array.isArray(payload.files) ? payload.files : [];
    const candidates: Array<{
      provider: string;
      parsed: ParsedQuota;
    }> = [];
    let activeFetchFailures = 0;
    let activeProviderMatched = false;

    for (const raw of files) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      if (authFileDisabled(entry)) continue;
      const provider = authProvider(entry);
      if (
        provider !== "claude" &&
        provider !== "codex" &&
        !ACTIVE_QUOTA_PROVIDERS.has(provider)
      ) continue;
      const modelQuotas = entry.model_quotas && typeof entry.model_quotas === "object"
        ? entry.model_quotas as Record<string, unknown>
        : {};
      const exactQuota = Object.entries(modelQuotas).find(([id]) => modelsMatch(id, modelId))?.[1];
      const exactParsed = parseCpaQuotaObservation(
        provider,
        exactQuota as Parameters<typeof parseCpaQuotaObservation>[1],
      );
      if (exactParsed) {
        candidates.push({ provider, parsed: exactParsed });
        continue;
      }

      const name = nonEmptyString(entry.name ?? entry.id);
      if (!name) continue;
      let supportsModel = false;
      try {
        supportsModel = await this.authFileSupportsModel(origin, headers, name, modelId);
      } catch {
        if (ACTIVE_QUOTA_PROVIDERS.has(provider)) {
          activeProviderMatched = true;
          activeFetchFailures += 1;
        }
        continue;
      }
      if (!supportsModel) continue;

      const generic = entry.quota as Parameters<typeof parseCpaQuotaObservation>[1];
      const genericParsed = parseCpaQuotaObservation(provider, generic);
      if (genericParsed) {
        candidates.push({
          provider,
          parsed: quotaForSelectedModel(provider, genericParsed, modelId),
        });
        continue;
      }

      if (!ACTIVE_QUOTA_PROVIDERS.has(provider)) continue;
      activeProviderMatched = true;
      try {
        const parsed = await this.fetchActiveQuota(provider, entry, origin, headers);
        if (parsed) {
          candidates.push({
            provider,
            parsed: quotaForSelectedModel(provider, parsed, modelId),
          });
        }
      } catch {
        activeFetchFailures += 1;
      }
    }

    if (!candidates.length) {
      if (activeProviderMatched && activeFetchFailures > 0) {
        throw new Error("All matching CPA quota refreshes failed");
      }
      return null;
    }
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
      stale: false,
    };
  }

  private async authFileSupportsModel(
    origin: string,
    headers: Record<string, string>,
    name: string,
    modelId: string,
  ): Promise<boolean> {
    const modelsResponse = await this.fetchQuotaUrl(
      `${origin}/v0/management/auth-files/models?name=${encodeURIComponent(name)}`,
      { headers },
    );
    if (!modelsResponse.ok) throw new Error(`CPA credential models failed (${modelsResponse.status})`);
    const modelsPayload = (await modelsResponse.json()) as { models?: unknown[] };
    return (modelsPayload.models ?? []).some((item) => {
      if (typeof item === "string") return modelsMatch(item, modelId);
      if (!item || typeof item !== "object") return false;
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" && modelsMatch(id, modelId);
    });
  }

  private async fetchActiveQuota(
    provider: string,
    entry: UnknownRecord,
    origin: string,
    managementHeaders: Record<string, string>,
  ): Promise<ParsedQuota | null> {
    const index = authIndex(entry);
    if (!index) throw new Error(`CPA ${provider} credential has no auth index`);
    if (provider === "kimi") {
      const payload = await this.callQuotaApi(
        origin,
        managementHeaders,
        index,
        "GET",
        KIMI_USAGE_URL,
        quotaApiHeaders(provider),
      );
      const parsed = parseCpaQuotaPayload(provider, payload);
      if (!parsed) throw new Error("CPA Kimi quota refresh returned no data");
      return parsed;
    }
    if (provider === "xai") {
      const results = await Promise.allSettled(
        XAI_BILLING_URLS.map(async (url) => parseCpaQuotaPayload(
          provider,
          await this.callQuotaApi(
            origin,
            managementHeaders,
            index,
            "GET",
            url,
            quotaApiHeaders(provider),
          ),
        )),
      );
      const parsed = results
        .filter((result): result is PromiseFulfilledResult<ParsedQuota | null> => result.status === "fulfilled")
        .map((result) => result.value)
        .filter((quota): quota is ParsedQuota => Boolean(quota));
      if (!parsed.length) throw new Error("CPA xAI quota refresh failed");
      const weekly = parsed.find((quota) =>
        quota.windows.some((window) => window.label.toLowerCase().includes("week")),
      );
      return weekly ?? parsed[0]!;
    }

    const projectId = await this.resolveAntigravityProjectId(
      entry,
      origin,
      managementHeaders,
    );
    if (!projectId) throw new Error("CPA Antigravity credential has no project id");
    let lastError: unknown;
    for (const url of ANTIGRAVITY_QUOTA_URLS) {
      try {
        const payload = await this.callQuotaApi(
          origin,
          managementHeaders,
          index,
          "POST",
          url,
          quotaApiHeaders(provider),
          JSON.stringify({ project: projectId }),
        );
        const parsed = parseCpaQuotaPayload(provider, payload);
        if (parsed) return parsed;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("CPA Antigravity quota refresh returned no data");
  }

  private async resolveAntigravityProjectId(
    entry: UnknownRecord,
    origin: string,
    headers: Record<string, string>,
  ): Promise<string | null> {
    const metadata = asRecord(entry.metadata);
    const attributes = asRecord(entry.attributes);
    const direct = nestedString(entry, ["project_id", "projectId"])
      ?? (metadata ? nestedString(metadata, ["project_id", "projectId"]) : null)
      ?? (attributes
        ? nestedString(attributes, ["project_id", "projectId", "gemini_virtual_project"])
        : null);
    if (direct) return direct;
    const name = nonEmptyString(entry.name ?? entry.id);
    if (!name) return null;
    const response = await this.fetchQuotaUrl(
      `${origin}/v0/management/auth-files/download?name=${encodeURIComponent(name)}`,
      { headers },
    );
    if (!response.ok) return null;
    const downloaded = asRecord(await response.json());
    if (!downloaded) return null;
    const installed = asRecord(downloaded.installed);
    const web = asRecord(downloaded.web);
    return nestedString(downloaded, ["project_id", "projectId"])
      ?? (installed ? nestedString(installed, ["project_id", "projectId"]) : null)
      ?? (web ? nestedString(web, ["project_id", "projectId"]) : null);
  }

  private async callQuotaApi(
    origin: string,
    managementHeaders: Record<string, string>,
    index: string,
    method: "GET" | "POST",
    url: string,
    header: Record<string, string>,
    data?: string,
  ): Promise<unknown> {
    const response = await this.fetchQuotaUrl(`${origin}/v0/management/api-call`, {
      method: "POST",
      headers: {
        ...managementHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ authIndex: index, method, url, header, ...(data ? { data } : {}) }),
    });
    if (!response.ok) throw new Error(`CPA quota proxy failed (${response.status})`);
    const result = asRecord(await response.json());
    if (!result) throw new Error("CPA quota proxy returned invalid data");
    const status = Number(result.status_code ?? result.statusCode ?? 0);
    if (status < 200 || status >= 300) throw new Error(`CPA upstream quota failed (${status || "unknown"})`);
    return result.body;
  }

  private async fetchQuotaUrl(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUOTA_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
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
    const configDir = settings.cpaConfigPath
      ? path.dirname(settings.cpaConfigPath)
      : undefined;
    const staticDir = configDir ? path.join(configDir, "static") : undefined;
    try {
      this.child = this.spawnProcess(
        exe,
        ["--config", settings.cpaConfigPath],
        {
          stdio: "pipe",
          cwd: configDir,
          env: {
            ...process.env,
            ...(this.getToken()
              ? { MANAGEMENT_PASSWORD: this.getToken()! }
              : {}),
            ...(staticDir ? { MANAGEMENT_STATIC_PATH: staticDir } : {}),
          },
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
