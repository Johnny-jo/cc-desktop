import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { CodeSymbolRequest } from "./code-symbol-index";

// Each query has a fresh compiler program. Bound simultaneous heaps and release
// a slot on worker exit, including when a running query was cancelled.
const parallelLookups = 2;
const waiting = new Set<() => void>();
let running = 0;

function workerScript(): string {
  // electron-vite may place this lazy module in out/main/chunks. Resolve
  // from Electron's app root in both the dev app and the packaged ASAR.
  const root = process.versions.electron && process.type === "browser"
    ? (createRequire(__filename)("electron") as typeof import("electron")).app.getAppPath()
    : path.resolve(__dirname, "../..");
  return path.join(root, "out/main/code-symbol-worker.js");
}

function releaseSlot(): void {
  running--;
  const next = waiting.values().next().value;
  if (next) {
    waiting.delete(next);
    next();
  }
}

export function runCodeSymbolLookup(root: string, request: CodeSymbolRequest, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(60_000);
  const cancelled = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return new Promise((resolve, reject) => {
    cancelled.throwIfAborted();
    let worker: Worker | undefined;
    const abort = () => {
      waiting.delete(start);
      reject(cancelled.reason);
      if (worker) void worker.terminate();
    };
    const finish = () => {
      cancelled.removeEventListener("abort", abort);
      releaseSlot();
    };
    function start() {
      running++;
      try {
        worker = new Worker(workerScript(), { workerData: { root, request }, execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 512 } });
      } catch (error) {
        reject(error);
        finish();
        return;
      }
      let replied = false;
      worker.once("message", (reply: { result: unknown }) => {
        replied = true;
        resolve(reply.result);
      });
      worker.once("error", reject);
      worker.once("exit", code => {
        if (!replied) reject(new Error(`Code index worker exited before replying (code ${code}).`));
        finish();
      });
    }
    cancelled.addEventListener("abort", abort, { once: true });
    if (running < parallelLookups) start();
    else waiting.add(start);
  });
}
