import { expect, it } from "vitest";
import { markdownFileLink } from "./markdown-file-link";

const root = "D:/project";
it.each([
  ["docs/api/supplier-payment-openid-query.md", "docs/api/supplier-payment-openid-query.md", undefined],
  ["./docs/%E6%8E%A5%E5%8F%A3%20API.md#L61", "docs/接口 API.md", 61],
  ["file:///D:/project/docs/report.md#L42", "docs/report.md", 42],
  ["D:\\project\\docs\\report.md:12:3", "docs/report.md", 12],
  ["/D:/project/docs/report.md", "docs/report.md", undefined],
] as const)("resolves %s inside the session project", (href, rel, line) => {
  expect(markdownFileLink(root, href)).toEqual({ rel, line });
});
it.each(["https://example.com/doc", "mailto:review@example.com", "javascript:alert(1)", "../outside.md",
  "%2e%2e/outside.md", "file:///D:/other/file.md", "//other-host/file", "#fragment"])("does not route %s into the editor", href => {
  expect(markdownFileLink(root, href)).toBeNull();
});
