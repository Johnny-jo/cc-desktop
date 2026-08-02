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
});
