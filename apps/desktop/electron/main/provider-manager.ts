/**
 * Provider 配置和状态管理
 * 负责持久化、加密、认证和配额同步
 */

import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import type { ProviderConfig, ProviderAuthConfig, ProviderStatus, QuotaInfo } from "@claude-desktop/shared";
import { ProviderEndpoints, OAuthConfigs } from "@claude-desktop/shared";

export interface ProviderManagerOptions {
  userDataDir: string;
}

export class ProviderManager {
  private configDir: string;
  private configFile: string;
  private configs: Map<string, ProviderConfig> = new Map();
  private statusCache: Map<string, ProviderStatus> = new Map();

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
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, "utf-8");
        const configs = JSON.parse(data) as ProviderConfig[];
        this.configs.clear();
        configs.forEach((cfg) => {
          // 不加载 API Key（作为瞬时配置），认证时再从加密存储读取
          this.configs.set(cfg.id, { ...cfg, auth: { ...cfg.auth } });
        });
      }
    } catch (err) {
      console.warn("Failed to load provider configs:", err);
    }
  }

  private saveConfigs(): void {
    try {
      const configs = Array.from(this.configs.values()).map((cfg) => ({
        ...cfg,
        auth: { ...cfg.auth, apiKey: undefined, oauthToken: undefined }, // 不持久化密钥
      }));
      fs.writeFileSync(this.configFile, JSON.stringify(configs, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save provider configs:", err);
    }
  }

  /** 列出所有 Provider 配置 */
  listConfigs(): ProviderConfig[] {
    return Array.from(this.configs.values());
  }

  /** 获取单个 Provider 配置 */
  getConfig(id: string): ProviderConfig | null {
    return this.configs.get(id) || null;
  }

  /** 添加 Provider 配置 */
  addConfig(config: ProviderConfig): string {
    const id = config.id || `${config.type}-${Date.now()}`;
    const finalConfig: ProviderConfig = { ...config, id };
    this.configs.set(id, finalConfig);
    this.saveConfigs();
    return id;
  }

  /** 更新 Provider 配置 */
  updateConfig(id: string, updates: Partial<ProviderConfig>): boolean {
    const existing = this.configs.get(id);
    if (!existing) return false;
    const updated = { ...existing, ...updates, id }; // 保持 id 不变
    this.configs.set(id, updated);
    this.saveConfigs();
    return true;
  }

  /** 删除 Provider 配置 */
  deleteConfig(id: string): boolean {
    const deleted = this.configs.delete(id);
    if (deleted) {
      this.saveConfigs();
      this.statusCache.delete(id);
    }
    return deleted;
  }

  /** 保存加密的 API Key（调用者负责加密） */
  saveApiKey(providerId: string, encryptedKey: string): void {
    const keyFile = path.join(this.configDir, `${providerId}.key`);
    fs.writeFileSync(keyFile, encryptedKey, "utf-8");
  }

  /** 读取加密的 API Key */
  loadApiKey(providerId: string): string | null {
    const keyFile = path.join(this.configDir, `${providerId}.key`);
    if (!fs.existsSync(keyFile)) return null;
    try {
      return fs.readFileSync(keyFile, "utf-8");
    } catch {
      return null;
    }
  }

  /** 删除保存的 API Key */
  deleteApiKey(providerId: string): void {
    const keyFile = path.join(this.configDir, `${providerId}.key`);
    if (fs.existsSync(keyFile)) {
      fs.unlinkSync(keyFile);
    }
  }

  /** 获取 Provider 状态快照 */
  getStatus(id: string): ProviderStatus | null {
    const config = this.getConfig(id);
    if (!config) return null;

    return {
      providerId: id,
      type: config.type,
      name: config.name,
      enabled: config.enabled,
      authenticated: !!config.auth.apiKey || !!(config.auth as any).oauthToken,
      quota: undefined, // 由 QuotaSyncManager 填充
      availableModels: undefined, // 由模型同步模块填充
    };
  }

  /** 生成 OAuth 状态参数 */
  generateOAuthState(): string {
    return randomBytes(32).toString("hex");
  }

  /** 获取 OAuth 配置 */
  getOAuthConfig(providerType: string): (typeof OAuthConfigs)[keyof typeof OAuthConfigs] {
    return OAuthConfigs[providerType as keyof typeof OAuthConfigs] || {};
  }

  /** 获取 Provider 端点 */
  getEndpoint(providerType: string): (typeof ProviderEndpoints)[keyof typeof ProviderEndpoints] | null {
    if (providerType === "openai-compatible") return null; // 用户提供 baseUrl
    return ProviderEndpoints[providerType as keyof typeof ProviderEndpoints] || null;
  }
}
