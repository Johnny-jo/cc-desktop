/**
 * Provider 认证与配额管理模块
 * 支持：Claude、OpenAI、DeepSeek、Kimi、xAI、Gemini、OpenAI 兼容协议
 */

export type ProviderType = "claude" | "openai" | "deepseek" | "kimi" | "xai" | "gemini" | "openai-compatible";

export type AuthMethod = "api-key" | "oauth2";

/**
 * 各 Provider 的认证配置
 */
export type ProviderAuthConfig =
  // Anthropic 与 OpenAI 都没有可供第三方桌面应用调用的公开 OAuth 授权码端点
  // （它们只在自家 CLI 内部走各自流程），因此这里只支持 API Key。
  | {
      type: "claude";
      authMethod: "api-key";
      apiKey?: string; // 加密存储
    }
  | {
      type: "openai";
      authMethod: "api-key";
      apiKey?: string;
    }
  | {
      type: "deepseek";
      authMethod: "api-key";
      apiKey?: string;
    }
  | {
      type: "kimi";
      authMethod: "api-key";
      apiKey?: string;
    }
  | {
      type: "xai";
      authMethod: "api-key";
      apiKey?: string;
    }
  | {
      type: "gemini";
      authMethod: "api-key" | "oauth2";
      apiKey?: string;
      oauthToken?: string;
    }
  | {
      type: "openai-compatible";
      authMethod: "api-key";
      apiKey?: string;
      baseUrl: string; // 如 http://127.0.0.1:8317
    };

/**
 * Provider 的基本信息与配置
 */
export type ProviderConfig = {
  id: string; // 唯一标识，如 "claude-1", "openai-primary"
  name: string; // 用户可见的名称
  type: ProviderType;
  auth: ProviderAuthConfig;
  enabled: boolean;
  /** 用户设置的上下文窗口限制（单位 token），用于本地计算和限制 */
  contextLimitOverride?: number;
  /** 用户设置的每分钟请求限制 */
  rateLimitOverride?: number;
  /** 最后成功认证的时间戳 */
  lastAuthenticatedAt?: number;
  /** 最后配额同步的时间戳 */
  lastQuotaSyncAt?: number;
  /**
   * OAuth 客户端 ID（公开信息，可明文持久化）。仅对支持 OAuth 的 provider 有意义。
   * client secret 不放在这里 —— 桌面应用是公共客户端，走 PKCE，不需要也不该保存 secret。
   */
  oauthClientId?: string;
};

/**
 * 配额信息（来自 API 或用户手输）
 */
export type QuotaInfo = {
  providerId: string;
  source: "api" | "manual" | "builtin"; // api: 从 /v1/models 或专有接口、manual: 用户手输、builtin: 内置表
  limitTokens?: number; // 模型上下文窗口限制
  usedTokens?: number; // 已使用的 token
  totalQuota?: number; // 总额度
  usedQuota?: number; // 已使用
  remainingQuota?: number; // 剩余
  resetTime?: number; // 重置时间戳
  limitPerMinute?: number; // RPM 限制
  limitPerDay?: number; // 日限制
  syncedAt: number; // 本次同步时间
  expiresAt?: number; // 配额过期时间
  error?: string; // 同步失败时的错误信息
};

/**
 * Provider 可用模型列表（从 /v1/models 获取）
 */
export type ProviderModel = {
  id: string;
  name: string;
  contextLimit?: number;
  costPerMTok?: number; // 百万 token 成本
  supported?: boolean; // 是否在当前配额周期内可用
};

/**
 * Provider 状态快照（用于 UI 显示）
 */
export type ProviderStatus = {
  providerId: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  authenticated: boolean;
  lastError?: string;
  quota?: QuotaInfo;
  availableModels?: ProviderModel[];
};

/**
 * 认证状态
 */
export type AuthenticationStatus = {
  providerId: string;
  authenticated: boolean;
  method: AuthMethod;
  expiresAt?: number; // 对于 OAuth，可能有过期时间
  error?: string;
};

/**
 * OAuth 配置（各 Provider 不同）。
 *
 * 只有确实存在「第三方公共客户端可用」的授权码端点的 provider 才在此登记。
 * claude / openai 没有这样的公开端点（上一版凭猜测写下的 api.anthropic.com/oauth/*
 * 与 platform.openai.com/oauth/* 并不存在），所以留空、仅支持 API Key。
 *
 * clientId 由用户在自己的云控制台注册后填入（见 ProviderConfig.oauthClientId），
 * 这里只放端点与 scope。
 */
export const OAuthConfigs: Record<
  ProviderType,
  {
    authorizationUrl?: string;
    tokenUrl?: string;
    scope?: string;
  }
> = {
  claude: {}, // 无公开 OAuth 授权码端点，仅支持 API Key
  openai: {}, // 同上
  gemini: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/generative-language",
  },
  deepseek: {}, // DeepSeek 仅支持 API Key
  kimi: {}, // Kimi 仅支持 API Key
  xai: {}, // xAI 仅支持 API Key
  "openai-compatible": {}, // 兼容协议仅支持 API Key
};

/** 该 provider 类型是否支持 OAuth 登录（供 UI 决定是否显示「OAuth 2.0」选项）。 */
export function supportsOAuth(type: ProviderType): boolean {
  return Boolean(OAuthConfigs[type]?.authorizationUrl && OAuthConfigs[type]?.tokenUrl);
}

/**
 * Provider 端点配置（用于调用 API）
 */
export const ProviderEndpoints: Record<
  Exclude<ProviderType, "openai-compatible">,
  {
    baseUrl: string;
    modelsEndpoint: string;
    chatEndpoint: string;
    /**
     * 该 provider 的鉴权头格式。Anthropic 用 x-api-key + anthropic-version，
     * Google 用 x-goog-api-key，其余用 Bearer。
     */
    authHeader: "bearer" | "x-api-key" | "x-goog-api-key";
  }
> = {
  claude: {
    baseUrl: "https://api.anthropic.com",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/messages",
    authHeader: "x-api-key",
  },
  openai: {
    baseUrl: "https://api.openai.com",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/chat/completions",
    authHeader: "bearer",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/chat/completions",
    authHeader: "bearer",
  },
  kimi: {
    baseUrl: "https://api.moonshot.cn",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/chat/completions",
    authHeader: "bearer",
  },
  xai: {
    baseUrl: "https://api.x.ai",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/chat/completions",
    authHeader: "bearer",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com",
    modelsEndpoint: "/v1beta/models",
    chatEndpoint: "/v1beta/models",
    authHeader: "x-goog-api-key",
  },
};

/**
 * 构造请求某个 provider 的鉴权头。
 * Anthropic 额外要求 anthropic-version，否则 /v1/models 会 400。
 */
export function providerAuthHeaders(
  type: Exclude<ProviderType, "openai-compatible">,
  credential: string,
): Record<string, string> {
  const spec = ProviderEndpoints[type];
  switch (spec.authHeader) {
    case "x-api-key":
      return { "x-api-key": credential, "anthropic-version": "2023-06-01" };
    case "x-goog-api-key":
      return { "x-goog-api-key": credential };
    default:
      return { authorization: `Bearer ${credential}` };
  }
}
