/**
 * Copy Claude Code CLI + CPA binaries (third-party executables, not shipped in this repo) into vendor/win-x64 for electron-builder
 * extraResources. Run before packaging:
 *   node scripts/prepare-vendor.mjs
 *
 * SECURITY:
 *   - Only copies an allow-listed set of files.
 *   - NEVER copies CPA config.yaml, auth-dir, or any credential store.
 *   - Only ships the repo-tracked config.template.yaml (placeholders only).
 *   - Fails if forbidden filenames or secret-like strings appear in vendor/.
 *
 * Env:
 *   CLAUDE_DESKTOP_CPA_DIST  — dir containing cli-proxy-api.exe (default D:\gitrep\CC\CPA)
 *   SKIP_CLAUDE=1            — skip claude.exe copy
 *   SKIP_CPA=1               — skip CPA copy
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const vendorRoot = path.join(root, "vendor", "win-x64");
const require = createRequire(import.meta.url);

/** Only these basenames may appear under vendor/win-x64/cpa/ */
const CPA_ALLOWLIST = new Set([
  "cli-proxy-api.exe",
  "config.template.yaml",
]);

/** Filenames that must never be copied into the package */
const FORBIDDEN_BASENAMES = new Set([
  "config.yaml",
  "config.yml",
  ".env",
  ".env.local",
  "credentials.json",
  "token",
  "token.json",
  "auth.json",
]);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(src, dest) {
  const base = path.basename(src).toLowerCase();
  if (FORBIDDEN_BASENAMES.has(base) || FORBIDDEN_BASENAMES.has(path.basename(src))) {
    throw new Error(
      `REFUSED to copy forbidden credential-like file: ${src}\n` +
        "Only the binary + repo template are allowed in the package.",
    );
  }
  if (base === "config.yaml" || base.endsWith(".yaml") && base !== "config.template.yaml") {
    if (base !== "config.template.yaml") {
      throw new Error(`REFUSED to copy non-template config: ${src}`);
    }
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  console.log(`  ${src}`);
  console.log(
    `  → ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`,
  );
}

function resolveSdkClaudeExe() {
  try {
    const pkgJson = require.resolve(
      "@anthropic-ai/claude-agent-sdk-win32-x64/package.json",
    );
    const exe = path.join(path.dirname(pkgJson), "claude.exe");
    if (fs.existsSync(exe)) return exe;
  } catch {
    // fall through
  }
  const pnpmDir = path.join(root, "node_modules", ".pnpm");
  if (fs.existsSync(pnpmDir)) {
    for (const name of fs.readdirSync(pnpmDir)) {
      if (!name.startsWith("@anthropic-ai+claude-agent-sdk-win32-x64@")) continue;
      const candidate = path.join(
        pnpmDir,
        name,
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk-win32-x64",
        "claude.exe",
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Fail build if vendor contains unexpected files or secret-looking strings. */
function auditVendor() {
  const cpaDir = path.join(vendorRoot, "cpa");
  if (fs.existsSync(cpaDir)) {
    for (const name of fs.readdirSync(cpaDir)) {
      if (!CPA_ALLOWLIST.has(name)) {
        throw new Error(
          `SECURITY: unexpected file in vendor cpa/: ${name}\n` +
            `Allowed: ${[...CPA_ALLOWLIST].join(", ")}`,
        );
      }
      if (FORBIDDEN_BASENAMES.has(name.toLowerCase())) {
        throw new Error(`SECURITY: forbidden file in vendor: ${name}`);
      }
    }
  }

  const template = path.join(cpaDir, "config.template.yaml");
  if (fs.existsSync(template)) {
    const text = fs.readFileSync(template, "utf8");
    // Real local CPA key fragment / common secret shapes must not ship.
    const bad = [
      /SPnJ9BpHf5hJW0bRE/,
      /sk-[a-zA-Z0-9]{20,}/,
      /AIza[0-9A-Za-z_-]{20,}/,
      /Bearer\s+[A-Za-z0-9._-]{20,}/i,
      /api-keys:\s*\n\s*-\s*["']?(?!change-me\b)[A-Za-z0-9_-]{16,}/,
    ];
    for (const re of bad) {
      if (re.test(text)) {
        throw new Error(
          `SECURITY: config.template.yaml looks like it contains a real secret (matched ${re}). ` +
            "Only placeholders such as change-me are allowed.",
        );
      }
    }
    if (!text.includes("change-me")) {
      console.warn(
        "WARN: template does not contain placeholder change-me — double-check api-keys.",
      );
    }
  }
}

function main() {
  console.log("prepare-vendor →", vendorRoot);
  console.log(
    "SECURITY: will NOT copy config.yaml / auth-dir / tokens from local CPA install.",
  );

  // Clean slate so leftover credential files cannot linger in vendor/.
  rmrf(vendorRoot);
  ensureDir(vendorRoot);

  if (process.env.SKIP_CLAUDE !== "1") {
    const claudeSrc = resolveSdkClaudeExe();
    if (!claudeSrc) {
      console.error(
        "ERROR: claude.exe not found. Install optional dep @anthropic-ai/claude-agent-sdk-win32-x64",
      );
      process.exit(1);
    }
    console.log("Claude CLI (third-party, not part of this repo):");
    copyFile(claudeSrc, path.join(vendorRoot, "claude", "claude.exe"));
  } else {
    console.log("SKIP_CLAUDE=1 — skipping claude.exe");
  }

  if (process.env.SKIP_CPA !== "1") {
    const cpaDist =
      process.env.CLAUDE_DESKTOP_CPA_DIST || "D:\\gitrep\\CC\\CPA";
    const cpaExe = path.join(cpaDist, "cli-proxy-api.exe");
    if (!fs.existsSync(cpaExe)) {
      console.error(
        `ERROR: CPA exe not found at ${cpaExe}\n` +
          "Set CLAUDE_DESKTOP_CPA_DIST to a directory containing cli-proxy-api.exe",
      );
      process.exit(1);
    }
    // Explicitly refuse to touch the live local config next to the exe.
    const liveConfig = path.join(cpaDist, "config.yaml");
    if (fs.existsSync(liveConfig)) {
      console.log(
        `NOTE: local ${liveConfig} exists — intentionally NOT packing it.`,
      );
    }
    console.log("CPA (binary only + repo template):");
    copyFile(cpaExe, path.join(vendorRoot, "cpa", "cli-proxy-api.exe"));
    const templateSrc = path.join(
      root,
      "apps",
      "desktop",
      "resources",
      "cpa",
      "config.template.yaml",
    );
    if (!fs.existsSync(templateSrc)) {
      console.error("ERROR: missing config.template.yaml at", templateSrc);
      process.exit(1);
    }
    copyFile(templateSrc, path.join(vendorRoot, "cpa", "config.template.yaml"));
  } else {
    console.log("SKIP_CPA=1 — skipping CPA");
  }

  auditVendor();

  const manifest = {
    preparedAt: new Date().toISOString(),
    platform: "win-x64",
    claude: fs.existsSync(path.join(vendorRoot, "claude", "claude.exe")),
    cpa: fs.existsSync(path.join(vendorRoot, "cpa", "cli-proxy-api.exe")),
    shipsLocalConfig: false,
    cpaAllowlist: [...CPA_ALLOWLIST],
  };
  fs.writeFileSync(
    path.join(vendorRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  console.log("Wrote vendor/win-x64/manifest.json", manifest);
  console.log("Done. No local credentials packed.");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
