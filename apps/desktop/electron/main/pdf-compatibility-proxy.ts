import http from "node:http";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { PdfTextProcess } from "./pdf-text-process";
export { extractPdfInWorker } from "./pdf-text-process";

type RecordValue = Record<string, unknown>;
type ExtractText = (bytes: Uint8Array) => Promise<string>;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 80 * 1024 * 1024;
const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

/** Only DeepSeek's text route needs this fallback. Native PDF providers retain their payload. */
export async function normalizePdfMessages(body: RecordValue, extract: ExtractText): Promise<boolean> {
  if (typeof body.model !== "string" || !/(?:^|[/:])deepseek(?:[-/]|$)/i.test(body.model)) return false;
  let changed = false;
  const visit = async (blocks: unknown): Promise<void> => {
    if (!Array.isArray(blocks)) return;
    for (let index = 0; index < blocks.length; index++) {
      const block = record(blocks[index]);
      if (!block) continue;
      if (block.type === "tool_result") await visit(block.content);
      const source = record(block.source);
      if (block.type !== "document" || source?.media_type !== "application/pdf") continue;
      if (source.type !== "base64" || typeof source.data !== "string") {
        throw new Error("当前模型需要本地 PDF 文件，请重新添加附件。");
      }
      const data = source.data;
      if (data.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) throw new Error("PDF 超过 10 MB，请拆分后重试。");
      if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("PDF 附件数据不完整，请重新添加。");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > MAX_PDF_BYTES) throw new Error("PDF 超过 10 MB，请拆分后重试。");
      const text = await extract(bytes);
      blocks[index] = { type: "text", text: (typeof block.title === "string" ? `附件：${block.title}\n` : "") + text };
      changed = true;
    }
  };
  if (Array.isArray(body.messages)) for (const message of body.messages) await visit(record(message)?.content);
  return changed;
}

/** Outbound boundary also covers resumed SDK transcripts containing old document blocks. */
export class PdfCompatibilityProxy {
  private readonly servers = new Map<string, Promise<{ url: string; server: http.Server }>>();
  private readonly cache = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly pdf = new PdfTextProcess();
  constructor(private readonly extract?: ExtractText) {}

  private text(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    const key = createHash("sha256").update(bytes).digest("hex");
    const pending = this.queue.then(async () => {
      if (this.disposed) throw new Error("PDF 处理已停止。");
      signal?.throwIfAborted();
      const cached = this.cache.get(key);
      if (cached) return cached;
      const result = await (this.extract ? this.extract(bytes) : this.pdf.extract(bytes, signal));
      if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
      if (!this.disposed) this.cache.set(key, result);
      return result;
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async environment(env: Record<string, string>): Promise<Record<string, string>> {
    const base = env.ANTHROPIC_BASE_URL;
    if (!base) return env;
    if (this.disposed) throw new Error("PDF compatibility proxy is closed");
    let pending = this.servers.get(base);
    if (!pending) {
      pending = this.start(base);
      this.servers.set(base, pending);
      void pending.catch(() => this.servers.delete(base));
    }
    return { ...env, ANTHROPIC_BASE_URL: (await pending).url };
  }

  dispose(): void {
    this.disposed = true;
    this.pdf.dispose();
    for (const pending of this.servers.values()) void pending.then(({ server }) => {
      server.closeAllConnections(); server.close();
    }, () => undefined);
    this.servers.clear();
    this.cache.clear();
  }

  private async start(base: string): Promise<{ url: string; server: http.Server }> {
    const upstream = new URL(base);
    if (!["http:", "https:"].includes(upstream.protocol)) throw new Error("Unsupported model endpoint protocol");
    const prefix = `/${randomUUID()}`;
    const server = http.createServer((req, res) => {
      void this.handle(req, res, upstream, prefix).catch(error => {
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: error instanceof Error ? error.message : "PDF 附件处理失败。" } }));
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("PDF compatibility proxy failed to bind");
    if (this.disposed) { server.close(); throw new Error("PDF compatibility proxy is closed"); }
    return { url: `http://127.0.0.1:${address.port}${prefix}`, server };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, upstream: URL, prefix: string): Promise<void> {
    if (!req.url?.startsWith(prefix + "/")) { res.writeHead(404); res.end(); return; }
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    const route = req.url.slice(prefix.length);
    const target = new URL(upstream);
    // Assign a path instead of resolving a URL: request paths cannot select a new host.
    const query = route.indexOf("?");
    target.pathname = upstream.pathname.replace(/\/$/, "") + (query < 0 ? route : route.slice(0, query));
    target.search = query < 0 ? "" : route.slice(query);
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
    for (const key of HOP_HEADERS) delete headers[key];
    let payload: Buffer | undefined;
    if (req.method === "POST" && /^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(route)) {
      if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new Error("Unsupported compressed model request");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_REQUEST_BYTES) throw new Error("会话附件总量过大，请拆分文件或新建会话。");
        chunks.push(bytes);
      }
      payload = Buffer.concat(chunks);
      let body: RecordValue | undefined;
      try { body = record(JSON.parse(payload.toString("utf8"))); } catch { throw new Error("Invalid model request JSON"); }
      if (body && await normalizePdfMessages(body, bytes => this.text(bytes, controller.signal))) payload = Buffer.from(JSON.stringify(body));
      headers["content-length"] = String(payload.length);
    }
    if (res.destroyed) return;
    await new Promise<void>((resolve) => {
      const outgoing = (target.protocol === "https:" ? https : http).request(target, { method: req.method, headers }, incoming => {
        const responseHeaders = { ...incoming.headers };
        for (const key of HOP_HEADERS) delete responseHeaders[key];
        res.writeHead(incoming.statusCode ?? 502, responseHeaders);
        incoming.on("error", () => { res.destroy(); resolve(); });
        incoming.on("end", resolve);
        incoming.pipe(res);
      });
      outgoing.on("error", () => {
        if (!res.destroyed && !res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "无法连接模型服务，请检查 CPA 状态。" } }));
        } else if (!res.writableEnded) res.destroy();
        resolve();
      });
      res.once("close", () => { outgoing.destroy(); resolve(); });
      req.once("aborted", () => outgoing.destroy());
      outgoing.setTimeout(300_000, () => outgoing.destroy());
      if (payload) outgoing.end(payload); else req.pipe(outgoing);
    });
  }
}
