import { describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { readPdfText, PDF_TEXT_MAX_BYTES, PDF_TEXT_MAX_PAGES, shouldOcrPdfPage, formatOcrLines } from "./pdf-text";
import { pdfFixture, mixedPdfFixture } from "./pdf-test-fixture";

function scanImage() {
  const canvas = createCanvas(1000, 1415);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "black"; ctx.font = '32px "Microsoft YaHei", sans-serif';
  ctx.fillText("本地 OCR 测试", 70, 160);
  ctx.fillText("Project CEDAR-731", 70, 260);
  ctx.fillText("Budget 24680 USD", 70, 360);
  return { jpeg: canvas.toBuffer("image/jpeg"), width: canvas.width, height: canvas.height };
}

describe("local PDF extraction", () => {
  it("preserves text and page evidence and marks pages with no text", async () => {
    const text = await readPdfText(pdfFixture(["First page evidence 314159", "", "Third page evidence"]));
    expect(text).toContain("[第 1 页]\nFirst page evidence 314159");
    expect(text).toContain("[第 2 页]\n[本页未提取到文字");
    expect(text).toContain("[第 3 页]\nThird page evidence");
  });
  it("decodes Chinese text using bundled CMaps", async () => {
    expect(await readPdfText(pdfFixture(["项目预算合计三万元"], true))).toContain("项目预算合计三万元");
  });
  it("rejects empty documents instead of sending an empty successful attachment", async () => {
    await expect(readPdfText(pdfFixture([""]))).rejects.toThrow("仍未找到可读文字");
  });
  it("rejects corrupt documents", async () => {
    await expect(readPdfText(Buffer.from("not a pdf"))).rejects.toThrow("PDF 无法解析");
  });
  it("bounds PDF size and page count", async () => {
    await expect(readPdfText(new Uint8Array(PDF_TEXT_MAX_BYTES + 1))).rejects.toThrow("10 MB");
    await expect(readPdfText(pdfFixture(Array(PDF_TEXT_MAX_PAGES + 1).fill("page")))).rejects.toThrow("200 页");
  });

  it("preserves native text and only OCRs scanned pages, with page numbers and uncertainty", async () => {
    const recognize = vi.fn(async () => [{ text: "扫描正文 314159", confidence: 0.98 }, { text: "金额 1000", confidence: 0.65 }]);
    const original = "Original text-layer evidence must be preserved exactly 13579.";
    const result = await readPdfText(mixedPdfFixture([{ text: original }, { image: scanImage() }]), { ocr: { recognize } });
    expect(result).toContain(`[第 1 页]\n${original}`);
    expect(result).toContain("[第 2 页]\n[本地 OCR]\n扫描正文 314159");
    expect(result).toContain("[低置信度 OCR，请核对原页] 金额 1000");
    expect(recognize).toHaveBeenCalledOnce();
  });

  it("OCRs scan pages with short native headers without duplicating the header", async () => {
    const result = await readPdfText(mixedPdfFixture([{ text: "Report header", image: scanImage() }]), {
      ocr: { recognize: async () => [{ text: "Report header", confidence: 0.99 }, { text: "Body from scan", confidence: 0.99 }] },
    });
    expect(result.match(/Report header/g)).toHaveLength(1);
    expect(result).toContain("[文字层]\nReport header");
    expect(result).toContain("[本地 OCR]\nBody from scan");
  });

  it("surfaces local OCR failure instead of silently sending a partial PDF", async () => {
    await expect(readPdfText(mixedPdfFixture([{ image: scanImage() }]), {
      ocr: { recognize: async () => { throw new Error("本地 OCR 模型缺失"); } },
    })).rejects.toThrow("本地 OCR 模型缺失");
  });

  it("runs the bundled CPU models on an actual image-only PDF", async () => {
    const result = await readPdfText(mixedPdfFixture([{ image: scanImage() }]));
    expect(result).toContain("[本地 OCR]");
    expect(result).toContain("CEDAR-731");
    expect(result).toContain("24680");
  }, 30_000);

  it("identifies broken text and retains low-confidence OCR as uncertain", () => {
    expect(shouldOcrPdfPage("abc\uFFFD\uFFFD", false)).toBe(true);
    expect(shouldOcrPdfPage("This is a complete valid text layer longer than thirty characters.", true)).toBe(false);
    expect(formatOcrLines([{ text: "unreliable", confidence: NaN }])).toContain("低置信度");
  });
});
