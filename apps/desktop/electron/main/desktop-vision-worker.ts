import { createInterface } from "node:readline";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { LocalOcr } from "./local-ocr";
import { analyzeDesktopRegions } from "./desktop-vision-regions";

type Capture = {
  width: number; height: number; bounds: { x: number; y: number; width: number; height: number };
  pngBase64: string; includeImage: boolean;
};

const ocr = new LocalOcr();
async function analyze(capture: Capture) {
  const { width, height, bounds } = capture;
  const png = Buffer.from(capture.pngBase64, "base64");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
    width * height > 8388608 || width > 8192 || height > 8192 || width !== bounds.width || height !== bounds.height ||
    png.length < 24 || png.length > 8 * 1024 * 1024 ||
    png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
    throw new Error("Window capture dimensions are invalid. Request a smaller window region.");
  }
  const canvas = createCanvas(width, height);
  try {
    const ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(png), 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const image = { width, height, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) };
    // Even if the installed OCR resources are damaged, return the geometric
    // candidates and the requested image so a visual model can inspect it.
    let warning: string | undefined;
    const lines = await ocr.recognize(image).catch((error: unknown) => {
      warning = error instanceof Error ? error.message : "Local OCR failed.";
      return [];
    });
    const regions = analyzeDesktopRegions(image, lines, bounds);
    // Preserve the coordinate system even when compressing a large preview.
    const jpeg = capture.includeImage && png.length > 2 * 1024 * 1024 ? await canvas.encode("jpeg", 72) : undefined;
    return { ...regions, ...(warning ? { ocrWarning: warning } : {}),
      ...(jpeg ? { jpegBase64: jpeg.toString("base64") } : {}) };
  } finally { canvas.width = 1; canvas.height = 1; }
}

// The MCP bridge serializes requests and terminates this process on abort.
async function main() {
  const input = createInterface({ input: process.stdin });
  try {
    for await (const line of input) {
      let reply;
      try {
        const { args } = JSON.parse(line);
        reply = { value: await analyze(args) };
      } catch (error) {
        reply = { error: error instanceof Error ? error.message : "Desktop image analysis failed." };
      }
      process.stdout.write(JSON.stringify(reply) + "\n");
    }
  } finally { await ocr.dispose(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
