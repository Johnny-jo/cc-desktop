import http from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CpaStatus, ModelInfo, ProviderConfig, ProviderStatus, ProviderUsageDashboard, ProviderUsageRange } from "@claude-desktop/shared";
import type { ModelRuntime } from "./model-runtime";
import type { ProviderManager } from "./provider-manager";
import type { CredentialManager } from "./credential-manager";
import type { OAuthHandler } from "./oauth-handler";
import type { QuotaManager, QuotaSyncResult } from "./provider-quota-manager";
import { forwardProviderMessage } from "./provider-protocol";
import { listOAuthModels } from "./provider-oauth-models";
import { emptyProviderUsageMetrics, type ProviderUsageStore } from "./provider-usage-store";
import { observeProviderResponse, type ProviderResponseObservation } from "./provider-usage-reader";

type RuntimeDeps = {
  providerManager: ProviderManager;
  credentials: CredentialManager;
  oauthHandler: OAuthHandler;
  quotaManager: QuotaManager;
  getDefaultModel: () => string;
  onCatalogChanged?: (validatedProviderId?: string) => void;
  onStatusChange?: (status: CpaStatus) => void;
  forward?: typeof forwardProviderMessage;
  usageStore?: ProviderUsageStore | null;
  onUsageUpdated?: () => void;
};

/** Local account routing and protocol boundary; never starts or calls an external proxy. */
export class ProviderRuntime implements ModelRuntime {
  private server: http.Server | null = null;
  private starting: Promise<CpaStatus> | null = null;
  private status: CpaStatus = { state: "unknown" };
  private readonly token = randomBytes(32).toString("hex");
  private readonly cacheSigningKey = randomBytes(32);
  private readonly results = new Map<string, QuotaSyncResult>();
  private readonly errors = new Map<string, string>();
  private readonly epochs = new Map<string, number>();
  private readonly syncing = new Map<string, Promise<QuotaSyncResult>>();
  private disposed = false;
  private usageError: string | null = null;
  private usageNotification: NodeJS.Timeout | null = null;
  constructor(private readonly deps: RuntimeDeps) {}

  private setStatus(status: CpaStatus): CpaStatus {
    this.status = status;
    this.deps.onStatusChange?.(status);
    return status;
  }
  getStatus(): CpaStatus { return this.status; }
  ensureReady(): Promise<CpaStatus> {
    if (this.disposed) return Promise.resolve({ state: "error", message: "Provider 服务已关闭" });
    if (this.status.state === "ready") return Promise.resolve(this.status);
    if (this.starting) return this.starting;
    this.setStatus({ state: "starting" });
    this.starting = new Promise<CpaStatus>(resolve => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res).catch(() => {
          if (res.destroyed || res.writableEnded) return;
          if (res.headersSent) { res.destroy(); return; }
          this.json(res, 502, { type: "error", error: { type: "api_error", message: "上游请求失败，请检查 Provider 连接或重试。" } });
        });
      });
      this.server = server;
      server.once("error", () => resolve(this.setStatus({ state: "error", message: "无法启动本机 Provider 服务" })));
      server.listen(0, "127.0.0.1", () => {
        if (this.disposed) { server.close(); resolve({ state: "stopped" }); return; }
        const address = server.address();
        if (!address || typeof address === "string") { resolve(this.setStatus({ state: "error", message: "Provider 端口不可用" })); return; }
        server.unref();
        resolve(this.setStatus({ state: "ready", port: address.port, managedByApp: true }));
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  getProxyTarget(): { origin: string; token: string } | null {
    return this.status.state === "ready" ? { origin: `http://127.0.0.1:${this.status.port}`, token: this.token } : null;
  }
  cacheSessionHeader(sessionId: string, env: Record<string, string>): string | undefined {
    const target = this.getProxyTarget();
    if (!target || env.ANTHROPIC_BASE_URL !== target.origin || env.ANTHROPIC_AUTH_TOKEN !== target.token) return undefined;
    const id = createHash("sha256").update(sessionId).digest("hex");
    const signature = createHmac("sha256", this.cacheSigningKey).update(id).digest("hex");
    return `x-cc-cache-session: ${id}.${signature}`;
  }

  private verifiedCacheSession(header: string | string[] | undefined): string | undefined {
    if (typeof header !== "string" || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(header)) return undefined;
    const [id, signature] = header.split(".");
    const expected = createHmac("sha256", this.cacheSigningKey).update(id).digest();
    return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? id : undefined;
  }
  buildProcessEnv(model?: string): Record<string, string> {
    const target = this.getProxyTarget();
    if (!target) throw new Error("Provider 服务尚未就绪，请稍后重试");
    const env = { ...process.env } as Record<string, string>;
    // Never let a host's Anthropic key override the account selected inside the app.
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_CUSTOM_HEADERS"]) delete env[key];
    const selected = model ?? this.deps.getDefaultModel();
    return {
      ...env, ANTHROPIC_BASE_URL: target.origin, ANTHROPIC_AUTH_TOKEN: target.token, ANTHROPIC_MODEL: selected,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selected, ANTHROPIC_DEFAULT_SONNET_MODEL: selected, ANTHROPIC_DEFAULT_OPUS_MODEL: selected,
      ANTHROPIC_SMALL_FAST_MODEL: selected, CLAUDE_CODE_SUBAGENT_MODEL: selected,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false",
    };
  }
  stopIfManaged(): void {
    this.disposed = true;
    if (this.usageNotification) clearTimeout(this.usageNotification);
    this.usageNotification = null;
    this.server?.closeAllConnections(); this.server?.close(); this.server = null;
    this.setStatus({ state: "stopped" });
  }

  private async credential(config: ProviderConfig): Promise<string | null> {
    if (config.auth.authMethod === "oauth2") return this.deps.oauthHandler.ensureFreshToken(config.id);
    const encrypted = this.deps.providerManager.loadApiKey(config.id);
    return encrypted ? this.deps.credentials.decrypt(encrypted) : null;
  }
  async providerStatus(id: string): Promise<ProviderStatus | null> {
    const config = this.deps.providerManager.getConfig(id);
    if (!config) return null;
    let present = false;
    try { present = Boolean(await this.credential(config)); } catch { /* corrupt credentials require re-entry */ }
    const result = this.results.get(id);
    return {
      providerId: id, type: config.type, name: config.name, enabled: config.enabled,
      authenticated: present && Boolean(config.lastAuthenticatedAt) && !this.errors.has(id),
      quota: result?.quota ?? (config.contextLimitOverride ? { providerId: id, source: "manual", limitTokens: config.contextLimitOverride, syncedAt: config.lastQuotaSyncAt ?? 0 } : undefined),
      availableModels: result?.models,
      lastError: this.errors.get(id),
    };
  }
  setError(id: string, error?: string): void {
    if (error) this.errors.set(id, error); else this.errors.delete(id);
  }
  invalidate(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.results.delete(id); this.errors.delete(id); this.syncing.delete(id);
    this.deps.quotaManager.invalidateCache(id);
    this.deps.onCatalogChanged?.();
  }
  syncProvider(id: string): Promise<QuotaSyncResult> {
    const existing = this.syncing.get(id);
    if (existing) return existing;
    const pending = this.doSync(id).finally(() => { if (this.syncing.get(id) === pending) this.syncing.delete(id); });
    this.syncing.set(id, pending);
    return pending;
  }
  private async doSync(id: string): Promise<QuotaSyncResult> {
    const epoch = this.epochs.get(id) ?? 0;
    const config = this.deps.providerManager.getConfig(id);
    if (!config) return { providerId: id, quota: null, error: "Provider 不存在" };
    let result: QuotaSyncResult;
    try {
      const credential = await this.credential(config);
      if (!credential) throw new Error("请填写 API Key 或完成 OAuth 登录");
      if (config.auth.authMethod === "oauth2") {
        const token = this.deps.oauthHandler.loadOAuthToken(id);
        if (!token) throw new Error("请重新完成 OAuth 登录");
        const models = await listOAuthModels(config, { ...token, access_token: credential });
        result = { providerId: id, models, quota: { providerId: id, source: config.contextLimitOverride ? "manual" : "api", limitTokens: config.contextLimitOverride, syncedAt: Date.now() } };
      } else {
        this.deps.quotaManager.invalidateCache(id);
        result = await this.deps.quotaManager.syncQuota(config, credential);
      }
      if (result.error) throw new Error(result.error);
      if (!result.models?.length) throw new Error("上游未返回可用模型，请检查账号权限");
      if ((this.epochs.get(id) ?? 0) !== epoch || !this.deps.providerManager.getConfig(id)) return { providerId: id, quota: null, error: "Provider 配置已变更，请重新同步" };
      this.deps.providerManager.updateConfig(id, { lastAuthenticatedAt: Date.now(), lastQuotaSyncAt: Date.now() });
      this.results.set(id, result); this.errors.delete(id);
      this.deps.onCatalogChanged?.(id);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider 同步失败";
      if ((this.epochs.get(id) ?? 0) === epoch && this.deps.providerManager.getConfig(id)) this.errors.set(id, message);
      return { providerId: id, quota: null, error: message };
    }
  }
  async listModelCatalog(): Promise<ModelInfo[]> {
    await Promise.all(this.deps.providerManager.listConfigs().filter(c => c.enabled).map(c => this.syncProvider(c.id)));
    this.deps.onCatalogChanged?.();
    return this.getModelCatalog();
  }
  getModelCatalog(): ModelInfo[] {
    return this.deps.providerManager.listConfigs().filter(c => c.enabled).flatMap(config =>
      (this.results.get(config.id)?.models ?? []).map(model => ({
        id: `${config.id}/${model.id}`,
        contextLimit: config.contextLimitOverride ?? model.contextLimit,
        ...(model.reasoningEfforts ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
        ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      })),
    );
  }
  async getModelQuota(_model: string) { return null; } // Upstream usage is not a generic API capability.
  mergeSdkModelCapabilities(_models: Parameters<ModelRuntime["mergeSdkModelCapabilities"]>[0]): void { /* SDK proxy defaults are not upstream capabilities. */ }

  getUsage(range: ProviderUsageRange, providerId?: string): ProviderUsageDashboard {
    if (!this.deps.usageStore) throw new Error("本地用量统计数据库不可用，请检查数据目录权限后重启");
    if (this.usageError) throw new Error(this.usageError);
    const snapshot = this.deps.usageStore.dashboard(range, providerId);
    const providers = new Map(snapshot.providers.map(provider => [provider.providerId, provider]));
    for (const config of this.deps.providerManager.listConfigs()) {
      const previous = providers.get(config.id);
      providers.set(config.id, { providerId: config.id, providerName: config.name, providerType: config.type, metrics: previous?.metrics ?? emptyProviderUsageMetrics() });
    }
    snapshot.providers = [...providers.values()].sort((a, b) => a.providerName.localeCompare(b.providerName));
    return snapshot;
  }
  private recordUsage(config: ProviderConfig, observation: ProviderResponseObservation): void {
    if (!this.deps.usageStore) return;
    try {
      this.deps.usageStore.record({ at: Date.now(), providerId: config.id, providerName: config.name, providerType: config.type, ...observation });
      this.usageError = null;
    } catch {
      this.usageError = "本地用量统计写入失败，请检查磁盘空间与数据目录权限";
    }
    if (!this.disposed && !this.usageNotification) {
      this.usageNotification = setTimeout(() => { this.usageNotification = null; this.deps.onUsageUpdated?.(); }, 500);
      this.usageNotification.unref?.();
    }
  }

  async message(body: unknown, signal: AbortSignal, transport?: { anthropicBeta?: string; anthropicVersion?: string; userAgent?: string }, cacheSession?: string): Promise<Response> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("无效的 Messages 请求");
    const input = body as Record<string, unknown>;
    const model = typeof input.model === "string" ? input.model : "";
    const configs = this.deps.providerManager.listConfigs().filter(c => c.enabled);
    let config = configs.find(c => model.startsWith(`${c.id}/`));
    let upstreamModel = config ? model.slice(config.id.length + 1) : model;
    if (!config) {
      const matches = configs.filter(c => this.results.get(c.id)?.models?.some(m => m.id === model));
      if (matches.length > 1) throw new Error("多个 Provider 提供此模型，请选择带 Provider 前缀的模型");
      config = matches[0];
    }
    if (!config || !upstreamModel) throw new Error("模型所属 Provider 不存在或未启用，请在 Provider 管理中添加并同步模型");
    const epoch = this.epochs.get(config.id) ?? 0;
    const credential = await this.credential(config);
    if (!credential) throw new Error("此 Provider 未配置有效凭证，请重新登录或填写 API Key");
    const latest = this.deps.providerManager.getConfig(config.id);
    if (!latest?.enabled || latest.auth.authMethod !== config.auth.authMethod || (this.epochs.get(config.id) ?? 0) !== epoch) throw new Error("Provider 配置已变更，请重试");
    signal.throwIfAborted();
    let recorded = false;
    const record = (observation: ProviderResponseObservation) => {
      if (recorded) return;
      recorded = true;
      this.recordUsage(config!, observation);
    };
    try {
      const response = await (this.deps.forward ?? forwardProviderMessage)(config, credential, { ...input, model: upstreamModel }, {
        ...(cacheSession ? { promptCacheKey: createHash("sha256").update(JSON.stringify(["cc-v1", config.id, upstreamModel, cacheSession])).digest("hex") } : {}),
        ...transport, signal, oauthToken: config.auth.authMethod === "oauth2" ? this.deps.oauthHandler.loadOAuthToken(config.id) ?? undefined : undefined,
      });
      return observeProviderResponse(response, { signal, onComplete: record });
    } catch (error) {
      record({ outcome: signal.aborted ? "cancelled" : "failure", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usageReported: false });
      throw error;
    }
  }
  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const provided = Buffer.from(auth); const expected = Buffer.from(this.token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { this.json(res, 401, { type: "error", error: { type: "authentication_error", message: "Unauthorized" } }); return; }
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && pathname === "/v1/models") { this.json(res, 200, { data: this.getModelCatalog().map(m => ({ ...m, object: "model" })) }); return; }
    if (req.method !== "POST" || pathname !== "/v1/messages") { this.json(res, 404, { type: "error", error: { type: "not_found_error", message: "Unsupported Provider endpoint" } }); return; }
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 80 * 1024 * 1024) { this.json(res, 413, { type: "error", error: { type: "invalid_request_error", message: "请求内容过大" } }); return; }
      chunks.push(Buffer.from(chunk));
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { this.json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "请求 JSON 无效" } }); return; }
    let response: Response;
    try {
      response = await this.message(body, controller.signal, {
        anthropicBeta: typeof req.headers["anthropic-beta"] === "string" ? req.headers["anthropic-beta"] : undefined,
        anthropicVersion: typeof req.headers["anthropic-version"] === "string" ? req.headers["anthropic-version"] : undefined,
        userAgent: req.headers["user-agent"],
      }, this.verifiedCacheSession(req.headers["x-cc-cache-session"]));
    }
    catch (error) {
      if (controller.signal.aborted) return;
      this.json(res, 400, { type: "error", error: { type: "invalid_request_error", message: error instanceof Error ? error.message : "Provider 请求失败" } }); return;
    }
    const headers: Record<string, string> = { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-cache" };
    for (const name of ["retry-after", "request-id", "x-request-id", "x-provider-limitations"]) {
      const value = response.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(response.status, headers);
    if (!response.body) { res.end(); return; }
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res, { signal: controller.signal });
  }
}
