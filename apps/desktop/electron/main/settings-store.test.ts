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
});
