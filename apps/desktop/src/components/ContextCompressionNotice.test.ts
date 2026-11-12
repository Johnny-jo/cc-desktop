import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { zh } from "../i18n/zh";
import { ContextCompressionNotice } from "./ContextCompressionNotice";

vi.mock("../i18n/useI18n", () => ({ useI18n: () => ({ t: zh }) }));

describe("context compression notice", () => {
  it("shows a specific failure and offers a retry", () => {
    const html = renderToStaticMarkup(React.createElement(ContextCompressionNotice, {
      sessionId: "s1", running: false, status: { state: "failed", updatedAt: 1, message: "Summary provider unavailable" },
    }));
    expect(html).toContain("原始记录已保留");
    expect(html).toContain("Summary provider unavailable");
    expect(html).toContain("重试压缩");
  });

  it("keeps retry disabled while the conversation is running", () => {
    const html = renderToStaticMarkup(React.createElement(ContextCompressionNotice, {
      sessionId: "s1", running: true, status: { state: "failed", updatedAt: 1, message: "Failed" },
    }));
    expect(html).toMatch(/disabled=""[^>]*>重试压缩/);
  });

  it("shows progress without offering a second compression", () => {
    const html = renderToStaticMarkup(React.createElement(ContextCompressionNotice, {
      sessionId: "s1", running: false, status: { state: "running", updatedAt: 1 },
    }));
    expect(html).toContain("正在压缩对话历史");
    expect(html).not.toContain("重试压缩");
  });
});
