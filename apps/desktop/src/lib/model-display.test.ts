import { describe, expect, it } from "vitest";
import { displayModelId } from "./model-display";

describe("displayModelId", () => {
  const providers = [{ id: "openai-1794230000000" }, { id: "router-account" }];

  it("removes only a known app provider prefix", () => {
    expect(displayModelId("openai-1794230000000/gpt-6.1-sol", providers)).toBe("gpt-6.1-sol");
  });

  it("preserves upstream company/model names, including behind an app provider", () => {
    expect(displayModelId("openai/gpt-6.1-sol", providers)).toBe("openai/gpt-6.1-sol");
    expect(displayModelId("router-account/anthropic/claude-sonnet", providers)).toBe("anthropic/claude-sonnet");
    expect(displayModelId("unknown-provider/model", providers)).toBe("unknown-provider/model");
  });

  it("requires a complete prefix and an upstream model", () => {
    expect(displayModelId("router-account2/model", providers)).toBe("router-account2/model");
    expect(displayModelId("router-account/", providers)).toBe("router-account/");
    expect(displayModelId("gpt-6.1-sol", providers)).toBe("gpt-6.1-sol");
    expect(displayModelId("", providers)).toBe("");
  });
});
