import { describe, expect, it } from "vitest";
import { createLru } from "./lru";

describe("createLru", () => {
  it("evicts the oldest key once over cap", () => {
    const lru = createLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.has("a")).toBe(false);
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
    expect(lru.size).toBe(2);
  });

  it("get refreshes recency so a touched key survives", () => {
    const lru = createLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("c")).toBe(true);
  });
});
