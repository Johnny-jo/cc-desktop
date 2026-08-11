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

export function getCpaExecutablePath(env: RuntimePathEnv): string {
  const platform = env.platform ?? process.platform;
  const name = cpaBinaryName(platform);

  if (env.isPackaged) {
    const p = path.join(bundledBinRoot(env), "cpa", name);
    if (fs.existsSync(p)) return p;
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
    const template = getCpaConfigTemplatePath(env);
    let body: string;
    if (template && fs.existsSync(template)) {
      body = fs.readFileSync(template, "utf8");
    } else {
      body = defaultCpaConfigYaml();
    }
    body = applyCpaConfigDefaults(body, {
      port: opts?.port ?? 8317,
      apiKey: opts?.apiKey,
    });
    fs.writeFileSync(dest, body, "utf8");
  }

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

  const cpaExePath =
    !exeIsLegacy && fs.existsSync(settings.cpaExePath)
      ? settings.cpaExePath
      : bundledExe;

  const cpaConfigPath =
    !configIsLegacy && fs.existsSync(settings.cpaConfigPath)
      ? settings.cpaConfigPath
      : userConfig;

  return { cpaExePath, cpaConfigPath };
}

export function applyCpaConfigDefaults(
  yaml: string,
  opts: { port: number; apiKey?: string | null },
): string {
  let out = yaml;
  // Force localhost binding for desktop embedding.
  out = out.replace(/^host:\s*.*$/m, 'host: "127.0.0.1"');
  out = out.replace(/^port:\s*\d+\s*$/m, `port: ${opts.port}`);
  // Prefer user home auth-dir so existing CPA logins are reused.
  const authDir = path.join(os.homedir(), ".cli-proxy-api").replace(/\\/g, "\\\\");
  if (/^auth-dir:\s*/m.test(out)) {
    out = out.replace(/^auth-dir:\s*.*$/m, `auth-dir: "${authDir}"`);
  } else {
    out = `auth-dir: "${authDir}"\n` + out;
  }
  if (opts.apiKey) {
    // Replace first api-keys list item or inject a minimal block.
    if (/^api-keys:\s*$/m.test(out) || /^api-keys:/m.test(out)) {
      out = out.replace(
        /api-keys:\s*\n(?:\s*-\s*.*\n)*/m,
        `api-keys:\n  - ${opts.apiKey}\n`,
      );
    }
  }
  return out;
}

export function defaultCpaConfigYaml(): string {
  return `# Generated by Claude Desktop — local CPA (CLIProxyAPI) config
host: "127.0.0.1"
port: 8317
tls:
  enable: false
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
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
