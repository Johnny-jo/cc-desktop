import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readVerifiedOcrModels, resolveOcrModelsDir } from "./ocr-models";

it("checks the embedded models and dictionary", () => {
  const models = readVerifiedOcrModels(resolveOcrModelsDir());
  expect(models["ppocrv5_dict.txt"].toString("utf8").trimEnd().split(/\r?\n/)).toHaveLength(18384);
});
it("resolves model assets from both split build chunks and packaged modules", () => {
  const appRoot = path.resolve(__dirname, "../..");
  expect(resolveOcrModelsDir(path.join(appRoot, "out/main/chunks"))).toBe(path.join(appRoot, "resources/models/ocr/ppocr_v5_mobile"));
  expect(resolveOcrModelsDir(path.join(appRoot, "release/win-unpacked/resources/app.asar/out/main/chunks"))).toBe(path.join(appRoot, "release/win-unpacked/resources/models/ocr/ppocr_v5_mobile"));
});
it("reports missing and damaged models with an actionable message", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-model-check-"));
  try {
    expect(() => readVerifiedOcrModels(scratch)).toThrow("本地 OCR 模型缺失");
    fs.writeFileSync(path.join(scratch, "PP-OCRv5_mobile_det_infer.onnx"), "damaged");
    expect(() => readVerifiedOcrModels(scratch)).toThrow("本地 OCR 模型校验失败");
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
