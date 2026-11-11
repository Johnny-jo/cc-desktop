/**
 * Provider 认证与配额管理模块
 * 支持：Claude、OpenAI、DeepSeek、Kimi、xAI、Gemini、OpenAI 兼容协议
 */

export type ProviderType = "claude" | "openai" | "deepseek" | "kimi" | "xai" | "gemini" | "openai-compatible";

export type AuthMethod = "api-key" | "oauth2";
export type ClaudeApiKeyAuth = "auto" | "x-api-key" | "bearer";

/**
 * 各 Provider 的认证配置
 */
export type ProviderAuthConfig = (
  | {
      type: "claude";
      authMethod: "api-key" | "oauth2";
      apiKey?: string; // 加密存储
      /** 自动模式遵循 CPA：官方 Anthropic 用 x-api-key，自定义服务用 Bearer。 */
      apiKeyAuth?: ClaudeApiKeyAuth;
    }
  | {
      type: "openai";
      authMethod: "api-key" | "oauth2";
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
    }) & {
      /** API Key 请求的可选地址；官方类型留空使用默认值。OAuth 使用账号后端。 */
      baseUrl?: string;
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
  /** Google Cloud 配额/计费项目（x-goog-user-project），需启用 Generative Language API。 */
  oauthProjectId?: string;
  /** Google 用户自有 OAuth 客户端需要的 scope；留空时请求 Generative Language API。 */
  oauthScopes?: string[];
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
  reasoningEfforts?: import("./models").ReasoningEffort[];
  defaultReasoningEffort?: import("./models").ReasoningEffort;
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
  /** 正在等待系统浏览器授权或手动粘贴回调。 */
  oauthPending?: boolean;
  oauthState?: string;
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

export type ProviderOAuthConfig = {
  authorizationUrl?: string;
  tokenUrl?: string;
  scope?: string;
  /** 第一方原生客户端公开 ID，不是 confidential client secret。 */
  defaultClientId?: string;
  callbackMode?: "loopback" | "manual";
  callbackPath?: string;
  /** 端点有 redirect allow-list 时只能使用这些端口。 */
  callbackPorts?: number[];
  manualRedirectUri?: string;
  tokenEncoding?: "form" | "json";
  refreshEncoding?: "form" | "json";
  authorizationParams?: Record<string, string>;
};

/**
 * 原生账号授权定义。Codex 来自 openai/codex 的 login/src/server.rs 与 auth/manager.rs；
 * Claude 来自项目锁定的 @anthropic-ai/claude-agent-sdk 0.3.318 登录实现。
 * 这些订阅凭证必须使用各自的账号后端，不能当作 Platform API key。
 * Google 使用用户自己注册的 Desktop OAuth client，不包含第三方 secret。
 */
export const OAuthConfigs: Record<ProviderType, ProviderOAuthConfig> = {
  claude: {
    authorizationUrl: "https://claude.com/cai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    defaultClientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers",
    callbackMode: "manual",
    manualRedirectUri: "https://platform.claude.com/oauth/code/callback",
    tokenEncoding: "json",
    refreshEncoding: "json",
    authorizationParams: { code: "true" },
  },
  openai: {
    authorizationUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    defaultClientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    callbackMode: "loopback",
    callbackPath: "/auth/callback",
    callbackPorts: [1455, 1457],
    tokenEncoding: "form",
    refreshEncoding: "json",
    authorizationParams: { id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs" },
  },
  gemini: {
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/generative-language.retriever",
    callbackMode: "loopback",
    callbackPath: "/oauth/callback",
    tokenEncoding: "form",
    authorizationParams: { access_type: "offline", prompt: "consent" },
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

export type ProviderUsageRange = "24h" | "7d" | "30d";
export type ProviderRequestOutcome = "success" | "failure" | "cancelled";

/** Actual reported usage; input excludes separately reported cache reads/creation. */
export type ProviderUsageMetrics = {
  requests: number;
  successes: number;
  failures: number;
  cancellations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  unreportedUsageRequests: number;
  cacheReadReportedRequests: number;
  cacheCreationReportedRequests: number;
  cacheHitRequests: number;
  /** Cancellations are excluded. No completed attempts means null, not 0%. */
  successRate: number | null;
};
export type ProviderUsageBucket = ProviderUsageMetrics & { startAt: number };
export type ProviderUsageProvider = {
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  metrics: ProviderUsageMetrics;
};
export type ProviderUsageDashboard = {
  range: ProviderUsageRange;
  startAt: number;
  endAt: number;
  bucketMs: number;
  recordingSince: number;
  metrics: ProviderUsageMetrics;
  buckets: ProviderUsageBucket[];
  providers: ProviderUsageProvider[];
};
