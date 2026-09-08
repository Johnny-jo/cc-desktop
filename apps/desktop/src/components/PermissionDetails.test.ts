import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PermissionDetails, permissionAction } from "./PermissionDetails";
import { zh } from "../i18n/zh";
import { en } from "../i18n/en";

function render(toolName: string, inputPreview: Record<string, unknown>) {
  return renderToStaticMarkup(React.createElement(PermissionDetails, { request: { requestId: "r", sessionId: "s", toolName, summary: "summary", inputPreview }, t: zh.prompts }));
}

describe("permission details", () => {
  it("shows the path and full before/after text with actual newlines", () => {
    const html = render("Edit", { file_path: "D:\\项目\\login.vue", old_string: "old\nline", new_string: "x".repeat(1000) + "\nEND", replace_all: true });
    expect(html).toContain("D:\\项目\\login.vue");
    expect(html).toContain("old\nline");
    expect(html).toContain("x".repeat(1000) + "\nEND");
    expect(html).toContain("替换所有匹配内容");
    expect(html).toContain('<details class="permission-raw-details">');
    expect(html).not.toContain(" open=");
  });
  it("shows empty replacement and warns that Write replaces existing content", () => {
    expect(render("Edit", { path: "a", old_string: "a", new_string: "" })).toContain("（空内容）");
    expect(render("Write", { path: "a", content: "" })).toContain("文件存在时会覆盖原内容");
  });
  it("escapes code as text and keeps unknown tool parameters available", () => {
    expect(render("Write", { content: "<script>alert(1)</script>" })).not.toContain("<script>");
    expect(render("custom", { value: "tail" })).toContain("tail");
    expect(render("Bash", { command: "echo test", description: "测试命令" })).toContain("测试命令");
    expect(permissionAction("Edit", zh.prompts)).toBe("申请编辑文件");
    expect(permissionAction("Write", en.prompts)).toBe("Request to write file");
    expect(permissionAction("custom", en.prompts)).toBe("custom");
  });
});
