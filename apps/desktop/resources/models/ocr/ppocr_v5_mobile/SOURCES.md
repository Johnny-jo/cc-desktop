# Bundled local OCR

PP-OCRv5 mobile detection + recognition ONNX weights and the matching dictionary.
Imported from the user's validated x-bidding-desktop distribution on 2026-11-04;
the original VERSION and checksums are retained. No weights or dictionary were changed.

- Model project: https://github.com/PaddlePaddle/PaddleOCR
- Model documentation: https://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html
- Model license: Apache-2.0 (LICENSE-PaddleOCR.txt)
- JS pipeline: https://github.com/x3zvawq/paddleocr.js (paddleocr 1.2.0, MIT)
- Runtime: https://github.com/microsoft/onnxruntime (onnxruntime-node 1.23.0, MIT)

manifest.json pins all three asset hashes for build and runtime validation.
The 18,384 dictionary lines are followed by one explicit space entry when used by
paddleocr.js; CTC blank handling is performed by the recognition decoder.

The runtime uses only these local buffers and CPU inference. No model downloads
or cloud OCR calls take place. Orientation and table-structure models are not included.
