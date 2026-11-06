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
 * Env / flags:
 *   CLAUDE_DESKTOP_CPA_DIST  — dir containing cli-proxy-api.exe (default pinned tools/cpa/<version>, prepared by pnpm download:cpa)
 *   SKIP_CLAUDE=1            — skip claude.exe (full prepare still wipes vendor first)
 *   SKIP_CPA=1               — skip CPA (full prepare still wipes vendor first)
 *   CPA_ONLY=1 / --cpa-only  — only refresh cli-proxy-api.exe + template;
 *                              keeps claude.exe; NEVER copies config.yaml
 *   --claude-only            — only refresh the pinned SDK's claude.exe; keeps CPA
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveSdkClaudeBinary, claudeBinaryVersion, claudeRelease, verifyClaudeVendor } from "./claude-vendor.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const vendorRoot = path.join(root, "vendor", "win-x64");
const cpaRelease = JSON.parse(fs.readFileSync(path.join(__dirname, "cpa-release.json"), "utf8"));
const cpaDist = process.env.CLAUDE_DESKTOP_CPA_DIST || path.join(root, "tools", "cpa", cpaRelease.backend);

/** Only these basenames may appear under vendor/win-x64/cpa/ */
const CPA_ALLOWLIST = new Set([
  "cli-proxy-api.exe",
  "config.template.yaml",
  "static",
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
  const target = path.resolve(p);
  if (target !== vendorRoot && !target.startsWith(vendorRoot + path.sep)) {
    throw new Error(`Refusing to remove outside vendor directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
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
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "EBUSY" || code === "EPERM") {
      throw new Error(
        `Cannot replace ${dest} (file in use).\n` +
          "Stop CC Desktop and any running cli-proxy-api.exe, then retry.",
      );
    }
    throw err;
  }
  console.log(`  ${src}`);
  console.log(
    `  → ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`,
  );
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
      if (name === "static") {
        const staticDir = path.join(cpaDir, name);
        if (!fs.statSync(staticDir).isDirectory()) {
          throw new Error("SECURITY: vendor cpa/static must be a directory");
        }
        for (const inner of fs.readdirSync(staticDir)) {
          if (inner !== "management.html") {
            throw new Error(
              `SECURITY: unexpected file in vendor cpa/static/: ${inner}`,
            );
          }
        }
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

function parseFlags() {
  const argv = new Set(process.argv.slice(2));
  const cpaOnly =
    argv.has("--cpa-only") || process.env.CPA_ONLY === "1";
  const claudeOnly = argv.has("--claude-only");
  if (claudeOnly && cpaOnly) throw new Error("Choose --claude-only or --cpa-only, not both.");
  if (claudeOnly && process.env.SKIP_CLAUDE === "1") throw new Error("--claude-only conflicts with SKIP_CLAUDE.");
  return {
    cpaOnly,
    claudeOnly,
    skipClaude: cpaOnly || process.env.SKIP_CLAUDE === "1",
    skipCpa: claudeOnly || process.env.SKIP_CPA === "1",
  };
}

/** Drop leftover credential files so a stale vendor/ cannot ship them. */
function sanitizeCpaVendorDir() {
  const cpaDir = path.join(vendorRoot, "cpa");
  if (!fs.existsSync(cpaDir)) return;
  for (const name of fs.readdirSync(cpaDir)) {
    if (name === "static") {
      const staticDir = path.join(cpaDir, name);
      if (!fs.statSync(staticDir).isDirectory()) {
        fs.rmSync(staticDir, { force: true });
        console.log(`Removed leftover from vendor cpa/: ${name}`);
        continue;
      }
      for (const inner of fs.readdirSync(staticDir)) {
        if (inner === "management.html") continue;
        rmrf(path.join(staticDir, inner));
        console.log(`Removed leftover from vendor cpa/static/: ${inner}`);
      }
      continue;
    }
    if (CPA_ALLOWLIST.has(name)) continue;
    const p = path.join(cpaDir, name);
    rmrf(p);
    console.log(`Removed leftover from vendor cpa/: ${name}`);
  }
}

export function validateCpaSource(sourceDir = cpaDist) {
  const exe = path.join(sourceDir, "cli-proxy-api.exe");
  if (!fs.existsSync(exe)) throw new Error("CPA source missing. Run pnpm download:cpa first, or set CLAUDE_DESKTOP_CPA_DIST.");
  const probe = spawnSync(exe, ["--help"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  const banner = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  const version = banner.match(/CLIProxyAPI Version:\s*v?(\d+\.\d+\.\d+)/)?.[1];
  if (probe.error || !version || Number(version.split(".")[0]) < 8) {
    throw new Error("CPA v8 or later is required; refusing to package a legacy/unknown backend.");
  }
  const panel = path.join(sourceDir, "static", "management.html");
  if (!fs.existsSync(panel) || !fs.readFileSync(panel, "utf8").includes("/v8/management")) {
    throw new Error("A v8-compatible management.html is required. Run pnpm download:cpa.");
  }
  return version;
}

function copyCpaBinary() {
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
  const staticSrc = path.join(cpaDist, "static", "management.html");
  if (fs.existsSync(staticSrc)) {
    copyFile(
      staticSrc,
      path.join(vendorRoot, "cpa", "static", "management.html"),
    );
  } else {
    console.warn(
      "WARN: CPA static/management.html not found — panel may try GitHub on first start",
    );
  }
}

function main() {
  const { cpaOnly, claudeOnly, skipClaude, skipCpa } = parseFlags();
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(path.join(vendorRoot, "manifest.json"), "utf8")); } catch {}
  const cpaVersion = skipCpa ? null : validateCpaSource();
  const claudeSource = skipClaude ? null : resolveSdkClaudeBinary();
  if (claudeSource && claudeBinaryVersion(claudeSource.exe) !== claudeRelease.cli) {
    throw new Error("Installed Claude SDK binary does not match the pinned CLI version.");
  }
  console.log("prepare-vendor →", vendorRoot);
  if (cpaOnly) console.log("mode: --cpa-only (refresh CPA exe, keep claude.exe)");
  if (claudeOnly) console.log("mode: --claude-only (refresh Claude CLI, keep CPA)");
  console.log(
    "SECURITY: will NOT copy config.yaml / auth-dir / tokens from local CPA install.",
  );

  if (cpaOnly || claudeOnly) {
    // Preserve the other runtime and cloudflared during a targeted refresh.
    ensureDir(vendorRoot);
    ensureDir(path.join(vendorRoot, "cloudflared"));
    if (cpaOnly) sanitizeCpaVendorDir();
  } else {
    // Clean slate so leftover credential files cannot linger in vendor/.
    // SKIP_CLAUDE / SKIP_CPA still wipe then recopy the other binary —
    // use --cpa-only or --claude-only for a targeted runtime update.
    rmrf(vendorRoot);
    ensureDir(vendorRoot);
    // Reserve the (optional, possibly empty) cloudflared dir so the
    // electron-builder extraResources bin/cloudflared/** entry always resolves.
    ensureDir(path.join(vendorRoot, "cloudflared"));
  }

  if (!skipClaude) {
    console.log("Claude CLI (third-party, not part of this repo):");
    copyFile(claudeSource.exe, path.join(vendorRoot, "claude", "claude.exe"));
  } else if (cpaOnly) {
    const existing = path.join(vendorRoot, "claude", "claude.exe");
    if (!fs.existsSync(existing)) {
      console.warn(
        "WARN: --cpa-only but vendor/win-x64/claude/claude.exe is missing. CLI mode will be unavailable.",
      );
    } else {
      console.log("Keeping existing claude.exe");
    }
  } else {
    console.log("SKIP_CLAUDE=1 — skipping claude.exe");
  }

  if (!skipCpa) {
    copyCpaBinary();
    sanitizeCpaVendorDir();
  } else {
    console.log("SKIP_CPA=1 — skipping CPA");
  }

  auditVendor();

  const manifest = {
    preparedAt: new Date().toISOString(),
    platform: "win-x64",
    claude: fs.existsSync(path.join(vendorRoot, "claude", "claude.exe")),
    cpa: fs.existsSync(path.join(vendorRoot, "cpa", "cli-proxy-api.exe")),
    cpaVersion: skipCpa ? previous.cpaVersion ?? null : cpaVersion,
    panelVersion: skipCpa ? previous.panelVersion ?? null : process.env.CLAUDE_DESKTOP_CPA_DIST ? "custom" : cpaRelease.panel,
    ...(!skipClaude ? verifyClaudeVendor() : {
      claudeVersion: previous.claudeVersion ?? null,
      claudeSdkVersion: previous.claudeSdkVersion ?? null,
      claudeSha256: previous.claudeSha256 ?? null,
    }),
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
