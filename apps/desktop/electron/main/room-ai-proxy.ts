import http from "node:http";
import type { RoomAiHttpPayload } from "@claude-desktop/shared";

export const AI_HTTP_CHUNK = 48 * 1024;

export function bufferToChunks(
  buf: Buffer,
  size = AI_HTTP_CHUNK,
): string[] {
  if (!buf.length) return [];
  const out: string[] = [];
  for (let i = 0; i < buf.length; i += size) {
    out.push(buf.subarray(i, i + size).toString("base64"));
  }
  return out;
}

export function concatChunks(chunks: string[]): Buffer {
  return Buffer.concat(chunks.map((c) => Buffer.from(c, "base64")));
}

export function buildReqFrames(opts: {
  requestId: string;
  targetUserId: string;
  sourceUserId: string;
  method: string;
  path: string;
  body: Buffer;
}): RoomAiHttpPayload[] {
  const parts = bufferToChunks(opts.body);
  if (!parts.length) {
    return [
      {
        requestId: opts.requestId,
        targetUserId: opts.targetUserId,
        sourceUserId: opts.sourceUserId,
        dir: "req",
        seq: 0,
        last: true,
        method: opts.method,
        path: opts.path,
      },
    ];
  }
  return parts.map((data, i) => ({
    requestId: opts.requestId,
    targetUserId: opts.targetUserId,
    sourceUserId: opts.sourceUserId,
    dir: "req" as const,
    seq: i,
    last: i === parts.length - 1,
    ...(i === 0 ? { method: opts.method, path: opts.path } : {}),
    data,
  }));
}

export function buildResFrames(opts: {
  requestId: string;
  targetUserId: string;
  sourceUserId: string;
  status: number;
  body: Buffer;
}): RoomAiHttpPayload[] {
  const parts = bufferToChunks(opts.body);
  if (!parts.length) {
    return [
      {
        requestId: opts.requestId,
        targetUserId: opts.targetUserId,
        sourceUserId: opts.sourceUserId,
        dir: "res",
        seq: 0,
        last: true,
        status: opts.status,
      },
    ];
  }
  return parts.map((data, i) => ({
    requestId: opts.requestId,
    targetUserId: opts.targetUserId,
    sourceUserId: opts.sourceUserId,
    dir: "res" as const,
    seq: i,
    last: i === parts.length - 1,
    ...(i === 0 ? { status: opts.status } : {}),
    data,
  }));
}

export type LoopbackProxy = {
  port: number;
  close: () => void;
};

/** 本机环回 HTTP 代理：SDK 打进来后交给 onRequest。 */
export function parseBorrowToken(auth: string | undefined): string | null {
  const raw = (auth ?? "").replace(/^Bearer\s+/i, "").trim();
  const m = /^room-borrow:(.+)$/.exec(raw);
  return m?.[1] ?? null;
}

export function startLoopbackProxy(
  onRequest: (req: {
    method: string;
    path: string;
    body: Buffer;
    auth?: string;
  }) => Promise<{ status: number; body: Buffer }>,
): Promise<LoopbackProxy> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        chunks.push(c);
      });
      req.on("end", () => {
        const url = req.url ?? "/";
        void onRequest({
          method: (req.method ?? "POST").toUpperCase(),
          path: url,
          body: Buffer.concat(chunks),
          auth:
            typeof req.headers.authorization === "string"
              ? req.headers.authorization
              : undefined,
        })
          .then((out) => {
            res.statusCode = out.status;
            res.setHeader("content-type", "application/json");
            res.end(out.body);
          })
          .catch((err: unknown) => {
            res.statusCode = 502;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                error: { message: err instanceof Error ? err.message : String(err) },
              }),
            );
          });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("ai proxy failed to bind"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => {
          try {
            server.close();
          } catch {
            // ignore
          }
        },
      });
    });
    server.on("error", reject);
  });
}
