import { parentPort, workerData } from "node:worker_threads";
import { lookupCodeSymbol, type CodeSymbolRequest } from "./code-symbol-index";

async function run() {
  const { root, request } = workerData as { root: string; request: CodeSymbolRequest };
  const result = await lookupCodeSymbol(root, request);
  parentPort!.postMessage({ result });
}

void run();
