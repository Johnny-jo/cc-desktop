import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCpaConfigDefaults,
  getClaudeExecutablePath,
  getCpaUserConfigPath,
  materializeCpaConfig,
  repairCpaManagementConfig,
  writeCpaConfigWithApiKey,
  resolveEffectiveCpaPaths,
  type RuntimePathEnv,
} from "./runtime-paths";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dirs.length = 0;
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rt-paths-"));
  dirs.push(d);
  return d;
}

function env(partial: Partial<RuntimePathEnv> & { userDataDir: string }): RuntimePathEnv {
  return {
    isPackaged: false,
    platform: "win32",
    ...partial,
  };
}

describe("runtime-paths", () => {
  it("materializeCpaConfig creates userData config from template", () => {
    const root = tmp();
    const resources = path.join(root, "apps", "desktop", "resources", "cpa");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(
      path.join(resources, "config.template.yaml"),
      'host: ""\nport: 9999\napi-keys:\n  - old\n',
      "utf8",
    );
    // findProjectRoot walks from __dirname; pass projectRoot so template resolves
    // via tracked path apps/desktop/resources/...
    const userData = path.join(root, "userdata");
    // Put monorepo-ish layout: projectRoot/apps/desktop/resources/cpa/config.template.yaml
    const e = env({
      userDataDir: userData,
      projectRoot: root,
      isPackaged: false,
    });
    const dest = materializeCpaConfig(e, { port: 8317, apiKey: "secret-key" });
    expect(fs.existsSync(dest)).toBe(true);
    const body = fs.readFileSync(dest, "utf8");
    expect(body).toContain('host: "127.0.0.1"');
    expect(body).toContain("port: 8317");
    expect(body).toContain("secret-key");
    // Second call is idempotent (does not overwrite).
    fs.writeFileSync(dest, "keep\n", "utf8");
    materializeCpaConfig(e, { port: 1 });
    expect(fs.readFileSync(dest, "utf8")).toBe("keep\n");
  });

  it("applyCpaConfigDefaults forces localhost, panel, and secret-key", () => {
    const out = applyCpaConfigDefaults(
      'host: ""\nport: 1\nauth-dir: "x"\nremote-management:\n  allow-remote: false\n  secret-key: ""\n  disable-control-panel: true\napi-keys:\n  - a\n',
      { port: 8317, apiKey: "k" },
    );
    expect(out).toMatch(/host:\s*"127\.0\.0\.1"/);
    expect(out).toMatch(/port:\s*8317/);
    expect(out).toContain("api-keys:");
    expect(out).toContain("- k");
    expect(out).toMatch(/disable-control-panel:\s*false/);
    expect(out).toMatch(/secret-key:\s*"k"/);
  });

  it("repairCpaManagementConfig enables panel and secret-key on old configs", () => {
    const root = tmp();
    const cfg = path.join(root, "config.yaml");
    fs.writeFileSync(
      cfg,
      'host: "127.0.0.1"\nport: 8317\nremote-management:\n  allow-remote: false\n  secret-key: ""\n  disable-control-panel: true\napi-keys:\n  - tok123\n',
      "utf8",
    );
    expect(repairCpaManagementConfig(cfg, { apiKey: "tok123" })).toBe(true);
    const body = fs.readFileSync(cfg, "utf8");
    expect(body).toMatch(/disable-control-panel:\s*false/);
    expect(body).toMatch(/secret-key:\s*"tok123"/);
    // Second pass is a no-op when already healthy.
    expect(repairCpaManagementConfig(cfg, { apiKey: "tok123" })).toBe(false);
  });

  it("repairCpaManagementConfig never overwrites non-empty secret-key or api-keys", () => {
    const root = tmp();
    const cfg = path.join(root, "config.yaml");
    const original =
      'host: "127.0.0.1"\nport: 8317\nremote-management:\n  allow-remote: false\n  secret-key: "$2a$10$hashedUserSecret"\n  disable-control-panel: false\napi-keys:\n  - user-token-abc\nproviders:\n  - name: keep-me\n';
    fs.writeFileSync(cfg, original, "utf8");
    // Healthy config → repair is a pure no-op (no rewrite at all).
    expect(
      repairCpaManagementConfig(cfg, { apiKey: "other-token", port: 9999 }),
    ).toBe(false);
    const body = fs.readFileSync(cfg, "utf8");
    expect(body).toBe(original);
    expect(body).not.toContain("other-token");
  });

  it("resolveEffectiveCpaPaths prefers bundled over legacy defaults", () => {
    const root = tmp();
    const vendorCpa = path.join(root, "vendor", "win-x64", "cpa");
    fs.mkdirSync(vendorCpa, { recursive: true });
    const exe = path.join(vendorCpa, "cli-proxy-api.exe");
    fs.writeFileSync(exe, "fake");
    fs.writeFileSync(
      path.join(vendorCpa, "config.template.yaml"),
      defaultTemplate(),
      "utf8",
    );
    const userData = path.join(root, "ud");
    const e = env({
      userDataDir: userData,
      projectRoot: root,
      isPackaged: false,
    });
    const resolved = resolveEffectiveCpaPaths(
      e,
      {
        cpaExePath: "D:\\gitrep\\CC\\CPA\\cli-proxy-api.exe",
        cpaConfigPath: "D:\\gitrep\\CC\\CPA\\config.yaml",
        cpaPort: 8317,
      },
      { apiKey: "tok" },
    );
    expect(resolved.cpaExePath).toBe(exe);
    expect(resolved.cpaConfigPath).toBe(getCpaUserConfigPath(e));
    expect(fs.existsSync(resolved.cpaConfigPath)).toBe(true);
  });

  it("resolveEffectiveCpaPaths keeps custom existing paths", () => {
    const root = tmp();
    const customExe = path.join(root, "my-cpa.exe");
    const customCfg = path.join(root, "my-config.yaml");
    fs.writeFileSync(customExe, "x");
    fs.writeFileSync(customCfg, "port: 1\n");
    const e = env({ userDataDir: path.join(root, "ud"), projectRoot: root });
    const resolved = resolveEffectiveCpaPaths(e, {
      cpaExePath: customExe,
      cpaConfigPath: customCfg,
      cpaPort: 8317,
    });
    expect(resolved.cpaExePath).toBe(customExe);
    expect(resolved.cpaConfigPath).toBe(customCfg);
  });

  it("packaged build prefers current resources over leftover install exe", () => {
    const root = tmp();
    const leftoverDir = path.join(
      root,
      "old-install",
      "resources",
      "bin",
      "cpa",
    );
    fs.mkdirSync(leftoverDir, { recursive: true });
    const leftover = path.join(leftoverDir, "cli-proxy-api.exe");
    fs.writeFileSync(leftover, "old");

    const resources = path.join(root, "current", "resources");
    const bundledDir = path.join(resources, "bin", "cpa");
    fs.mkdirSync(bundledDir, { recursive: true });
    const bundled = path.join(bundledDir, "cli-proxy-api.exe");
    fs.writeFileSync(bundled, "new");

    const e = env({
      isPackaged: true,
      resourcesPath: resources,
      userDataDir: path.join(root, "ud"),
      projectRoot: root,
    });
    const resolved = resolveEffectiveCpaPaths(e, {
      cpaExePath: leftover,
      cpaConfigPath: path.join(root, "ud", "cpa", "config.yaml"),
      cpaPort: 8317,
    });
    expect(resolved.cpaExePath).toBe(bundled);
  });

  it("writeCpaConfigWithApiKey overwrites api-keys", () => {
    const root = tmp();
    const resources = path.join(root, "apps", "desktop", "resources", "cpa");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(
      path.join(resources, "config.template.yaml"),
      'host: ""\nport: 8317\napi-keys:\n  - old\n',
      "utf8",
    );
    const userData = path.join(root, "userdata");
    const e = env({ userDataDir: userData, projectRoot: root });
    const dest = writeCpaConfigWithApiKey(e, { apiKey: "new-key-1" });
    expect(fs.readFileSync(dest, "utf8")).toContain("new-key-1");
    writeCpaConfigWithApiKey(e, { apiKey: "new-key-2" });
    expect(fs.readFileSync(dest, "utf8")).toContain("new-key-2");
    expect(fs.readFileSync(dest, "utf8")).not.toContain("new-key-1");
  });

  it("packaged claude path under resources/bin/claude", () => {
    const root = tmp();
    const resources = path.join(root, "resources");
    const claudeDir = path.join(resources, "bin", "claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const exe = path.join(claudeDir, "claude.exe");
    fs.writeFileSync(exe, "x");
    const p = getClaudeExecutablePath(
      env({
        isPackaged: true,
        resourcesPath: resources,
        userDataDir: path.join(root, "ud"),
      }),
    );
    expect(p).toBe(exe);
  });
});

function defaultTemplate(): string {
  return `host: ""\nport: 8317\napi-keys:\n  - change-me\n`;
}
