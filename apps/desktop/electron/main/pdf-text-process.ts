import path from "node:path";
import { fork } from "node:child_process";
import { resolveOcrModelsDir } from "./ocr-models";

type Reply = { id: number; type: "progress" | "result"; text?: string; error?: string };
export type PdfProcessHandle = {
  send: (request: { id: number; bytes: Uint8Array }) => void;
  kill: () => void;
  onMessage: (receive: (reply: Reply) => void) => void;
  onExit: (exit: () => void) => void;
  onError: (error: () => void) => void;
};
type Options = {
  scriptPath?: string;
  modelsDir?: string;
  idleMs?: number;
  stallMs?: number;
  timeoutMs?: number;
  spawn?: () => Promise<PdfProcessHandle>;
};

/** Native PDF rendering / OCR stays outside the desktop main process. */
export class PdfTextProcess {
  private child?: PdfProcessHandle;
  private serial: Promise<unknown> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private closed = false;
  private nextId = 0;
  private active?: {
    id: number;
    finish: (error?: Error, text?: string) => void;
    progress: () => void;
  };
  constructor(private readonly options: Options = {}) {}

  extract(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const pending = this.serial.then(() => this.run(bytes, signal));
    this.serial = pending.catch(() => undefined);
    return pending;
  }

  dispose(): void {
    this.closed = true;
    this.active?.finish(new Error("本地 PDF/OCR 处理已停止。"));
    this.stop();
  }

  private stop(): void {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  private async spawn(): Promise<PdfProcessHandle> {
    if (this.options.spawn) return this.options.spawn();
    const script = this.options.scriptPath ?? path.join(__dirname, "pdf-text-worker.js");
    const env = { ...process.env, CC_DESKTOP_OCR_MODELS_DIR: this.options.modelsDir ?? resolveOcrModelsDir() };
    if (process.versions.electron && process.type === "browser") {
      const { utilityProcess } = await import("electron");
      const child = utilityProcess.fork(script, [], { env, stdio: "ignore", serviceName: "CC Desktop Local OCR", execArgv: ["--max-old-space-size=512"] });
      return {
        send: request => child.postMessage(request), kill: () => { child.kill(); },
        onMessage: callback => { child.on("message", callback); },
        onExit: callback => { child.on("exit", callback); },
        // UtilityProcess signals crashes through exit; Node fork also emits error.
        onError: () => {},
      };
    }
    const forkOptions: import("node:child_process").ForkOptions & { windowsHide: boolean } = {
      env, windowsHide: true, serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: ["--max-old-space-size=512"],
    };
    const child = fork(script, [], forkOptions);
    return {
      send: request => { child.send(request); }, kill: () => { child.kill(); },
      onMessage: callback => { child.on("message", message => callback(message as Reply)); },
      onExit: callback => { child.on("exit", callback); },
      onError: callback => { child.on("error", callback); },
    };
  }

  private async run(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    if (this.closed) throw new Error("本地 PDF/OCR 处理已停止。");
    signal?.throwIfAborted();
    clearTimeout(this.idle);
    if (!this.child) {
      const child = await this.spawn();
      if (this.closed) { child.kill(); throw new Error("本地 PDF/OCR 处理已停止。"); }
      if (signal?.aborted) { child.kill(); signal.throwIfAborted(); }
      this.child = child;
      child.onMessage(reply => {
        if (this.child !== child || reply.id !== this.active?.id) return;
        if (reply.type === "progress") this.active.progress();
        else if (reply.type === "result") {
          this.active.finish(reply.error || !reply.text ? new Error(reply.error || "PDF 未提取到文字。") : undefined, reply.text);
        }
      });
      const failed = () => {
        if (this.child !== child) return;
        this.child = undefined;
        this.active?.finish(new Error("本地 PDF/OCR 进程退出，请重试或拆分文件。"));
      };
      child.onExit(failed); child.onError(failed);
    }
    return new Promise<string>((resolve, reject) => {
      const id = ++this.nextId;
      let stalled: ReturnType<typeof setTimeout>;
      const total = setTimeout(() => finish(new Error("PDF/OCR 处理超过 5 分钟，请拆分文件后重试。")), this.options.timeoutMs ?? 300_000);
      const progress = () => {
        clearTimeout(stalled);
        stalled = setTimeout(() => finish(new Error("PDF 页面解析或 OCR 超时，请检查该文件或拆分后重试。")), this.options.stallMs ?? 45_000);
      };
      const finish = (error?: Error, text?: string) => {
        if (this.active?.id !== id) return;
        clearTimeout(stalled); clearTimeout(total);
        signal?.removeEventListener("abort", aborted);
        this.active = undefined;
        if (error) { this.stop(); reject(error); }
        else {
          this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 60_000);
          this.idle.unref();
          resolve(text!);
        }
      };
      const aborted = () => finish(new Error("本地 PDF/OCR 处理已取消。"));
      this.active = { id, finish, progress };
      signal?.addEventListener("abort", aborted, { once: true });
      progress();
      try { this.child!.send({ id, bytes }); }
      catch { finish(new Error("无法向本地 PDF/OCR 进程发送文档，请重试。")); }
    });
  }
}

/** One-shot helper for diagnostic tools; production reuses a PdfTextProcess instance. */
export async function extractPdfInWorker(bytes: Uint8Array): Promise<string> {
  const process = new PdfTextProcess();
  try { return await process.extract(bytes); } finally { process.dispose(); }
}
