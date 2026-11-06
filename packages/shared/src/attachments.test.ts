import { describe, expect, it } from "vitest";
import {
  attachmentFromFile,
  attachmentKindFromMime,
  formatFileSize,
  guessMimeType,
  attachmentPresentation,
  modelAttachmentError,
  MODEL_ATTACHMENT_LIMITS,
} from "./attachments";

describe("attachments", () => {
  it("guesses common mime types", () => {
    expect(guessMimeType("foo.png")).toBe("image/png");
    expect(guessMimeType("bar.jpg")).toBe("image/jpeg");
    expect(guessMimeType("baz.pdf")).toBe("application/pdf");
    expect(guessMimeType("note.txt")).toBe("text/plain");
  });

  it("classifies image and text attachments", () => {
    expect(attachmentKindFromMime("image/png")).toBe("image");
    expect(attachmentKindFromMime("text/plain")).toBe("text");
    expect(attachmentKindFromMime("application/json")).toBe("text");
    expect(attachmentKindFromMime("application/pdf")).toBe("binary");
  });

  it("builds an attachment from a file descriptor", () => {
    const a = attachmentFromFile({
      name: "test.png",
      path: "/tmp/test.png",
      size: 2048,
      type: "image/png",
    });
    expect(a).toMatchObject({
      name: "test.png",
      path: "/tmp/test.png",
      size: 2048,
      mimeType: "image/png",
      kind: "image",
    });
  });

  it("formats file sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.00 MB");
  });

  it.each([
    ["报告.DOC", "application/msword"],
    ["报告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["预算.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["archive.zip", "application/octet-stream"],
  ])("does not mistake %s for plain text", (name, mime) => {
    const attachment = attachmentFromFile({ name, path: name, size: 12 });
    expect(attachment.mimeType).toBe(mime);
    expect(attachment.kind).toBe("binary");
    expect(modelAttachmentError(attachment)).toContain("转换为 PDF 或 TXT");
  });

  it("allows PDF including 5–10 MiB instead of rejecting the binary transport kind", () => {
    const pdf = attachmentFromFile({ name: "report.pdf", path: "/report.pdf", size: MODEL_ATTACHMENT_LIMITS.pdfBytes });
    expect(pdf.kind).toBe("binary");
    expect(modelAttachmentError(pdf)).toBeNull();
    expect(modelAttachmentError({ ...pdf, size: pdf.size + 1 })).toContain("10.00 MB");
  });

  it.each(["note.txt", "data.json", "table.csv", ".gitignore", ".env", "Makefile"])("keeps %s readable", name => {
    const attachment = attachmentFromFile({ name, path: name, size: 12 });
    expect(attachment.kind).toBe("text");
    expect(modelAttachmentError(attachment)).toBeNull();
  });

  it("labels Office formats by their name even when a transferred file has generic MIME", () => {
    expect(attachmentPresentation("预算.xlsx", "application/octet-stream")).toMatchObject({ category: "sheet", label: "电子表格", extension: "XLSX" });
    expect(attachmentPresentation("报告.doc", "application/octet-stream")).toMatchObject({ category: "word", label: "Word 文档", extension: "DOC" });
    expect(attachmentPresentation("数据.json")).toMatchObject({ category: "code", label: "JSON 文件" });
  });
});
