import { readPdfText } from "./pdf-text";
import { LocalOcr } from "./local-ocr";
import { isMainThread, parentPort as threadPort, Worker } from "node:worker_threads";

type Request = { id: number; bytes: Uint8Array };
type Reply = { id: number; type: "progress" | "result"; text?: string; error?: string };
if (isMainThread && process.parentPort) {
  // PDF.js treats Electron's utility main thread as a DOM renderer. A Node
  // worker inside this isolated process selects its supported Node factories
  // without modifying process.type or putting native OCR in the desktop host.
  const port = process.parentPort;
  const worker = new Worker(__filename, { resourceLimits: { maxOldGenerationSizeMb: 512 } });
  port.on("message", event => worker.postMessage(event.data));
  worker.on("message", reply => port.postMessage(reply));
  worker.on("error", () => process.exit(1));
  worker.on("exit", code => process.exit(code));
} else {
  const ocr = new LocalOcr(process.env.CC_DESKTOP_OCR_MODELS_DIR);
  const send = (reply: Reply) => { if (threadPort) threadPort.postMessage(reply); else process.send?.(reply); };
  let queue: Promise<unknown> = Promise.resolve();
  const receive = (request: Request) => {
    queue = queue.then(async () => {
      if (!Number.isInteger(request?.id) || !(request.bytes instanceof Uint8Array)) return;
      try {
        const text = await readPdfText(request.bytes, { ocr,
          onProgress: () => send({ id: request.id, type: "progress" }),
        });
        send({ id: request.id, type: "result", text });
      } catch (error) {
        send({ id: request.id, type: "result", error: error instanceof Error ? error.message : "PDF/OCR 处理失败。" });
      }
    });
  };
  if (threadPort) threadPort.on("message", receive);
  else {
    process.on("message", message => receive(message as Request));
    process.on("disconnect", () => { process.exit(0); });
  }
}
