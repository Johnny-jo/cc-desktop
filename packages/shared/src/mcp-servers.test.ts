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
