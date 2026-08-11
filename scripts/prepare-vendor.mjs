/**
 * Copy Claude Code CLI + CPA binaries into vendor/win-x64 for electron-builder
 * extraResources. Run before packaging:
 *   node scripts/prepare-vendor.mjs
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

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  console.log(`  ${src}`);
  console.log(`  → ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
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
  // pnpm nested path
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

function main() {
  console.log("prepare-vendor →", vendorRoot);
  ensureDir(vendorRoot);

  if (process.env.SKIP_CLAUDE !== "1") {
    const claudeSrc = resolveSdkClaudeExe();
    if (!claudeSrc) {
      console.error(
        "ERROR: claude.exe not found. Install optional dep @anthropic-ai/claude-agent-sdk-win32-x64",
      );
      process.exit(1);
    }
    console.log("Claude CLI:");
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
    console.log("CPA:");
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

  const manifest = {
    preparedAt: new Date().toISOString(),
    platform: "win-x64",
    claude: fs.existsSync(path.join(vendorRoot, "claude", "claude.exe")),
    cpa: fs.existsSync(path.join(vendorRoot, "cpa", "cli-proxy-api.exe")),
  };
  fs.writeFileSync(
    path.join(vendorRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  console.log("Wrote vendor/win-x64/manifest.json", manifest);
  console.log("Done.");
}

main();
