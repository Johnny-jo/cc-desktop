import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "./settings-store";

describe("SettingsStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-settings-"));
  });

  it("does not install an in-memory allow rule when its settings write fails", () => {
    const store = new SettingsStore({ userDataDir: dir, encrypt: s => s, decrypt: s => s });
    fs.mkdirSync(path.join(dir, "settings.json"));
    expect(() => store.update({ permissionAllow: ["Bash(git status)"] })).toThrow();
    expect(store.get().permissionAllow).toEqual([]);
  });

  it("persists public settings and keeps token out of public view", () => {
    const store = new SettingsStore({
      userDataDir: dir,
      encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s) => Buffer.from(s, "base64").toString("utf8"),
    });
    store.update({ defaultModel: "kimi-for-coding", token: "secret-token" });
    const pub = store.getPublic();
    expect(pub.defaultModel).toBe("kimi-for-coding");
    expect(pub.hasToken).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("secret-token");
    expect(store.getToken()).toBe("secret-token");
  });

  it("fresh installs do not ship the maintainer's private model list", () => {
    const store = new SettingsStore({
      userDataDir: dir,
      encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s) => Buffer.from(s, "base64").toString("utf8"),
    });
    expect(store.get().models).toEqual([]);
    expect(store.get().defaultModel).toBe("");
    expect(store.getPublic().models).toEqual([]);
  });

  it("defaults context limit to 200k and persists overrides", () => {
    const store = new SettingsStore({
      userDataDir: dir,
      encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s) => Buffer.from(s, "base64").toString("utf8"),
    });
    expect(store.get().defaultContextLimit).toBe(200_000);
    expect(store.get().modelContextLimits).toEqual({});

    store.update({
      defaultContextLimit: 256_000,
      modelContextLimits: { "deepseek-v4-flash": 64_000 },
    });
    const again = new SettingsStore({
      userDataDir: dir,
      encrypt: (s) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s) => Buffer.from(s, "base64").toString("utf8"),
    });
    expect(again.get().defaultContextLimit).toBe(256_000);
    expect(again.get().modelContextLimits["deepseek-v4-flash"]).toBe(64_000);
    expect(again.getPublic().defaultContextLimit).toBe(256_000);
  });

  it("defaults galaxy effects to enabled for fresh and legacy settings", () => {
    const deps = { userDataDir: dir, encrypt: (s: string) => s, decrypt: (s: string) => s };
    expect(new SettingsStore(deps).getPublic().galaxyEffectsEnabled).toBe(true);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    expect(new SettingsStore(deps).getPublic().galaxyEffectsEnabled).toBe(true);
  });

  it("defaults photo flow on and persists an independent off choice across restarts", () => {
    const deps = { userDataDir: dir, encrypt: (s: string) => s, decrypt: (s: string) => s };
    const store = new SettingsStore(deps);
    expect(store.getPublic().photoFlowEnabled).toBe(true);
    store.update({ photoFlowEnabled: false });
    store.update({ galaxyEffectsEnabled: false, uiFontSize: 14 });
    store.update({ photoFlowEnabled: "true" as unknown as boolean });
    const restarted = new SettingsStore(deps);
    expect(restarted.getPublic().photoFlowEnabled).toBe(false);
    restarted.update({ photoFlowEnabled: true });
    expect(new SettingsStore(deps).getPublic().photoFlowEnabled).toBe(true);
    expect(restarted.getPublic().galaxyEffectsEnabled).toBe(false);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ theme: "light", photoFlowEnabled: "false" }));
    expect(new SettingsStore(deps).getPublic().photoFlowEnabled).toBe(true);
  });

  it("preserves the galaxy effect choice across unrelated saves and restarts", () => {
    const deps = { userDataDir: dir, encrypt: (s: string) => s, decrypt: (s: string) => s };
    const store = new SettingsStore(deps);
    store.update({ galaxyEffectsEnabled: false });
    store.update({ uiFontSize: 14 });
    const restarted = new SettingsStore(deps);
    expect(restarted.getPublic().galaxyEffectsEnabled).toBe(false);
    restarted.update({ galaxyEffectsEnabled: true });
    expect(new SettingsStore(deps).getPublic().galaxyEffectsEnabled).toBe(true);
  });

  it("ignores malformed galaxy effect values instead of overriding the preference", () => {
    const deps = { userDataDir: dir, encrypt: (s: string) => s, decrypt: (s: string) => s };
    const store = new SettingsStore(deps);
    store.update({ galaxyEffectsEnabled: false });
    store.update({ galaxyEffectsEnabled: "true" as unknown as boolean });
    expect(store.getPublic().galaxyEffectsEnabled).toBe(false);
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ galaxyEffectsEnabled: "false" }), "utf8");
    expect(new SettingsStore(deps).getPublic().galaxyEffectsEnabled).toBe(true);
  });

  it("retains disabled control profiles separately across restarts and filters invalid records", () => {
    const deps = { userDataDir: dir, encrypt: (s: string) => s, decrypt: (s: string) => s };
    const store = new SettingsStore(deps);
    expect(store.getPublic().disabledControlServers).toEqual({});
    const daily = { type: "playwright", browser: "chrome", profile: "Profile 3", connection: "extension" } as const;
    store.update({ disabledControlServers: { daily } });
    store.update({ mcpServers: { files: { command: "node" } } });
    const restarted = new SettingsStore(deps).getPublic();
    expect(restarted.disabledControlServers).toEqual({ daily });
    expect(restarted.mcpServers).toEqual({ files: { command: "node" } });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
      disabledControlServers: { daily, "bad/profile": daily, custom: { command: "node" } },
    }));
    expect(new SettingsStore(deps).getPublic().disabledControlServers).toEqual({ daily });
  });

  it("persists and reloads MCP servers, dropping invalid entries", () => {
    const crypto = {
      encrypt: (s: string) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s: string) => Buffer.from(s, "base64").toString("utf8"),
    };
    const store = new SettingsStore({ userDataDir: dir, ...crypto });
    expect(store.get().mcpServers).toEqual({});

    store.update({
      mcpServers: {
        fs: { type: "stdio", command: "node", args: ["srv.js"], env: { KEY: "v" } },
        api: { type: "http", url: "https://x.test/mcp", headers: { Auth: "Bearer t" } },
      },
    });

    const again = new SettingsStore({ userDataDir: dir, ...crypto });
    const loaded = again.get().mcpServers ?? {};
    expect(loaded.fs).toMatchObject({ command: "node", args: ["srv.js"], env: { KEY: "v" } });
    expect(loaded.api).toMatchObject({ url: "https://x.test/mcp" });
    // public view exposes config (no secrets-redaction layer for env/headers in v1)
    expect(Object.keys(again.getPublic().mcpServers ?? {})).toEqual(["fs", "api"]);
  });

  it("loads legacy settings.json without a projects field", () => {
    const crypto = {
      encrypt: (s: string) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s: string) => Buffer.from(s, "base64").toString("utf8"),
    };
    // Simulate a settings.json written before the projects field existed.
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ defaultModel: "kimi-for-coding", models: ["kimi-for-coding"] }),
      "utf8",
    );
    const store = new SettingsStore({ userDataDir: dir, ...crypto });
    expect(store.get().projects).toEqual([]);
    expect(store.get().defaultModel).toBe("kimi-for-coding");
  });

  it("persists and reloads projects, dropping non-string entries", () => {
    const crypto = {
      encrypt: (s: string) => Buffer.from(s, "utf8").toString("base64"),
      decrypt: (s: string) => Buffer.from(s, "base64").toString("utf8"),
    };
    const store = new SettingsStore({ userDataDir: dir, ...crypto });
    expect(store.get().projects).toEqual([]);

    store.update({ projects: ["D:\\proj\\a", "D:\\proj\\b"] });
    const again = new SettingsStore({ userDataDir: dir, ...crypto });
    expect(again.get().projects).toEqual(["D:\\proj\\a", "D:\\proj\\b"]);
    expect(again.getPublic().projects).toEqual(["D:\\proj\\a", "D:\\proj\\b"]);

    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ projects: ["D:\\proj\\c", 42, "", null] }),
      "utf8",
    );
    const dirty = new SettingsStore({ userDataDir: dir, ...crypto });
    expect(dirty.get().projects).toEqual(["D:\\proj\\c"]);
  });
});
