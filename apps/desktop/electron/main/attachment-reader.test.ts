import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentFromFile } from "@claude-desktop/shared";
import { buildUserContent, readAttachment, MAX_PDF_ATTACHMENT_SIZE } from "./attachment-reader";

const dirs: string[] = [];
function file(name: string, bytes: Buffer | string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachment-reader-"));
  dirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return attachmentFromFile({ name, path: filePath, size: Buffer.byteLength(bytes) });
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("attachment content", () => {
  it("sends PDF bytes as a document block alongside the user's message", () => {
    const bytes = Buffer.from("%PDF-1.4\nfixture PDF bytes\n%%EOF");
    const pdf = file("中文报告.pdf", bytes);
    const result = buildUserContent({ text: "请阅读附件", attachments: [pdf] });
    expect(result.errors).toEqual([]);
    expect(result.content).toEqual([
      { type: "text", text: "请阅读附件" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } },
    ]);
  });

  it("checks actual disk size even if the file changed after being attached", () => {
    const pdf = file("grown.pdf", "%PDF-1.4");
    fs.truncateSync(pdf.path, MAX_PDF_ATTACHMENT_SIZE + 1);
    expect(readAttachment(pdf)).toMatchObject({ ok: false, error: expect.stringContaining("10.00 MB") });
  });

  it.each(["report.doc", "sheet.xlsx"])("never UTF-8 decodes %s even with legacy text metadata", name => {
    const attachment = file(name, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]));
    expect(readAttachment({ ...attachment, mimeType: "text/plain", kind: "text" })).toMatchObject({
      ok: false, error: expect.stringContaining("转换为 PDF 或 TXT"),
    });
  });

  it.each(["hello.txt", "sample.json"])("preserves UTF-8 content from %s", name => {
    const attachment = file(name, "你好，附件内容");
    expect(readAttachment(attachment)).toMatchObject({ ok: true, block: { type: "text", text: expect.stringContaining("你好，附件内容") } });
  });

  it("reports invalid text encoding and missing files instead of injecting replacement characters", () => {
    const attachment = file("bad.txt", Buffer.from([0xff, 0x00, 0xfe]));
    expect(readAttachment(attachment)).toMatchObject({ ok: false, error: expect.stringContaining("UTF-8") });
    fs.unlinkSync(attachment.path);
    expect(readAttachment(attachment)).toMatchObject({ ok: false, error: expect.stringContaining("File not found") });
  });
});
