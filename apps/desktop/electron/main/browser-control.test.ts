import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { sessionLabel } = require(path.resolve("resources/playwright-mcp/session-label.cjs"));

describe("browser session label", () => {
  it("summarizes the conversation title without request boilerplate", () => {
    expect(sessionLabel("请帮我分析销售趋势，列出异常原因")).toBe("AgentOS：分析销售趋势");
  });

  it("caps the summary at ten visible characters without splitting emoji", () => {
    const label = sessionLabel("👨‍👩‍👧‍👦家庭旅行计划安排与目的地筛选");
    const text = label.slice("AgentOS：".length);
    const parts = [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(text)];
    expect(parts).toHaveLength(10);
    expect(text.startsWith("👨‍👩‍👧‍👦")).toBe(true);
  });

  it("uses a fallback and strips controls and duplicate prefixes", () => {
    expect(sessionLabel("\n\t")).toBe("AgentOS：浏览器会话");
    expect(sessionLabel("AgentOS：测试\u0000页面")).toBe("AgentOS：测试页面");
  });
});
