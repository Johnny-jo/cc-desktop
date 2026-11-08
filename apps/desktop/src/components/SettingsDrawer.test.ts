import { describe, expect, it, vi } from "vitest";
import { buildMcpServersPatch, mcpServersToDrafts, mergeBrowserAuthorizationStatus, setControlEnabled, suggestMcpServerName } from "./SettingsDrawer";

vi.mock("../state/store", () => ({}));

describe("Windows desktop settings form", () => {
  it("round trips the opt-in preset without command or connection fields", () => {
    const saved = { computer: { type: "windows-computer" } } as const;
    expect(mcpServersToDrafts()).toEqual([]);
    expect(buildMcpServersPatch(mcpServersToDrafts(saved))).toEqual({ ok: true, mcpServers: saved, disabledControlServers: {} });
  });

  it("suggests a free name for each new desktop server", () => {
    expect(suggestMcpServerName("windows-computer", [])).toBe("computer");
    const rows = mcpServersToDrafts({ computer: { command: "node" }, "computer-2": { type: "windows-computer" } });
    expect(suggestMcpServerName("windows-computer", rows)).toBe("computer-3");
  });
});

describe("browser settings form", () => {
  it("disables and restores every named profile for just the selected browser", () => {
    const chrome = {
      personal: { type: "playwright", browser: "chrome", connection: "isolated", profile: "Profile 2" },
      work: { type: "playwright", browser: "chrome", connection: "extension", profile: "Default" },
    } as const;
    const others = {
      edge: { type: "playwright", browser: "msedge", connection: "isolated" },
      custom: { type: "stdio", command: "node", args: ["a b"], timeout: 400, alwaysLoad: true },
    } as const;
    const saved = { ...others, ...chrome, custom: { ...others.custom, args: [...others.custom.args] } };
    const disabled = buildMcpServersPatch(setControlEnabled(mcpServersToDrafts(saved), "chrome", false));
    expect(disabled).toEqual({ ok: true, mcpServers: others, disabledControlServers: chrome });
    if (!disabled.ok) throw new Error(disabled.error);
    const reopened = mcpServersToDrafts(disabled.mcpServers, disabled.disabledControlServers);
    expect(buildMcpServersPatch(setControlEnabled(reopened, "chrome", true)))
      .toEqual({ ok: true, mcpServers: saved, disabledControlServers: {} });
  });

  it("creates opted-in presets without colliding with custom or inactive names", () => {
    const rows = mcpServersToDrafts({ browser: { command: "node" } }, {
      "browser-2": { type: "playwright", browser: "chrome" },
    });
    const active = setControlEnabled(rows, "msedge", true);
    expect(buildMcpServersPatch(active)).toMatchObject({ ok: true, mcpServers: {
      "browser-3": { type: "playwright", browser: "msedge", connection: "extension" },
    } });
    expect(setControlEnabled(active, "msedge", true)).toEqual(active);
  });

  it("routes invalid inactive profile edits and cross-page name collisions to their rows", () => {
    const [custom, chrome] = mcpServersToDrafts({ custom: { command: "node" } }, {
      chrome: { type: "playwright", browser: "chrome" },
    });
    expect(buildMcpServersPatch([custom, { ...chrome, name: "custom" }])).toMatchObject({ ok: false, row: chrome.id });
    expect(buildMcpServersPatch([custom, { ...chrome, profile: "../Default" }])).toMatchObject({ ok: false, row: chrome.id });
  });

  it.each(["extension", "isolated"] as const)("keeps %s and the selected profile when saving other settings", (connection) => {
    const saved = { browser: { type: "playwright", browser: "msedge", connection, profile: "Profile 2" } } as const;
    expect(buildMcpServersPatch(mcpServersToDrafts(saved))).toEqual({ ok: true, mcpServers: saved, disabledControlServers: {} });
  });

  it("saves legacy browser presets as daily-browser connections", () => {
    expect(buildMcpServersPatch(mcpServersToDrafts({ browser: { type: "playwright", browser: "msedge" } })))
      .toEqual({ ok: true, disabledControlServers: {}, mcpServers: { browser: { type: "playwright", browser: "msedge", connection: "extension" } } });
  });

  it("rejects unsafe profile edits before saving", () => {
    const drafts = mcpServersToDrafts({ browser: { type: "playwright", browser: "chrome", profile: "../Default" } });
    expect(buildMcpServersPatch(drafts).ok).toBe(false);
  });

  it("clears a pasted token when refreshing resolves a different browser profile", () => {
    const before = { token: "draft-authorization", status: { browser: "msedge" as const, profileName: "Profile 2", configured: false } };
    expect(mergeBrowserAuthorizationStatus(before, { browser: "msedge", profileName: "Default", configured: false }).token).toBe("");
    expect(mergeBrowserAuthorizationStatus(before, { browser: "chrome", profileName: "Profile 2", configured: false }).token).toBe("");
    expect(mergeBrowserAuthorizationStatus(before, { browser: "msedge", profileName: "profile 2", configured: false }).token).toBe("draft-authorization");
  });
});
