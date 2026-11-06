import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  applyCpaConfigDefaults,
  defaultCpaConfigYaml,
  isPlaceholderCpaConfig,
} from "./cpa-config";

describe("CPA v8 config", () => {
  it("seeds client and management keys without changing upstream groups", () => {
    const original = parse(defaultCpaConfigYaml());
    original["api-keys"] = {
      codex: [{ name: "upstream", keys: [{ "api-key": "provider-secret" }] }],
    };
    original.oauth["auth-dir"] = "D:/custom-auth";
    const key = 'client:# "quoted"\\key';
    const updated = parse(applyCpaConfigDefaults(stringify(original), { port: 8320, apiKey: key }));
    expect(updated.server).toMatchObject({ host: "127.0.0.1", port: 8320 });
    expect(updated.access["api-keys"]).toEqual([key]);
    expect(updated.management["secret-key"]).toBe(key);
    expect(updated["api-keys"]).toEqual(original["api-keys"]);
    expect(updated.oauth).toEqual(original.oauth);
    expect(updated).not.toHaveProperty("remote-management");
    expect(updated).not.toHaveProperty("host");
  });

  it("repairs only management settings, preserving non-empty secrets and comments", () => {
    const original = parse(defaultCpaConfigYaml());
    original.server = { host: "custom-host", port: 9999 };
    original.management["secret-key"] = "$2a$10$existing-hash";
    original.management["disable-control-panel"] = true;
    original.management["disable-auto-update-panel"] = false;
    original.access["api-keys"] = ["existing-client"];
    original.oauth["auth-dir"] = "D:/custom-auth";
    const source = "# preserve user comments\n" + stringify(original);
    const repaired = applyCpaConfigDefaults(source, { port: 8317, apiKey: "different", mode: "repair-panel" });
    const updated = parse(repaired);
    expect(updated.server).toEqual(original.server);
    expect(updated.access).toEqual(original.access);
    expect(updated.oauth).toEqual(original.oauth);
    expect(updated.management).toMatchObject({
      "secret-key": "$2a$10$existing-hash",
      "disable-control-panel": false,
      "disable-auto-update-panel": true,
    });
    expect(repaired).toContain("# preserve user comments");
    expect(applyCpaConfigDefaults(repaired, { port: 8317, mode: "repair-panel" })).toBe(repaired);
  });

  it("does not treat an upstream placeholder as an unconfigured desktop", () => {
    const config = parse(defaultCpaConfigYaml());
    config.management["secret-key"] = "user-management";
    config.access["api-keys"] = ["user-client"];
    config["api-keys"] = { codex: [{ keys: [{ "api-key": "change-me" }] }] };
    expect(isPlaceholderCpaConfig(stringify(config))).toBe(false);
    expect(isPlaceholderCpaConfig(defaultCpaConfigYaml())).toBe(true);
  });

  it("honors v8 client and management fields when legacy fields coexist", () => {
    const config = parse(defaultCpaConfigYaml());
    config["api-keys"] = ["legacy-client"];
    config["remote-management"] = { "secret-key": "legacy-management" };
    const updated = parse(applyCpaConfigDefaults(stringify(config), { port: 8317, apiKey: "v8-client" }));
    expect(updated.access["api-keys"]).toEqual(["v8-client"]);
    expect(updated.management["secret-key"]).toBe("v8-client");
    expect(updated["remote-management"]["secret-key"]).toBe("legacy-management");
  });

  it("rejects invalid YAML without leaking credentials in diagnostics", () => {
    expect(() => applyCpaConfigDefaults('management: [secret-value', { port: 8317 }))
      .toThrow("CPA config must be a valid YAML mapping");
  });
});
