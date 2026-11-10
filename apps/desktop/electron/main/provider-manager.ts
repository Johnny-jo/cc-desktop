/**
 * Provider 配置和状态管理
 * 负责持久化、加密、认证和配额同步
 */

import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type {
  ProviderConfig,
  ProviderStatus,
  ProviderType,
} from "@claude-desktop/shared";
import { OAuthConfigs, ProviderEndpoints } from "@claude-desktop/shared";

export interface ProviderManagerOptions {
  userDataDir: string;
}

/**
 * Provider id 会直接拼进凭证文件名，所以必须限制字符集——否则渲染进程传一个
 * `../../x` 就能把凭证写到 userData 之外。首字符不能是 `.`，长度设上限。
 */
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidProviderId(id: unknown): id is string {
  return typeof id === "string" && PROVIDER_ID_RE.test(id);
}

function assertProviderId(id: string): string {
  if (!isValidProviderId(id)) {
    throw new Error(`Invalid provider id: ${JSON.stringify(id)}`);
  }
  return id;
}

type OAuthEndpointConfig = { authorizationUrl?: string; tokenUrl?: string; scope?: string };

function publicConfig(config: ProviderConfig): ProviderConfig {
  const auth = { ...config.auth } as ProviderConfig["auth"] & { oauthToken?: string };
  delete auth.apiKey;
  delete auth.oauthToken;
  return { ...config, auth };
}

export class ProviderManager {
  private configDir: string;
  private configFile: string;
  private configs: Map<string, ProviderConfig> = new Map();

  constructor(opts: ProviderManagerOptions) {
    this.configDir = path.join(opts.userDataDir, "providers");
    this.configFile = path.join(this.configDir, "configs.json");
    this.ensureDir();
    this.loadConfigs();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  private loadConfigs(): void {
    try {
      if (!fs.existsSync(this.configFile)) return;
      const data = fs.readFileSync(this.configFile, "utf-8");
      const configs = JSON.parse(data) as ProviderConfig[];
      if (!Array.isArray(configs)) return;
      this.configs.clear();
      for (const cfg of configs) {
        // 不加载 API Key（作为瞬时配置），认证时再从加密存储读取
        if (!cfg || !isValidProviderId(cfg.id)) continue;
        this.configs.set(cfg.id, publicConfig(cfg));
      }
    } catch (err) {
      console.warn("Failed to load provider configs:", err);
    }
  }

  private saveConfigs(): void {
    try {
      const configs = Array.from(this.configs.values()).map((cfg) => ({
        ...cfg,
        auth: { ...cfg.auth, apiKey: undefined }, // 不持久化密钥
      }));
      // 先写临时文件再 rename：中途崩溃不会留下半截 JSON 把配置全丢掉。
      const tmp = `${this.configFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(configs, null, 2), "utf-8");
      fs.renameSync(tmp, this.configFile);
    } catch (err) {
      throw new Error("Provider 配置保存失败，请检查磁盘空间与目录权限", { cause: err });
    }
  }

  /** 列出所有 Provider 配置 */
  listConfigs(): ProviderConfig[] {
    return Array.from(this.configs.values()).map(publicConfig);
  }

  /** 获取单个 Provider 配置 */
  getConfig(id: string): ProviderConfig | null {
    const config = this.configs.get(id);
    return config ? publicConfig(config) : null;
  }

  /** 添加 Provider 配置 */
  addConfig(config: ProviderConfig): string {
    const id = config.id || `${config.type}-${Date.now()}`;
    assertProviderId(id);
    const previous = this.configs.get(id);
    this.configs.set(id, publicConfig({ ...config, id }));
    try { this.saveConfigs(); }
    catch (error) { if (previous) this.configs.set(id, previous); else this.configs.delete(id); throw error; }
    return id;
  }

  /** 更新 Provider 配置（auth 做深合并，避免把 authMethod 之类的字段冲掉） */
  updateConfig(id: string, updates: Partial<ProviderConfig>): boolean {
    const existing = this.configs.get(id);
    if (!existing) return false;
    const { auth: authPatch, ...rest } = updates;
    const updated: ProviderConfig = {
      ...existing,
      ...rest,
      id, // 保持 id 不变
      auth: authPatch
        ? ({ ...existing.auth, ...authPatch } as ProviderConfig["auth"])
        : existing.auth,
    };
    this.configs.set(id, publicConfig(updated));
    try { this.saveConfigs(); }
    catch (error) { this.configs.set(id, existing); throw error; }
    return true;
  }

  /** 删除 Provider 配置 */
  deleteConfig(id: string): boolean {
    const existing = this.configs.get(id);
    const deleted = this.configs.delete(id);
    if (deleted) {
      try { this.saveConfigs(); }
      catch (error) { this.configs.set(id, existing!); throw error; }
    }
    return deleted;
  }

  // ── 凭证文件 ────────────────────────────────────────────────────────────
  // 凭证与配置分开存放：configs.json 永不含密钥，凭证单独文件（内容已加密）。

  private credentialFile(id: string, suffix: "key" | "oauth"): string {
    return path.join(this.configDir, `${assertProviderId(id)}.${suffix}`);
  }

  /** 保存加密的 API Key（调用者负责加密） */
  saveApiKey(providerId: string, encryptedKey: string): void {
    fs.writeFileSync(this.credentialFile(providerId, "key"), encryptedKey, "utf-8");
  }

  /** 读取加密的 API Key */
  loadApiKey(providerId: string): string | null {
    return this.readCredential(providerId, "key");
  }

  /** 删除保存的 API Key */
  deleteApiKey(providerId: string): void {
    this.unlinkCredential(providerId, "key");
  }

  /** 保存加密的 OAuth token（JSON 串） */
  saveOAuthToken(providerId: string, encryptedToken: string): void {
    fs.writeFileSync(this.credentialFile(providerId, "oauth"), encryptedToken, "utf-8");
  }

  /** 读取加密的 OAuth token */
  loadOAuthToken(providerId: string): string | null {
    return this.readCredential(providerId, "oauth");
  }

  /** 删除保存的 OAuth token */
  deleteOAuthToken(providerId: string): void {
    this.unlinkCredential(providerId, "oauth");
  }

  /** 该 provider 是否已存有任意凭证（API Key 或 OAuth token） */
  hasCredential(providerId: string): boolean {
    if (!isValidProviderId(providerId)) return false;
    return (
      fs.existsSync(this.credentialFile(providerId, "key")) ||
      fs.existsSync(this.credentialFile(providerId, "oauth"))
    );
  }

  private readCredential(providerId: string, suffix: "key" | "oauth"): string | null {
    if (!isValidProviderId(providerId)) return null;
    const file = this.credentialFile(providerId, suffix);
    if (!fs.existsSync(file)) return null;
    try {
      return fs.readFileSync(file, "utf-8");
    } catch {
      return null;
    }
  }

  private unlinkCredential(providerId: string, suffix: "key" | "oauth"): void {
    if (!isValidProviderId(providerId)) return;
    const file = this.credentialFile(providerId, suffix);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  /**
   * 获取 Provider 状态快照。
   * authenticated 取决于磁盘上是否真的有凭证文件——config.auth.apiKey 在保存时
   * 就被剥掉了，所以旧代码用 `!!config.auth.apiKey` 判断永远返回 false。
   */
  getStatus(id: string): ProviderStatus | null {
    const config = this.getConfig(id);
    if (!config) return null;

    return {
      providerId: id,
      type: config.type,
      name: config.name,
      enabled: config.enabled,
      authenticated: this.hasCredential(id),
      quota: undefined, // 由 QuotaManager 填充
      availableModels: undefined, // 由模型同步模块填充
    };
  }

  /** 生成 OAuth 状态参数 */
  generateOAuthState(): string {
    return randomBytes(32).toString("hex");
  }

  /** 获取 OAuth 配置（端点 + scope；不含 clientId） */
  getOAuthConfig(providerType: string): OAuthEndpointConfig {
    if (!(providerType in OAuthConfigs)) return {};
    return OAuthConfigs[providerType as ProviderType] || {};
  }

  /** 获取 Provider 端点 */
  getEndpoint(
    providerType: string,
  ): (typeof ProviderEndpoints)[keyof typeof ProviderEndpoints] | null {
    if (providerType === "openai-compatible") return null; // 用户提供 baseUrl
    if (!(providerType in ProviderEndpoints)) return null;
    return ProviderEndpoints[providerType as keyof typeof ProviderEndpoints] || null;
  }
}
