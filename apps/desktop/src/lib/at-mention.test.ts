import { describe, expect, it } from "vitest";
import { parseTrailingAt } from "./at-mention";

describe("parseTrailingAt", () => {
  it("parses a bare @ at start of text", () => {
    expect(parseTrailingAt("@")).toEqual({ query: "", start: 0, end: 1 });
  });

  it("parses a trailing @query at start of text", () => {
    expect(parseTrailingAt("@src/ind")).toEqual({
      query: "src/ind",
      start: 0,
      end: 8,
    });
  });

  it("parses an @query preceded by a space", () => {
    const text = "look at @src/comp";
    expect(parseTrailingAt(text)).toEqual({
      query: "src/comp",
      start: 8,
      end: text.length,
    });
  });

  it("parses an @query preceded by a newline", () => {
    const text = "first line\n@util";
    expect(parseTrailingAt(text)).toEqual({
      query: "util",
      start: 11,
      end: text.length,
    });
  });

  it("returns null for an email-like token (@ glued to non-space)", () => {
    expect(parseTrailingAt("contact user@example.com")).toBeNull();
  });

  it("returns null once the token is completed with a space", () => {
    expect(parseTrailingAt("see @src/a.ts and more")).toBeNull();
  });

  it("returns null when there is no @", () => {
    expect(parseTrailingAt("just some text")).toBeNull();
  });

  it("returns null when query contains a second @", () => {
    expect(parseTrailingAt("@foo@bar")).toBeNull();
  });
});
