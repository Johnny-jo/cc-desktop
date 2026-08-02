import fs from "node:fs";
import path from "node:path";
import type { AppSettings, PermissionMode, PublicSettings } from "@claude-desktop/shared";

export type SettingsStoreDeps = {
  userDataDir: string;
  encrypt: (plain: string) => string;
  decrypt: (cipher: string) => string;
  logger?: { warn: (msg: string) => void };
};

const DEFAULTS: AppSettings = {
  cpaExePath: "D:\\gitrep\\CC\\CPA\\cli-proxy-api.exe",
  cpaConfigPath: "D:\\gitrep\\CC\\CPA\\config.yaml",
  cpaPort: 8317,
  defaultModel: "kimi-for-coding",
  models: ["kimi-for-coding", "k3", "grok-4.5"],
  permissionMode: "default",
  shutdownCpaOnQuit: false,
};

type StoredFile = Partial<AppSettings> & {
  tokenEnc?: string;
};

export type SettingsUpdate = Partial<AppSettings> & {
  token?: string | null;
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
    return { ...this.settings, models: [...this.settings.models] };
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
    if (publicPatch.permissionMode !== undefined) {
      publicPatch.permissionMode = publicPatch.permissionMode as PermissionMode;
    }

    this.settings = {
      ...this.settings,
      ...publicPatch,
      models: publicPatch.models ?? this.settings.models,
    };

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
      this.settings = {
        ...DEFAULTS,
        ...rest,
        models: rest.models ? [...rest.models] : [...DEFAULTS.models],
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
