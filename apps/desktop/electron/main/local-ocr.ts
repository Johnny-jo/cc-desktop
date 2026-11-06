import type { PaddleOcrService, PaddleOptions } from "paddleocr";
import { readVerifiedOcrModels, resolveOcrModelsDir } from "./ocr-models";

export type OcrLine = { text: string; confidence: number };
export type OcrImage = { width: number; height: number; data: Uint8Array };
export interface PdfOcr {
  recognize(image: OcrImage): Promise<OcrLine[]>;
  dispose?(): Promise<void>;
}

/** Owned by the document subprocess. No native inference runs in the UI/main process. */
export class LocalOcr implements PdfOcr {
  private pending?: Promise<PaddleOcrService>;
  constructor(private readonly modelsDir = resolveOcrModelsDir()) {}

  private async load(): Promise<PaddleOcrService> {
    const models = readVerifiedOcrModels(this.modelsDir);
    const ort = await import("onnxruntime-node");
    const { PaddleOcrService } = await import("paddleocr");
    // The pipeline accepts an ORT-shaped adapter. Fix CPU/thread settings for both sessions.
    const cpuRuntime = { ...ort, InferenceSession: {
      create: (data: ArrayBuffer) => ort.InferenceSession.create(data, {
        executionProviders: ["cpu"], intraOpNumThreads: 4, interOpNumThreads: 1,
      }),
    } } as unknown as PaddleOptions["ort"];
    const buffer = (name: keyof typeof models) => {
      const bytes = models[name];
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    };
    const dictionary = models["ppocrv5_dict.txt"].toString("utf8").trimEnd().split(/\r?\n/);
    return PaddleOcrService.createInstance({
      ort: cpuRuntime, modelPreset: "PP-OCRv5_mobile",
      detection: { modelBuffer: buffer("PP-OCRv5_mobile_det_infer.onnx") },
      recognition: { modelBuffer: buffer("PP-OCRv5_mobile_rec_infer.onnx"), charactersDictionary: [...dictionary, " "] },
    });
  }

  async recognize(image: OcrImage): Promise<OcrLine[]> {
    this.pending ??= this.load();
    const service = await this.pending;
    const results = await service.recognize(image, { ordering: { sortByReadingOrder: true } });
    return results.filter(line => line.text.trim()).map(line => ({ text: line.text.trim(), confidence: line.confidence }));
  }

  async dispose(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) await pending.then(service => service.destroy(), () => undefined);
  }
}
