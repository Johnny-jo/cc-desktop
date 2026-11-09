import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderManager, isValidProviderId } from "./provider-manager";
import type { ProviderConfig } from "@claude-desktop/shared";

let dir: string;
let manager: ProviderManager;

function claudeConfig(id = "claude-1"): ProviderConfig {
  return {
    id,
    name: "Claude",
    type: "claude",
    enabled: true,
    auth: { type: "claude", authMethod: "api-key" },
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-manager-"));
  manager = new ProviderManager({ userDataDir: dir });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("isValidProviderId", () => {
  it("accepts plain ids", () => {
    expect(isValidProviderId("claude-1")).toBe(true);
    expect(isValidProviderId("openai_compat.local")).toBe(true);
  });

  it("rejects anything that could escape the credentials directory", () => {
    expect(isValidProviderId("../../evil")).toBe(false);
    expect(isValidProviderId("..\\..\\evil")).toBe(false);
    expect(isValidProviderId(".hidden")).toBe(false);
    expect(isValidProviderId("a/b")).toBe(false);
    expect(isValidProviderId("")).toBe(false);
    expect(isValidProviderId("x".repeat(65))).toBe(false);
    expect(isValidProviderId(undefined)).toBe(false);
  });
});

describe("ProviderManager", () => {
  it("never persists API keys into configs.json", () => {
    manager.addConfig(claudeConfig());
    manager.updateConfig("claude-1", {
      auth: { type: "claude", authMethod: "api-key", apiKey: "sk-secret" },
    });

    const raw = fs.readFileSync(path.join(dir, "providers", "configs.json"), "utf-8");
    expect(raw).not.toContain("sk-secret");
    expect(JSON.parse(raw)[0].auth.apiKey).toBeUndefined();
  });

  it("deep-merges auth so updating a key keeps authMethod", () => {
    manager.addConfig(claudeConfig());
    manager.updateConfig("claude-1", {
      auth: { type: "claude", authMethod: "api-key" },
    });

    expect(manager.getConfig("claude-1")?.auth).toMatchObject({
      type: "claude",
      authMethod: "api-key",
    });
  });

  it("reports authenticated only when a credential file actually exists", () => {
    manager.addConfig(claudeConfig());

    // 旧实现读 config.auth.apiKey，而它总是被剥离，所以永远返回 false。
    expect(manager.getStatus("claude-1")?.authenticated).toBe(false);

    manager.saveApiKey("claude-1", "enc:whatever");
    expect(manager.getStatus("claude-1")?.authenticated).toBe(true);

    manager.deleteApiKey("claude-1");
    expect(manager.getStatus("claude-1")?.authenticated).toBe(false);

    manager.saveOAuthToken("claude-1", "enc:token");
    expect(manager.getStatus("claude-1")?.authenticated).toBe(true);
  });

  it("refuses to write credentials for a traversal-shaped id", () => {
    expect(() => manager.saveApiKey("../../evil", "enc:x")).toThrow(/Invalid provider id/);
    const escaped = path.join(dir, "evil.key");
    expect(fs.existsSync(escaped)).toBe(false);
  });

  it("keeps API key and OAuth token in separate files so one does not clobber the other", () => {
    manager.addConfig(claudeConfig());
    manager.saveApiKey("claude-1", "enc:key");
    manager.saveOAuthToken("claude-1", "enc:token");

    expect(manager.loadApiKey("claude-1")).toBe("enc:key");
    expect(manager.loadOAuthToken("claude-1")).toBe("enc:token");

    manager.deleteOAuthToken("claude-1");
    expect(manager.loadApiKey("claude-1")).toBe("enc:key");
  });

  it("survives a corrupt configs.json without throwing", () => {
    fs.writeFileSync(path.join(dir, "providers", "configs.json"), "{not json", "utf-8");
    const reloaded = new ProviderManager({ userDataDir: dir });
    expect(reloaded.listConfigs()).toEqual([]);
  });

  it("drops config entries with invalid ids when loading", () => {
    fs.writeFileSync(
      path.join(dir, "providers", "configs.json"),
      JSON.stringify([claudeConfig("good-1"), claudeConfig("../../bad")]),
      "utf-8",
    );
    const reloaded = new ProviderManager({ userDataDir: dir });
    expect(reloaded.listConfigs().map((c) => c.id)).toEqual(["good-1"]);
  });

  it("reports OAuth support only for providers with real endpoints", () => {
    expect(manager.getOAuthConfig("gemini").authorizationUrl).toContain("accounts.google.com");
    expect(manager.getOAuthConfig("claude")).toEqual({});
    expect(manager.getOAuthConfig("openai")).toEqual({});
  });

  it("returns null endpoint for unknown or openai-compatible providers", () => {
    expect(manager.getEndpoint("openai-compatible")).toBeNull();
    expect(manager.getEndpoint("nonsense")).toBeNull();
    expect(manager.getEndpoint("claude")?.baseUrl).toBe("https://api.anthropic.com");
  });
});
