import { describe, expect, it } from "vitest";
import {
  NO_UPDATE_FEED_MESSAGE,
  renderAppUpdateYml,
  resolveUpdateSource,
} from "./auto-updater-source";

describe("resolveUpdateSource", () => {
  it("disables checks when no feed url and no packaged app-update.yml (avoids ENOENT)", () => {
    expect(
      resolveUpdateSource({
        envUrl: "",
        settingsUrl: "",
        packagedYmlExists: false,
      }),
    ).toEqual({ kind: "disabled", message: NO_UPDATE_FEED_MESSAGE });
  });

  it("treats whitespace-only urls as empty", () => {
    expect(
      resolveUpdateSource({
        envUrl: "   ",
        settingsUrl: "\t",
        packagedYmlExists: false,
      }).kind,
    ).toBe("disabled");
  });

  it("uses the settings feed when no env override", () => {
    expect(
      resolveUpdateSource({
        settingsUrl: "https://updates.example.com",
        packagedYmlExists: false,
      }),
    ).toEqual({ kind: "feed", url: "https://updates.example.com/" });
  });

  it("prefers env url over settings", () => {
    expect(
      resolveUpdateSource({
        envUrl: "https://env.example.com/",
        settingsUrl: "https://settings.example.com/",
        packagedYmlExists: true,
      }),
    ).toEqual({ kind: "feed", url: "https://env.example.com/" });
  });

  it("falls back to packaged app-update.yml when no runtime url is set", () => {
    expect(
      resolveUpdateSource({
        envUrl: "",
        settingsUrl: undefined,
        packagedYmlExists: true,
      }),
    ).toEqual({ kind: "packaged-yml" });
  });
});

describe("renderAppUpdateYml", () => {
  it("writes a generic provider config with a trailing slash", () => {
    expect(renderAppUpdateYml("https://feed.example.com/updates")).toBe(
      [
        "provider: generic",
        "url: https://feed.example.com/updates/",
        "updaterCacheDirName: cc-desktop-updater",
        "",
      ].join("\n"),
    );
  });
});
