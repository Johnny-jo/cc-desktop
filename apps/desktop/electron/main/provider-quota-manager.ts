/**
 * Provider 配额管理和同步
 * 负责从各 Provider 获取模型列表、context limits、配额使用情况
 */

import type { ProviderConfig, QuotaInfo } from "@claude-desktop/shared";
import { ProviderEndpoints } from "@claude-desktop/shared";

export interface QuotaSyncResult {
  providerId: string;
  quota: QuotaInfo | null;
  error?: string;
}

export class QuotaManager {
  private cache: Map<string, { quota: QuotaInfo; cachedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 3600000; // 1 hour

  /**
   * 从 /v1/models 解析 context window
   */
  private parseContextLimitFromModels(models: any[]): number | undefined {
    if (!Array.isArray(models) || models.length === 0) return undefined;

    // 优先取第一个模型的 context_window
    for (const model of models) {
      if (model.context_window && Number.isFinite(model.context_window)) {
        return model.context_window;
      }
      if (model.context_length && Number.isFinite(model.context_length)) {
        return model.context_length;
      }
      if (model.max_tokens && Number.isFinite(model.max_tokens) && model.max_tokens >= 1024) {
        return model.max_tokens;
      }
    }
    return undefined;
  }

  /**
   * 从 Claude API 获取配额（使用 usage endpoint）
   */
  async syncClaudeQuota(apiKey: string): Promise<QuotaInfo | null> {
    try {
      // Claude 使用 https://api.anthropic.com/v1/models
      const response = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
      });

      if (!response.ok) {
        if (response.status === 401) throw new Error("Invalid Claude API key");
        throw new Error(`Claude API error: ${response.statusText}`);
      }

      const data = await response.json();
      const contextLimit = this.parseContextLimitFromModels(data.data || []);

      return {
        providerId: "claude",
        source: "api",
        limitTokens: contextLimit || 200000,
        syncedAt: Date.now(),
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * 从 OpenAI API 获取配额
   */
  async syncOpenAIQuota(apiKey: string): Promise<QuotaInfo | null> {
    try {
      // OpenAI /v1/models
      const modelsResp = await fetch("https://api.openai.com/v1/models", {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });

      if (!modelsResp.ok) {
        if (modelsResp.status === 401) throw new Error("Invalid OpenAI API key");
        throw new Error(`OpenAI API error: ${modelsResp.statusText}`);
      }

      const data = await modelsResp.json();
      const contextLimit = this.parseContextLimitFromModels(data.data || []);

      // 尝试获取使用量（OpenAI 需要额外权限）
      let usedQuota = 0;
      try {
        const usageResp = await fetch("https://api.openai.com/billing/usage?date=2024-01-01", {
          headers: {
            authorization: `Bearer ${apiKey}`,
          },
        });
        if (usageResp.ok) {
          const usage = await usageResp.json();
          usedQuota = usage.total_usage || 0;
        }
      } catch {
        // 使用量获取失败不影响主流程
      }

      return {
        providerId: "openai",
        source: "api",
        limitTokens: contextLimit || 128000,
        usedQuota,
        syncedAt: Date.now(),
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * 从 DeepSeek API 获取配额
   */
  async syncDeepSeekQuota(apiKey: string): Promise<QuotaInfo | null> {
    try {
      const response = await fetch("https://api.deepseek.com/v1/models", {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        if (response.status === 401) throw new Error("Invalid DeepSeek API key");
        throw new Error(`DeepSeek API error: ${response.statusText}`);
      }

      const data = await response.json();
      const contextLimit = this.parseContextLimitFromModels(data.data || []);

      return {
        providerId: "deepseek",
        source: "api",
        limitTokens: contextLimit || 64000,
        syncedAt: Date.now(),
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * 从 Kimi (Moonshot) API 获取配额
   */
  async syncKimiQuota(apiKey: string): Promise<QuotaInfo | null> {
    try {
      const response = await fetch("https://api.moonshot.cn/v1/models", {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        if (response.status === 401) throw new Error("Invalid Kimi API key");
        throw new Error(`Kimi API error: ${response.statusText}`);
      }

      const data = await response.json();
      const contextLimit = this.parseContextLimitFromModels(data.data || []);

      return {
        providerId: "kimi",
        source: "api",
        limitTokens: contextLimit || 8192,
        syncedAt: Date.now(),
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * 从 xAI (Grok) API 获取配额
   */
  async syncXAIQuota(apiKey: string): Promise<QuotaInfo | null> {
    try {
      const response = await fetch("https://api.x.ai/v1/models", {
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        if (response.status === 401) throw new Error("Invalid xAI API key");
        throw new Error(`xAI API error: ${response.statusText}`);
      }

      const data = await response.json();
      const contextLimit = this.parseContextLimitFromModels(data.data || []);

      return {
        providerId: "xai",
        source: "api",
        limitTokens: contextLimit || 131072,
        syncedAt: Date.now(),
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * 从 Gemini API 获取配额
   */
  async syncGeminiQuota(apiKey: string): Promise<QuotaInfo | null> {
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + apiKey);

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error("Invalid Gemini API key");
        throw new Error(`Gemini API error: ${response.statusText}`);
      }

      const data = await response.json();
      const contextLimit = this.parseContextLimitFromModels(data.models || []);

      return {
        providerId: "gemini",
        source: "api",
        limitTokens: contextLimit || 32768,
        syncedAt: Date.now(),
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * 对于 OpenAI 兼容的自定义端点，仅支持用户手输限额
   */
  createManualQuota(providerId: string, limitTokens: number): QuotaInfo {
    return {
      providerId,
      source: "manual",
      limitTokens,
      syncedAt: Date.now(),
    };
  }

  /**
   * 同步指定 Provider 的配额
   */
  async syncQuota(config: ProviderConfig, apiKey?: string): Promise<QuotaSyncResult> {
    try {
      // 先检查缓存
      const cached = this.cache.get(config.id);
      if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
        return { providerId: config.id, quota: cached.quota };
      }

      let quota: QuotaInfo | null = null;

      if (!apiKey) {
        return {
          providerId: config.id,
          quota: null,
          error: "No API key provided",
        };
      }

      switch (config.type) {
        case "claude":
          quota = await this.syncClaudeQuota(apiKey);
          break;
        case "openai":
          quota = await this.syncOpenAIQuota(apiKey);
          break;
        case "deepseek":
          quota = await this.syncDeepSeekQuota(apiKey);
          break;
        case "kimi":
          quota = await this.syncKimiQuota(apiKey);
          break;
        case "xai":
          quota = await this.syncXAIQuota(apiKey);
          break;
        case "gemini":
          quota = await this.syncGeminiQuota(apiKey);
          break;
        case "openai-compatible":
          // 兼容协议不支持自动配额查询，需要用户手输
          return {
            providerId: config.id,
            quota: null,
            error: "OpenAI-compatible endpoints require manual limit configuration",
          };
        default:
          return {
            providerId: config.id,
            quota: null,
            error: `Unknown provider type: ${config.type}`,
          };
      }

      // 应用用户的 context limit 覆盖
      if (quota && config.contextLimitOverride) {
        quota.limitTokens = config.contextLimitOverride;
      }

      // 缓存结果
      if (quota) {
        this.cache.set(config.id, { quota, cachedAt: Date.now() });
      }

      return { providerId: config.id, quota };
    } catch (err) {
      return {
        providerId: config.id,
        quota: null,
        error: String(err),
      };
    }
  }

  /**
   * 清除指定 Provider 的缓存
   */
  invalidateCache(providerId: string): void {
    this.cache.delete(providerId);
  }

  /**
   * 清除所有缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}
