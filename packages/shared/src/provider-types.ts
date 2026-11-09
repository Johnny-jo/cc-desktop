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
  | {
      type: "claude";
      authMethod: "api-key" | "oauth2";
      apiKey?: string; // 加密存储
      oauthToken?: string; // OAuth 访问令牌
    }
  | {
      type: "openai";
      authMethod: "api-key" | "oauth2";
      apiKey?: string;
      oauthToken?: string;
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
 * OAuth 配置（各 Provider 不同）
 */
export const OAuthConfigs: Record<
  ProviderType,
  {
    authorizationUrl?: string;
    tokenUrl?: string;
    scope?: string;
    clientId?: string; // 需由用户在设置中填写或从环境变量读取
  }
> = {
  claude: {
    authorizationUrl: "https://api.anthropic.com/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/oauth/token",
    scope: "messages:read messages:write",
  },
  openai: {
    authorizationUrl: "https://platform.openai.com/oauth/authorize",
    tokenUrl: "https://platform.openai.com/oauth/token",
    scope: "read",
  },
  gemini: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/generative-ai",
  },
  deepseek: {}, // DeepSeek 仅支持 API Key
  kimi: {}, // Kimi 仅支持 API Key
  xai: {}, // xAI 仅支持 API Key
  "openai-compatible": {}, // 兼容协议仅支持 API Key
};

/**
 * Provider 端点配置（用于调用 API）
 */
export const ProviderEndpoints: Record<
  Exclude<ProviderType, "openai-compatible">,
  {
    baseUrl: string;
    modelsEndpoint: string;
    chatEndpoint: string;
  }
> = {
  claude: {
    baseUrl: "https://api.anthropic.com",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/messages",
  },
  openai: {
    baseUrl: "https://api.openai.com",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/chat/completions",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/chat/completions",
  },
  kimi: {
    baseUrl: "https://api.moonshot.cn",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/chat/completions",
  },
  xai: {
    baseUrl: "https://api.x.ai",
    modelsEndpoint: "/v1/models",
    chatEndpoint: "/v1/chat/completions",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com",
    modelsEndpoint: "/v1beta/models",
    chatEndpoint: "/v1beta/models",
  },
};
