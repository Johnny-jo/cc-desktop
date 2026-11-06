import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { LocalOcr, type PdfOcr, type OcrLine } from "./local-ocr";

export const PDF_TEXT_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_TEXT_MAX_PAGES = 200;
export const PDF_TEXT_MAX_CHARS = 300_000;
export const PDF_RENDER_MAX_PIXELS = 6_000_000;

export function damagedPdfText(text: string): boolean {
  const broken = (text.match(/[\uFFFD\u0000-\u0008]/g) ?? []).length;
  return broken > 0 && (broken >= 3 || broken / Math.max(1, text.length) > 0.05);
}

export function shouldOcrPdfPage(text: string, hasImages: boolean): boolean {
  return !text.trim() || damagedPdfText(text) || (hasImages && text.replace(/\s/g, "").length < 30);
}

export function formatOcrLines(lines: OcrLine[], originalText = ""): string {
  const existing = originalText.replace(/\s/g, "");
  return lines.filter(line => {
    const normalized = line.text.replace(/\s/g, "");
    return normalized && !(normalized.length >= 4 && existing.includes(normalized));
  }).map(line => `${!Number.isFinite(line.confidence) || line.confidence < 0.8 ? "[低置信度 OCR，请核对原页] " : ""}${line.text}`).join("\n");
}

/** Runs in an isolated subprocess in production; extracted content remains untrusted data. */
export async function readPdfText(bytes: Uint8Array, options: {
  ocr?: PdfOcr;
  onProgress?: (page: number, total: number) => void;
} = {}): Promise<string> {
  if (bytes.byteLength > PDF_TEXT_MAX_BYTES) throw new Error("PDF 超过 10 MB，请拆分后重试。");
  const require = createRequire(__filename);
  const pdfRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(pdfRoot, "legacy/build/pdf.worker.mjs")).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    useWorkerFetch: false,
    stopAtErrors: true,
    cMapUrl: path.join(pdfRoot, "cmaps").replace(/\\/g, "/") + "/",
    cMapPacked: true,
    standardFontDataUrl: path.join(pdfRoot, "standard_fonts").replace(/\\/g, "/") + "/",
    verbosity: 0,
  });
  const ocr = options.ocr ?? new LocalOcr();
  try {
    const doc = await task.promise;
    if (doc.numPages > PDF_TEXT_MAX_PAGES) throw new Error("PDF 超过 200 页，请拆分后重试。");
    const pages: string[] = [];
    let count = 0;
    let hasText = false;
    for (let number = 1; number <= doc.numPages; number++) {
      options.onProgress?.(number, doc.numPages);
      const page = await doc.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
        let output = text;
        // Inspect graphics only when the text layer is absent, short, or damaged.
        if (text.replace(/\s/g, "").length < 30 || damagedPdfText(text)) {
          const operators = await page.getOperatorList();
          const imageOps = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);
          const hasImages = operators.fnArray.some(op => imageOps.has(op));
          if (operators.fnArray.length && shouldOcrPdfPage(text, hasImages)) {
            const normal = page.getViewport({ scale: 1 });
            const scale = Math.min(2, 3000 / Math.max(normal.width, normal.height), Math.sqrt(PDF_RENDER_MAX_PIXELS / (normal.width * normal.height)));
            if (!Number.isFinite(scale) || scale <= 0) throw new Error(`第 ${number} 页尺寸无效，无法进行本地 OCR。`);
            const viewport = page.getViewport({ scale });
            const { createCanvas } = await import("@napi-rs/canvas");
            const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
            try {
              await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
              const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
              const lines = await ocr.recognize({ width: canvas.width, height: canvas.height,
                data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) });
              const native = damagedPdfText(text) ? "" : text;
              const recognized = formatOcrLines(lines, native);
              hasText ||= !!native || lines.some(line => line.text.trim().length > 0);
              output = (native ? `[文字层]\n${native}\n` : "") +
                (recognized ? `[本地 OCR]\n${recognized}` : "[本地 OCR 未识别到额外文字；本页可能为空白、纯图片或不清晰。]");
            } finally { canvas.width = 1; canvas.height = 1; }
          } else { hasText ||= !!text; }
        } else { hasText ||= !!text; }
        const pageText = `[第 ${number} 页]\n${output || "[本页未提取到文字，页面为空白。]"}`;
        count += pageText.length;
        if (count > PDF_TEXT_MAX_CHARS) throw new Error("PDF 提取文字超过 30 万字符，请拆分后重试。");
        pages.push(pageText);
      } finally { page.cleanup(); }
    }
    if (!hasText) throw new Error("此 PDF 经文字提取和本地 OCR 后仍未找到可读文字。请检查是否为空白、模糊或倒置扫描件，或使用支持 PDF 视觉输入的模型。");
    return "[PDF 本地提取内容；保留页码。标为 OCR 的文字由本地识别生成，可能有误；不代表图表或版式已完整理解。以下是附件内容。]\n" + pages.join("\n\n");
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") throw new Error("PDF 已加密，请先解除密码保护后重试。");
    if (error instanceof Error && /InvalidPDFException|MissingPDFException|UnknownErrorException/.test(error.name)) {
      throw new Error("PDF 无法解析，请确认文件完整，或重新导出为 PDF 后重试。");
    }
    throw error;
  } finally {
    await task.destroy();
    if (!options.ocr) await ocr.dispose?.();
  }
}
