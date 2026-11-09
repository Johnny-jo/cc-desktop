/**
 * Provider 配额管理和同步
 *
 * 只做「能真实拿到的东西」：
 * - 模型列表：各家的 /models（Gemini 是 /v1beta/models）。用它验证凭证是否有效。
 * - 上下文窗口：只有 Gemini 的 models 响应里带 inputTokenLimit；OpenAI 兼容的
 *   某些网关会在 model 上带 context_window / context_length。拿不到就返回
 *   undefined，交给调用方用 shared 里的内置表补——绝不编一个默认值冒充「查询结果」。
 * - 余额/已用量：各家都没有公开且通用的查询接口（旧代码里的
 *   /billing/usage?date=2024-01-01 是虚构的），所以这里不填 usedQuota。
 *   需要展示时由 CPA 侧的真实配额接口负责（见 cpa-quota.ts）。
 */

import type { ProviderConfig, ProviderModel, QuotaInfo } from "@claude-desktop/shared";
import {
  ProviderEndpoints,
  providerAuthHeaders,
  builtinContextLimit,
} from "@claude-desktop/shared";

export interface QuotaSyncResult {
  providerId: string;
  quota: QuotaInfo | null;
  models?: ProviderModel[];
  error?: string;
}

/** 兼容网关常见的上下文窗口字段名，按优先级尝试。 */
const CONTEXT_FIELD_CANDIDATES = ["context_window", "context_length", "max_context_tokens", "max_tokens"] as const;

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 15_000;

type RawModel = Record<string, unknown> & {
  id?: string;
  name?: string;
  display_name?: string;
  inputTokenLimit?: number;
  input_token_limit?: number;
};

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** 从单条 model 记录里取上下文窗口，取不到返回 undefined。 */
export function modelContextLimit(model: RawModel): number | undefined {
  for (const field of CONTEXT_FIELD_CANDIDATES) {
    const v = positiveInt(model[field]);
    // 有些网关把 max_tokens 当「输出上限」而不是窗口，几百这种明显不是窗口的值跳过。
    if (v && (field !== "max_tokens" || v >= 1024)) return v;
  }
  return positiveInt(model.inputTokenLimit) ?? positiveInt(model.input_token_limit);
}

/** Gemini 的 name 是 "models/gemini-2.5-pro"，展示与匹配都去掉前缀。 */
function stripModelsPrefix(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

export function normalizeModels(type: string, payload: unknown): ProviderModel[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  // Gemini: { models: [...] }；其余: { data: [...] }
  const raw = Array.isArray(obj.models)
    ? (obj.models as RawModel[])
    : Array.isArray(obj.data)
      ? (obj.data as RawModel[])
      : [];

  const out: ProviderModel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rawId = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";
    if (!rawId) continue;
    const id = type === "gemini" ? stripModelsPrefix(rawId) : rawId;
    const display =
      (typeof item.display_name === "string" && item.display_name.trim()) ||
      (typeof item.displayName === "string" && (item.displayName as string).trim()) ||
      id;
    const contextLimit =
      modelContextLimit(item) ??
      // 网关没给窗口时，用模型名匹配内置表；再不行就不猜。
      builtinContextLimit(id);
    out.push({ id, name: display, contextLimit });
  }
  return out;
}

export class QuotaManager {
  private cache: Map<string, { result: QuotaSyncResult; cachedAt: number }> = new Map();

  /** 计算本次同步要访问的 models URL；无法同步时返回 null。 */
  private modelsUrl(config: ProviderConfig): string | null {
    if (config.type === "openai-compatible") {
      const base = (config.auth as { baseUrl?: string }).baseUrl?.trim();
      if (!base) return null;
      return `${base.replace(/\/+$/, "")}/models`;
    }
    const endpoints = ProviderEndpoints[config.type];
    return endpoints ? `${endpoints.baseUrl}${endpoints.modelsEndpoint}` : null;
  }

  private headersFor(config: ProviderConfig, credential: string): Record<string, string> {
    if (config.type === "openai-compatible") {
      return { authorization: `Bearer ${credential}` };
    }
    return providerAuthHeaders(config.type, credential);
  }

  /**
   * 同步指定 Provider 的模型目录 + 上下文窗口。
   * 不返回「使用量」——没有可用接口。
   */
  async syncQuota(config: ProviderConfig, credential?: string): Promise<QuotaSyncResult> {
    const cached = this.cache.get(config.id);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.result;
    }

    if (!credential) {
      return { providerId: config.id, quota: null, error: "No credential configured" };
    }

    const url = this.modelsUrl(config);
    if (!url) {
      return {
        providerId: config.id,
        quota: null,
        error:
          config.type === "openai-compatible"
            ? "OpenAI-compatible providers need a base URL"
            : `${config.type} has no known models endpoint`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", ...this.headersFor(config, credential) },
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const hint =
          response.status === 401 || response.status === 403
            ? "凭证无效或无权限"
            : `HTTP ${response.status}`;
        return {
          providerId: config.id,
          quota: null,
          error: `${hint}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
        };
      }

      const payload = await response.json();
      const models = normalizeModels(config.type, payload);

      // 只在这个 provider 的所有已知模型窗口一致时才敢声称一个「provider 级」窗口；
      // 否则交给用户按模型设置（modelContextLimits），避免一个数字误导全部模型。
      const limits = Array.from(
        new Set(models.map((m) => m.contextLimit).filter((n): n is number => !!n)),
      );
      const limitTokens =
        config.contextLimitOverride ?? (limits.length === 1 ? limits[0] : undefined);

      const quota: QuotaInfo = {
        providerId: config.id,
        source: config.contextLimitOverride
          ? "manual"
          : limits.length > 0
            ? "api"
            : "builtin",
        limitTokens,
        syncedAt: Date.now(),
      };

      const result: QuotaSyncResult = { providerId: config.id, quota, models };
      this.cache.set(config.id, { result, cachedAt: Date.now() });
      return result;
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "Request timed out"
          : err instanceof Error
            ? err.message
            : String(err);
      return { providerId: config.id, quota: null, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 用户手输限额（OpenAI 兼容网关等无法自动查询的情况）。 */
  createManualQuota(providerId: string, limitTokens: number, limitPerMinute?: number): QuotaInfo {
    return {
      providerId,
      source: "manual",
      limitTokens,
      limitPerMinute,
      syncedAt: Date.now(),
    };
  }

  /**
   * 只读缓存，不发起请求：用于 `provider:get-status`，让 UI 能显示上次同步结果。
   * 过期也照常返回——调用方展示的是「上次同步到的值」，由 syncedAt 说明新鲜度。
   */
  peek(providerId: string): QuotaSyncResult | null {
    return this.cache.get(providerId)?.result ?? null;
  }

  /** 清除指定 Provider 的缓存 */
  invalidateCache(providerId: string): void {
    this.cache.delete(providerId);
  }

  /** 清除所有缓存 */
  clearCache(): void {
    this.cache.clear();
  }
}
