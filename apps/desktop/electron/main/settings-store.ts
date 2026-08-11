import fs from "node:fs";
import path from "node:path";
import type { AppSettings, PermissionMode, PublicSettings } from "@claude-desktop/shared";
import { normalizeRuleString, sanitizeMcpServers } from "@claude-desktop/shared";

/** Keep only syntactically valid, normalized rule strings. */
function sanitizePermissionRules(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const n = normalizeRuleString(item);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

type AgentDef = NonNullable<AppSettings["agents"]>[number];

/** Keep well-formed agent definitions (name/description/prompt required). */
function sanitizeAgents(raw: unknown): AgentDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: AgentDef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const a = item as Record<string, unknown>;
    const name = typeof a.name === "string" ? a.name.trim() : "";
    const description =
      typeof a.description === "string" ? a.description.trim() : "";
    const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
    if (!name || !description || !prompt) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) continue;
    const def: AgentDef = { name, description, prompt };
    if (Array.isArray(a.tools)) {
      def.tools = a.tools.filter((t): t is string => typeof t === "string");
    }
    if (typeof a.model === "string" && a.model.trim()) {
      def.model = a.model.trim();
    }
    out.push(def);
  }
  return out;
}

/** Keep non-empty path strings. */
function sanitizePluginPaths(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
}

export type SettingsStoreDeps = {
  userDataDir: string;
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
  logger?: { warn: (msg: string) => void };
};

/** Placeholder defaults — bootstrap overwrites with runtime-paths when possible. */
const DEFAULTS: AppSettings = {
  cpaExePath: "",
  cpaConfigPath: "",
  cpaPort: 8317,
  defaultModel: "kimi-for-coding",
  models: [
    "kimi-for-coding",
    "k3",
    "grok-4.5",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ],
  permissionMode: "default",
  shutdownCpaOnQuit: false,
  defaultContextLimit: 200_000,
  modelContextLimits: {},
  mcpServers: {},
  permissionAllow: [],
  permissionDeny: [],
  agents: [],
  pluginPaths: [],
};

type StoredFile = Partial<AppSettings> & {
  tokenEnc?: string;
};

export type SettingsUpdate = Partial<AppSettings> & {
  token?: string | null;
  /** null clears the effort override (back to model default) */
  effort?: AppSettings["effort"] | null;
};

export class SettingsStore {
  private readonly filePath: string;
  private readonly encrypt: SettingsStoreDeps["encrypt"];
  private readonly decrypt: SettingsStoreDeps["decrypt"];
  private readonly logger: { warn: (msg: string) => void };
  private settings: AppSettings;
  private token: string | null = null;
  private tokenEnc: string | undefined;

  constructor(deps: SettingsStoreDeps) {
    this.filePath = path.join(deps.userDataDir, "settings.json");
    this.encrypt = deps.encrypt;
    this.decrypt = deps.decrypt;
    this.logger = deps.logger ?? console;
    this.settings = { ...DEFAULTS };
    this.load();
  }

  get(): AppSettings {
    return {
      ...this.settings,
      models: [...this.settings.models],
      modelContextLimits: { ...this.settings.modelContextLimits },
      mcpServers: { ...this.settings.mcpServers },
      permissionAllow: [...(this.settings.permissionAllow ?? [])],
      permissionDeny: [...(this.settings.permissionDeny ?? [])],
      agents: (this.settings.agents ?? []).map((a) => ({
        ...a,
        ...(a.tools ? { tools: [...a.tools] } : {}),
      })),
      pluginPaths: [...(this.settings.pluginPaths ?? [])],
    };
  }

  getPublic(): PublicSettings {
    return {
      ...this.get(),
      hasToken: this.token !== null && this.token.length > 0,
    };
  }

  getToken(): string | null {
    return this.token;
  }

  update(patch: SettingsUpdate): void {
    const { token, ...publicPatch } = patch;

    if (publicPatch.models) {
      publicPatch.models = [...publicPatch.models];
    }
    if (publicPatch.modelContextLimits) {
      publicPatch.modelContextLimits = { ...publicPatch.modelContextLimits };
    }
    if (publicPatch.mcpServers) {
      publicPatch.mcpServers = { ...publicPatch.mcpServers };
    }
    if (publicPatch.permissionAllow !== undefined) {
      publicPatch.permissionAllow = sanitizePermissionRules(publicPatch.permissionAllow);
    }
    if (publicPatch.permissionDeny !== undefined) {
      publicPatch.permissionDeny = sanitizePermissionRules(publicPatch.permissionDeny);
    }
    if (publicPatch.agents !== undefined) {
      publicPatch.agents = sanitizeAgents(publicPatch.agents);
    }
    if (publicPatch.pluginPaths !== undefined) {
      publicPatch.pluginPaths = sanitizePluginPaths(publicPatch.pluginPaths);
    }
    const clearEffort = publicPatch.effort === null;
    if (
      publicPatch.effort !== undefined &&
      publicPatch.effort !== null &&
      publicPatch.effort !== "low" &&
      publicPatch.effort !== "medium" &&
      publicPatch.effort !== "high"
    ) {
      delete publicPatch.effort;
    }
    if (publicPatch.permissionMode !== undefined) {
      publicPatch.permissionMode = publicPatch.permissionMode as PermissionMode;
    }

    this.settings = {
      ...this.settings,
      ...publicPatch,
      models: publicPatch.models ?? this.settings.models,
    };
    if (clearEffort) {
      delete this.settings.effort;
    }

    if (token !== undefined) {
      if (token === null || token === "") {
        this.token = null;
        this.tokenEnc = undefined;
      } else {
        try {
          this.tokenEnc = this.encrypt(token);
          this.token = token;
        } catch (err) {
          this.logger.warn(
            `SettingsStore: failed to encrypt token; refusing to store. ${String(err)}`,
          );
          // leave existing token state unchanged on encrypt failure
        }
      }
    }

    this.save();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as StoredFile;
      const { tokenEnc, ...rest } = data;

      const limits =
        rest.modelContextLimits && typeof rest.modelContextLimits === "object"
          ? Object.fromEntries(
              Object.entries(rest.modelContextLimits as Record<string, unknown>)
                .map(([k, v]) => [k, Number(v)] as const)
                .filter(([, v]) => Number.isFinite(v) && v > 0),
            )
          : { ...DEFAULTS.modelContextLimits };
      const defaultContextLimit =
        typeof rest.defaultContextLimit === "number" &&
        Number.isFinite(rest.defaultContextLimit) &&
        rest.defaultContextLimit > 0
          ? Math.floor(rest.defaultContextLimit)
          : DEFAULTS.defaultContextLimit;

      this.settings = {
        ...DEFAULTS,
        ...rest,
        models: rest.models ? [...rest.models] : [...DEFAULTS.models],
        defaultContextLimit,
        modelContextLimits: limits,
        mcpServers: sanitizeMcpServers(rest.mcpServers),
        permissionAllow: sanitizePermissionRules(rest.permissionAllow) ?? [],
        permissionDeny: sanitizePermissionRules(rest.permissionDeny) ?? [],
        agents: sanitizeAgents(rest.agents) ?? [],
        pluginPaths: sanitizePluginPaths(rest.pluginPaths) ?? [],
        ...(rest.effort === "low" ||
        rest.effort === "medium" ||
        rest.effort === "high"
          ? { effort: rest.effort }
          : {}),
      };
      this.tokenEnc = tokenEnc;
      if (tokenEnc) {
        try {
          this.token = this.decrypt(tokenEnc);
        } catch (err) {
          this.logger.warn(
            `SettingsStore: failed to decrypt token; treating as missing. ${String(err)}`,
          );
          this.token = null;
        }
      }
    } catch (err) {
      this.logger.warn(`SettingsStore: failed to load settings.json. ${String(err)}`);
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload: StoredFile = {
      ...this.settings,
      ...(this.tokenEnc !== undefined ? { tokenEnc: this.tokenEnc } : {}),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
  }
}
