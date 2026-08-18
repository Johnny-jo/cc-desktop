import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Resolve bundled Claude Code CLI + CPA binaries for dev and packaged builds.
 *
 * Packaged layout (electron-builder extraResources):
 *   resources/bin/claude/claude.exe
 *   resources/bin/cpa/cli-proxy-api.exe
 *   resources/bin/cpa/config.template.yaml
 *
 * User-writable CPA config is materialised under userData/cpa/config.yaml.
 */

export type RuntimePathEnv = {
  isPackaged: boolean;
  /** Electron process.resourcesPath when packaged */
  resourcesPath?: string;
  /** app.getPath("userData") */
  userDataDir: string;
  /** process.platform */
  platform?: NodeJS.Platform;
  /** Optional override for tests / monorepo root */
  projectRoot?: string;
  /**
   * Dev-time CPA source dir (exe + optional config.yaml).
   * Defaults to CLAUDE_DESKTOP_CPA_DIST or D:\gitrep\CC\CPA on Windows.
   */
  cpaDistDir?: string;
};

const LEGACY_CPA_DEFAULTS = {
  exe: "D:\\gitrep\\CC\\CPA\\cli-proxy-api.exe",
  config: "D:\\gitrep\\CC\\CPA\\config.yaml",
};

function claudeBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

function cpaBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
}

/** Packaged extraResources root: <resources>/bin */
export function bundledBinRoot(env: RuntimePathEnv): string {
  const resources =
    env.resourcesPath ??
    (typeof process !== "undefined" ? process.resourcesPath : "");
  return path.join(resources, "bin");
}

/**
 * Locate the Agent SDK platform package's claude binary (dev / as dependency).
 * Returns null when the optional dependency is not installed for this platform.
 */
export function resolveSdkClaudeExecutable(
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pkg =
    platform === "win32"
      ? "@anthropic-ai/claude-agent-sdk-win32-x64"
      : platform === "darwin"
        ? process.arch === "arm64"
          ? "@anthropic-ai/claude-agent-sdk-darwin-arm64"
          : "@anthropic-ai/claude-agent-sdk-darwin-x64"
        : process.arch === "arm64"
          ? "@anthropic-ai/claude-agent-sdk-linux-arm64"
          : "@anthropic-ai/claude-agent-sdk-linux-x64";
  const binary = claudeBinaryName(platform);
  try {
    const require = createRequire(__filename);
    const pkgJson = require.resolve(`${pkg}/package.json`);
    const candidate = path.join(path.dirname(pkgJson), binary);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // optional dependency missing
  }
  return null;
}

export function getClaudeExecutablePath(env: RuntimePathEnv): string | null {
  const platform = env.platform ?? process.platform;
  const name = claudeBinaryName(platform);

  if (env.isPackaged) {
    const p = path.join(bundledBinRoot(env), "claude", name);
    return fs.existsSync(p) ? p : null;
  }

  // Dev: prefer vendor/ (after prepare-vendor), then SDK optional package.
  const root = env.projectRoot ?? findProjectRoot();
  const vendor = path.join(root, "vendor", "win-x64", "claude", name);
  if (platform === "win32" && fs.existsSync(vendor)) return vendor;

  return resolveSdkClaudeExecutable(platform);
}

/** True when the saved exe lives inside a previous Claude Desktop install. */
export function isBundledAppCpaPath(exePath: string): boolean {
  const n = exePath.replace(/\\/g, "/").toLowerCase();
  return (
    n.includes("/resources/bin/cpa/") ||
    n.endsWith("/resources/bin/cpa/cli-proxy-api.exe") ||
    n.endsWith("/resources/bin/cpa/cli-proxy-api")
  );
}

export function getCpaExecutablePath(env: RuntimePathEnv): string {
  const platform = env.platform ?? process.platform;
  const name = cpaBinaryName(platform);

  if (env.isPackaged) {
    // Packaged builds must never fall back to a developer machine path.
    return path.join(bundledBinRoot(env), "cpa", name);
  }

  const root = env.projectRoot ?? findProjectRoot();
  const vendor = path.join(root, "vendor", "win-x64", "cpa", name);
  if (fs.existsSync(vendor)) return vendor;

  const dist =
    env.cpaDistDir ??
    process.env.CLAUDE_DESKTOP_CPA_DIST ??
    (platform === "win32" ? "D:\\gitrep\\CC\\CPA" : "");
  if (dist) {
    const p = path.join(dist, name);
    if (fs.existsSync(p)) return p;
  }

  // Last resort: keep legacy default so existing settings still make sense.
  return LEGACY_CPA_DEFAULTS.exe;
}

/** Template shipped with the app (read-only in packaged builds). */
export function getCpaConfigTemplatePath(env: RuntimePathEnv): string | null {
  if (env.isPackaged) {
    const p = path.join(bundledBinRoot(env), "cpa", "config.template.yaml");
    return fs.existsSync(p) ? p : null;
  }
  const root = env.projectRoot ?? findProjectRoot();
  const vendor = path.join(
    root,
    "vendor",
    "win-x64",
    "cpa",
    "config.template.yaml",
  );
  if (fs.existsSync(vendor)) return vendor;
  // Repo-tracked template (always available in monorepo).
  const tracked = path.join(
    root,
    "apps",
    "desktop",
    "resources",
    "cpa",
    "config.template.yaml",
  );
  if (fs.existsSync(tracked)) return tracked;
  return null;
}

/** Writable config path under userData. */
export function getCpaUserConfigPath(env: RuntimePathEnv): string {
  return path.join(env.userDataDir, "cpa", "config.yaml");
}

export function getModCacheDir(env: RuntimePathEnv): string {
  return path.join(env.userDataDir, "mod-cache");
}

export function getKernelCacheDir(env: RuntimePathEnv): string {
  return path.join(env.userDataDir, "kernel-mod-cache");
}

/** Bundled packs: extraResources/mods when packaged, apps/desktop/resources/mods in dev. */
export function getBundledModsDir(env: RuntimePathEnv): string {
  if (env.isPackaged) {
    const resources =
      env.resourcesPath ??
      (typeof process !== "undefined" ? process.resourcesPath : "");
    return path.join(resources, "mods");
  }
  if (env.projectRoot) {
    return path.join(env.projectRoot, "apps", "desktop", "resources", "mods");
  }
  return path.resolve(__dirname, "../../resources/mods");
}

const MOD_CHECKSUM_RE = /^[0-9a-f]{64}$/;
const MOD_ROOM_ID_RE = /^[A-Za-z0-9_-]+$/;

export function getModCachePath(env: RuntimePathEnv, checksum: string): string {
  if (!MOD_CHECKSUM_RE.test(checksum)) {
    throw new Error("invalid mod checksum");
  }
  return path.join(getModCacheDir(env), checksum);
}

export function getModPersistPath(env: RuntimePathEnv, roomId: string): string {
  if (!MOD_ROOM_ID_RE.test(roomId)) {
    throw new Error("invalid room id");
  }
  return path.join(env.userDataDir, "rooms", `${roomId}.mod.json`);
}

export function getKernelStorePath(env: RuntimePathEnv, roomId: string): string {
  if (!MOD_ROOM_ID_RE.test(roomId)) {
    throw new Error("invalid room id");
  }
  return path.join(env.userDataDir, "rooms", `${roomId}.kernel-store.json`);
}

export function getKernelImprovePath(env: RuntimePathEnv, roomId: string): string {
  if (!MOD_ROOM_ID_RE.test(roomId)) {
    throw new Error("invalid room id");
  }
  return path.join(env.userDataDir, "rooms", `${roomId}.kernel-improve.json`);
}

function readCpaConfigTemplate(env: RuntimePathEnv): string {
  const template = getCpaConfigTemplatePath(env);
  if (template && fs.existsSync(template)) {
    return fs.readFileSync(template, "utf8");
  }
  return defaultCpaConfigYaml();
}

/**
 * Ensure userData/cpa/config.yaml exists.
 * Copies from template (or legacy config) and rewrites host/port/api-keys placeholders.
 */
export function materializeCpaConfig(
  env: RuntimePathEnv,
  opts?: {
    port?: number;
    /** Gateway client key written into api-keys (optional) */
    apiKey?: string | null;
  },
): string {
  const dest = getCpaUserConfigPath(env);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (!fs.existsSync(dest)) {
    const body = applyCpaConfigDefaults(readCpaConfigTemplate(env), {
      port: opts?.port ?? 8317,
      apiKey: opts?.apiKey,
      mode: "full",
    });
    fs.writeFileSync(dest, body, "utf8");
  }

  return dest;
}

/**
 * Create or overwrite userData CPA config with the given gateway api key.
 * Used by first-run onboarding so the client token matches CPA api-keys.
 */
export function writeCpaConfigWithApiKey(
  env: RuntimePathEnv,
  opts: { port?: number; apiKey: string },
): string {
  const dest = getCpaUserConfigPath(env);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Onboarding only: prefer template seed if missing; otherwise patch existing.
  // Callers must not use this on every boot — use repairCpaManagementConfig.
  let base = fs.existsSync(dest)
    ? fs.readFileSync(dest, "utf8")
    : readCpaConfigTemplate(env);
  const body = applyCpaConfigDefaults(base, {
    port: opts.port ?? 8317,
    apiKey: opts.apiKey,
    mode: "full",
  });
  fs.writeFileSync(dest, body, "utf8");
  return dest;
}

/**
 * Resolve effective CPA paths for Settings / CpaSupervisor.
 * - If the user already saved non-legacy custom paths that exist, keep them.
 * - Otherwise prefer bundled / vendor / dist paths.
 */
export function resolveEffectiveCpaPaths(
  env: RuntimePathEnv,
  settings: { cpaExePath: string; cpaConfigPath: string; cpaPort: number },
  opts?: { apiKey?: string | null },
): { cpaExePath: string; cpaConfigPath: string } {
  const bundledExe = getCpaExecutablePath(env);
  const userConfig = materializeCpaConfig(env, {
    port: settings.cpaPort,
    apiKey: opts?.apiKey,
  });

  const exeIsLegacy =
    !settings.cpaExePath ||
    settings.cpaExePath === LEGACY_CPA_DEFAULTS.exe ||
    settings.cpaExePath.includes("D:\\gitrep\\CC\\CPA") ||
    settings.cpaExePath.includes("D:/gitrep/CC/CPA");
  const configIsLegacy =
    !settings.cpaConfigPath ||
    settings.cpaConfigPath === LEGACY_CPA_DEFAULTS.config ||
    settings.cpaConfigPath.includes("D:\\gitrep\\CC\\CPA") ||
    settings.cpaConfigPath.includes("D:/gitrep/CC/CPA");

  // Packaged: always the exe shipped next to this build. Settings often still
  // point at a previous install dir after upgrade / reinstall; that leftover
  // file can exist but be incomplete, so existence is not enough.
  const preferBundled =
    env.isPackaged ||
    exeIsLegacy ||
    !settings.cpaExePath ||
    !fs.existsSync(settings.cpaExePath) ||
    isBundledAppCpaPath(settings.cpaExePath);

  const cpaExePath = preferBundled ? bundledExe : settings.cpaExePath;

  const cpaConfigPath =
    !configIsLegacy && fs.existsSync(settings.cpaConfigPath)
      ? settings.cpaConfigPath
      : userConfig;

  return { cpaExePath, cpaConfigPath };
}

export type CpaConfigApplyMode =
  /** First-time seed / onboarding: may write api-keys + secret-key. */
  | "full"
  /**
   * Bootstrap repair only: enable management panel + fill EMPTY secret-key.
   * NEVER overwrites non-empty api-keys / secret-key / provider blocks.
   */
  | "repair-panel";

export function applyCpaConfigDefaults(
  yaml: string,
  opts: {
    port: number;
    apiKey?: string | null;
    /** default "full" for onboarding/seed; use "repair-panel" on every boot */
    mode?: CpaConfigApplyMode;
  },
): string {
  const mode = opts.mode ?? "full";
  let out = yaml;
  // Force localhost binding for desktop embedding (safe; desktop must bind local).
  out = out.replace(/^host:\s*.*$/m, 'host: "127.0.0.1"');
  out = out.replace(/^port:\s*\d+\s*$/m, `port: ${opts.port}`);
  // Prefer user home auth-dir so existing CPA logins are reused.
  const authDir = path.join(os.homedir(), ".cli-proxy-api").replace(/\\/g, "\\\\");
  if (/^auth-dir:\s*/m.test(out)) {
    out = out.replace(/^auth-dir:\s*.*$/m, `auth-dir: "${authDir}"`);
  } else {
    out = `auth-dir: "${authDir}"\n` + out;
  }
  // Management panel must be enabled for /management.html.
  if (/disable-control-panel:\s*/m.test(out)) {
    out = out.replace(
      /disable-control-panel:\s*.*$/m,
      "disable-control-panel: false",
    );
  } else if (/^remote-management:\s*$/m.test(out) || /^remote-management:/m.test(out)) {
    out = out.replace(
      /^(remote-management:\s*\n)/m,
      "$1  disable-control-panel: false\n",
    );
  }

  if (mode === "repair-panel") {
    // Only fill secret-key when missing/empty. Never touch api-keys or a
    // non-empty secret-key (user may have set providers / hashed secret).
    const secretEmpty =
      !/secret-key:\s*/m.test(out) ||
      /secret-key:\s*(""|''|)\s*$/m.test(out) ||
      /secret-key:\s*$/m.test(out);
    if (secretEmpty && opts.apiKey) {
      if (/secret-key:\s*/m.test(out)) {
        out = out.replace(
          /secret-key:\s*.*$/m,
          `secret-key: "${opts.apiKey}"`,
        );
      } else if (/^remote-management:/m.test(out)) {
        out = out.replace(
          /^(remote-management:\s*\n)/m,
          `$1  secret-key: "${opts.apiKey}"\n`,
        );
      }
    }
    return out;
  }

  // mode === "full": onboarding / first materialize only
  if (opts.apiKey) {
    if (/^api-keys:\s*$/m.test(out) || /^api-keys:/m.test(out)) {
      out = out.replace(
        /api-keys:\s*\n(?:\s*-\s*.*\n)*/m,
        `api-keys:\n  - ${opts.apiKey}\n`,
      );
    }
    // CPA disables all /v0/management routes when secret-key is empty.
    // Use the same gateway token so one password works for API + panel login.
    if (/secret-key:\s*/m.test(out)) {
      out = out.replace(
        /secret-key:\s*.*$/m,
        `secret-key: "${opts.apiKey}"`,
      );
    } else if (/^remote-management:/m.test(out)) {
      out = out.replace(
        /^(remote-management:\s*\n)/m,
        `$1  secret-key: "${opts.apiKey}"\n`,
      );
    }
  }
  return out;
}

/**
 * Repair an existing userData CPA config so the management panel works:
 * - enable control panel
 * - fill secret-key ONLY when empty (never overwrite hashed/user keys)
 * - NEVER rewrite api-keys / provider credentials
 * Returns true if the file was modified.
 */
export function repairCpaManagementConfig(
  configPath: string,
  opts?: { apiKey?: string | null; port?: number },
): boolean {
  if (!configPath || !fs.existsSync(configPath)) return false;
  let body: string;
  try {
    body = fs.readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  const needsPanel =
    /disable-control-panel:\s*true/i.test(body) ||
    !/disable-control-panel:\s*/i.test(body);
  const secretEmpty =
    /secret-key:\s*(""|''|)\s*$/m.test(body) ||
    /secret-key:\s*$/m.test(body) ||
    !/secret-key:\s*/m.test(body);
  if (!needsPanel && !secretEmpty) return false;

  const next = applyCpaConfigDefaults(body, {
    port: opts?.port ?? 8317,
    // Only used when secret is empty — never clobbers existing keys.
    apiKey: secretEmpty ? opts?.apiKey ?? extractFirstApiKey(body) : null,
    mode: "repair-panel",
  });
  if (next === body) return false;
  try {
    fs.writeFileSync(configPath, next, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the CPA config still looks like the virgin template
 * (placeholder change-me keys) and is safe to overwrite on first wizard.
 */
export function isPlaceholderCpaConfig(yaml: string): boolean {
  const hasChangeMe =
    /secret-key:\s*["']?change-me["']?/i.test(yaml) ||
    /api-keys:[\s\S]*?-\s*["']?change-me["']?/i.test(yaml);
  // Hashed secret-key from CPA startup is never a placeholder.
  const hashedSecret = /secret-key:\s*["']?\$2[aby]\$/i.test(yaml);
  return hasChangeMe && !hashedSecret;
}

function extractFirstApiKey(yaml: string): string | null {
  const m = yaml.match(/api-keys:\s*\n\s*-\s*["']?([^\s"'#]+)/);
  return m?.[1] ?? null;
}

export function defaultCpaConfigYaml(): string {
  return `# Generated by Claude Desktop — local CPA (CLIProxyAPI) config
host: "127.0.0.1"
port: 8317
tls:
  enable: false
remote-management:
  allow-remote: false
  secret-key: "change-me"
  disable-control-panel: false
auth-dir: "~/.cli-proxy-api"
api-keys:
  - change-me
debug: false
`;
}

/** Walk up from this file to find monorepo root (pnpm-workspace / package.json name). */
function findProjectRoot(): string {
  let dir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkg, "utf8")) as { name?: string };
        if (j.name === "claude-desktop" || j.name === "@claude-desktop/desktop") {
          // desktop package.json → go up to monorepo root when nested
          if (j.name === "@claude-desktop/desktop") {
            const parent = path.dirname(dir);
            const rootPkg = path.join(parent, "package.json");
            if (fs.existsSync(rootPkg)) {
              const rj = JSON.parse(fs.readFileSync(rootPkg, "utf8")) as {
                name?: string;
              };
              if (rj.name === "claude-desktop") return parent;
            }
            // apps/desktop → monorepo is parent of apps
            const mono = path.dirname(parent);
            if (fs.existsSync(path.join(mono, "pnpm-workspace.yaml"))) return mono;
          }
          return dir;
        }
      } catch {
        // continue
      }
    }
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const __testing = {
  LEGACY_CPA_DEFAULTS,
  findProjectRoot,
  claudeBinaryName,
  cpaBinaryName,
};
