import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSdkClaudeBinary, claudeRelease } from "./claude-vendor.mjs";

function fixture(t, { sdkVersion = claudeRelease.sdk, nativeVersion = claudeRelease.sdk } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-vendor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture-app"}');
  const sdk = path.join(root, "node_modules/@anthropic-ai/claude-agent-sdk");
  const native = path.join(sdk, "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64");
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: sdkVersion, claudeCodeVersion: claudeRelease.cli, exports: { ".": "./sdk.mjs" } }));
  fs.writeFileSync(path.join(sdk, "sdk.mjs"), "export {};");
  fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ version: nativeVersion }));
  fs.writeFileSync(path.join(native, "claude.exe"), "active-native-fixture");
  const stale = path.join(root, "node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-win32-x64@0.0.1/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64");
  fs.mkdirSync(stale, { recursive: true }); fs.writeFileSync(path.join(stale, "claude.exe"), "stale-fixture");
  return { root, exe: path.join(native, "claude.exe") };
}

test("resolves the active SDK's nested optional dependency despite old pnpm packages", t => {
  const { root, exe } = fixture(t);
  assert.equal(resolveSdkClaudeBinary(root).exe, exe);
});
test("rejects an SDK outside the pinned release", t => {
  const { root } = fixture(t, { sdkVersion: "0.3.220" });
  assert.throws(() => resolveSdkClaudeBinary(root), /version mismatch/);
});
test("rejects a mismatched or missing native dependency instead of using stale cache", t => {
  const mismatch = fixture(t, { nativeVersion: "0.3.220" });
  assert.throws(() => resolveSdkClaudeBinary(mismatch.root), /version mismatch/);
  const missing = fixture(t); fs.unlinkSync(missing.exe);
  assert.throws(() => resolveSdkClaudeBinary(missing.root), /native binary is missing/);
});
