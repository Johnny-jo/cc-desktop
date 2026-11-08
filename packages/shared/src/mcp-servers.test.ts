import { describe, expect, it } from "vitest";
import {
  sanitizeMcpServers,
  validateMcpServerConfig,
  validateMcpServers,
} from "./mcp-servers";

describe("validateMcpServerConfig", () => {
  it("accepts a valid stdio server", () => {
    expect(
      validateMcpServerConfig("fs", { type: "stdio", command: "node", args: ["s.js"] }),
    ).toBeNull();
  });

  it("accepts stdio with omitted type", () => {
    expect(validateMcpServerConfig("fs", { command: "npx" })).toBeNull();
  });

  it("rejects stdio without command", () => {
    expect(validateMcpServerConfig("fs", { type: "stdio", command: " " })).toMatch(
      /command is required/,
    );
  });

  it("accepts a valid http server", () => {
    expect(
      validateMcpServerConfig("api", { type: "http", url: "https://x.test/mcp" }),
    ).toBeNull();
  });

  it("rejects http without url", () => {
    expect(validateMcpServerConfig("api", { type: "http", url: "" })).toMatch(
      /url is required/,
    );
  });

  it("rejects a non-http url", () => {
    expect(validateMcpServerConfig("api", { type: "sse", url: "ftp://x" })).toMatch(
      /must start with http/,
    );
  });

  it("rejects an invalid name", () => {
    expect(validateMcpServerConfig("bad name!", { command: "node" })).toMatch(/name/);
  });

  it.each([undefined, "extension", "isolated"] as const)("accepts browser connection %s", (connection) => {
    expect(validateMcpServerConfig("browser", {
      type: "playwright", browser: "msedge", connection, profile: "Profile 2",
    })).toBeNull();
  });

  it("rejects an unknown browser connection", () => {
    expect(validateMcpServerConfig("browser", {
      type: "playwright", browser: "msedge", connection: "remote" as never,
    })).toMatch(/connection/);
  });

  it.each(["../Default", "..\\Default", "a/b", "a\\b", ".", "..", "C:Default", "a\u0000b", "a".repeat(81)])(
    "rejects unsafe browser profile %j", (profile) => {
      expect(validateMcpServerConfig("browser", {
        type: "playwright", browser: "msedge", profile,
      })).toMatch(/profile/);
    },
  );

  it.each([undefined, "", "Default", "Profile 2", "a".repeat(80)])("accepts profile %j", (profile) => {
    expect(validateMcpServerConfig("browser", { type: "playwright", browser: "chrome", profile })).toBeNull();
  });
});

describe("validateMcpServers", () => {
  it("returns the map when all valid", () => {
    const map = { a: { command: "node" }, b: { type: "http" as const, url: "https://x" } };
    const r = validateMcpServers(map);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mcpServers).toEqual(map);
  });

  it("returns the first error", () => {
    const r = validateMcpServers({ a: { type: "stdio", command: "" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/command is required/);
  });
});

describe("sanitizeMcpServers", () => {
  it("validates the Windows desktop preset and reloads only its type", () => {
    const saved = { computer: { type: "windows-computer" } } as const;
    expect(validateMcpServers(saved)).toEqual({ ok: true, mcpServers: saved });
    const json = JSON.stringify({ computer: { ...saved.computer, command: "unused", env: { X: "1" } } });
    expect(sanitizeMcpServers(JSON.parse(json))).toEqual(saved);
  });

  it("round trips browser connection and profile through persisted JSON", () => {
    const saved = {
      daily: { type: "playwright", browser: "msedge", connection: "extension", profile: "Profile 2" },
      isolated: { type: "playwright", browser: "chrome", connection: "isolated", profile: "" },
      legacy: { type: "playwright", browser: "msedge" },
    };
    expect(sanitizeMcpServers(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it("drops browser presets with invalid connection or profile fields", () => {
    expect(sanitizeMcpServers({
      badConnection: { type: "playwright", browser: "msedge", connection: "remote" },
      badProfile: { type: "playwright", browser: "chrome", profile: "../Default" },
      nonStringProfile: { type: "playwright", browser: "chrome", profile: 2 },
    })).toEqual({});
  });
  it("returns {} for non-object input", () => {
    expect(sanitizeMcpServers(null)).toEqual({});
    expect(sanitizeMcpServers("x")).toEqual({});
    expect(sanitizeMcpServers([1])).toEqual({});
  });

  it("keeps valid stdio and http servers, drops invalid entries", () => {
    const out = sanitizeMcpServers({
      good: { type: "stdio", command: "node", args: ["a.js"], env: { A: "1" } },
      goodHttp: { type: "http", url: "https://x", headers: { H: "v" } },
      noCmd: { type: "stdio" },
      noUrl: { type: "http" },
      notObj: "nope",
    });
    expect(Object.keys(out).sort()).toEqual(["good", "goodHttp"]);
    expect(out.good).toMatchObject({ command: "node", args: ["a.js"], env: { A: "1" } });
    expect(out.goodHttp).toMatchObject({ url: "https://x", headers: { H: "v" } });
  });

  it("drops non-string env/headers values", () => {
    const out = sanitizeMcpServers({
      a: { command: "node", env: { GOOD: "1", BAD: 5 } },
    });
    // env has a non-string value → whole env record dropped, server kept
    expect(out.a).toMatchObject({ command: "node" });
    expect(out.a && "env" in out.a).toBe(false);
  });
});
