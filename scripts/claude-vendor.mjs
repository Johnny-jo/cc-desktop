import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const claudeRelease = JSON.parse(fs.readFileSync(new URL("./claude-release.json", import.meta.url), "utf8"));

/** Resolve through the active SDK, never the first old package in pnpm's store. */
export function resolveSdkClaudeBinary(desktopDir = path.join(root, "apps/desktop")) {
  const appRequire = createRequire(path.join(desktopDir, "package.json"));
  const sdkEntry = appRequire.resolve("@anthropic-ai/claude-agent-sdk");
  const sdk = JSON.parse(fs.readFileSync(path.join(path.dirname(sdkEntry), "package.json"), "utf8"));
  const sdkRequire = createRequire(sdkEntry);
  const platformJson = sdkRequire.resolve("@anthropic-ai/claude-agent-sdk-win32-x64/package.json");
  const platform = JSON.parse(fs.readFileSync(platformJson, "utf8"));
  if (sdk.version !== claudeRelease.sdk || sdk.claudeCodeVersion !== claudeRelease.cli || platform.version !== sdk.version) {
    throw new Error(`Claude SDK/native version mismatch. Expected SDK ${claudeRelease.sdk} / CLI ${claudeRelease.cli}; run pnpm install with the checked-in lockfile.`);
  }
  const exe = path.join(path.dirname(platformJson), "claude.exe");
  if (!fs.existsSync(exe)) throw new Error("Claude SDK native binary is missing. Install optional dependencies for win32-x64.");
  return { exe, sdkVersion: sdk.version, cliVersion: sdk.claudeCodeVersion };
}

export function claudeBinaryVersion(exe) {
  const result = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  const version = result.stdout?.match(/^(\d+\.\d+\.\d+)\s+\(Claude Code\)/m)?.[1];
  if (result.error || result.status !== 0 || !version) throw new Error(`Cannot verify Claude Code version: ${exe}`);
  return version;
}

export function binarySha256(exe) {
  return createHash("sha256").update(fs.readFileSync(exe)).digest("hex");
}

export function verifyClaudeVendor(exe = path.join(root, "vendor/win-x64/claude/claude.exe")) {
  const source = resolveSdkClaudeBinary();
  const version = claudeBinaryVersion(exe);
  if (version !== claudeRelease.cli) throw new Error(`Claude vendor is ${version}; expected ${claudeRelease.cli}. Run pnpm prepare:vendor:claude.`);
  const sha256 = binarySha256(exe);
  if (sha256 !== binarySha256(source.exe)) throw new Error("Claude vendor bytes differ from the active SDK native package. Run pnpm prepare:vendor:claude.");
  return { claudeVersion: version, claudeSdkVersion: source.sdkVersion, claudeSha256: sha256 };
}
