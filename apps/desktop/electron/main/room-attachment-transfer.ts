import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import {
  ROOM_ATTACHMENT_LIMITS,
  parseRoomAttachments,
  type RoomAttachmentRef,
  type RoomAttachmentRequest,
  type RoomAttachmentResponse,
} from "@claude-desktop/shared";

type Lifetime = { peer: string; active: boolean };
type Fetch = Lifetime & {
  ref: RoomAttachmentRef;
  buffer?: Buffer;
  offset: number;
  pending?: Pending;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (bytes: Buffer) => void;
  reject: (error: Error) => void;
};
type Pending = {
  transfer: Fetch;
  id: string;
  sent: boolean;
  offset: number;
  length: number;
  timer?: ReturnType<typeof setTimeout>;
};
type Serving = Lifetime & {
  reading: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
type Outbound = {
  type: "attachment.get" | "attachment.chunk";
  payload: RoomAttachmentRequest | RoomAttachmentResponse;
  owner?: Lifetime;
  beforeSend?: () => void;
  complete?: (error?: Error) => void;
};
type Pipeline = {
  peer: string;
  closed: boolean;
  pumping: boolean;
  queue: Outbound[];
  nextSendAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

const MAX_FETCHES = 2;
const MAX_SERVING = 2;
const MAX_PEER_QUEUE = 16;
const MAX_QUEUED = 64;
const MAX_PIPELINES = 64;

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => "value" in d);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Reflect.ownKeys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function requestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function parseReference(value: unknown): RoomAttachmentRef | null {
  if (!record(value) || !keys(value, ["id", "name", "size", "mimeType", "kind", "sha256"])) return null;
  return parseRoomAttachments([value])?.[0] ?? null;
}

function parseRequest(value: unknown): RoomAttachmentRequest | null {
  if (!record(value) || !keys(value, ["requestId", "attachment", "offset"]) || !requestId(value.requestId)) return null;
  const attachment = parseReference(value.attachment);
  const offset = value.offset;
  if (!attachment || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || (attachment.size === 0 ? offset !== 0 : offset >= attachment.size)) return null;
  return { requestId: value.requestId, attachment, offset };
}

/**
 * Bounds all attachment work routed through this instance. The caller supplies
 * opaque live connection keys, stops dispatching after disconnect, and uses a
 * new key on reconnect. Authorization and cache ownership belong to read().
 */
export class RoomAttachmentTransfer {
  private readonly pending = new Map<string, Pending>();
  private readonly fetches = new Set<Fetch>();
  private readonly serving = new Set<Serving>();
  private readonly pipelines = new Map<string, Pipeline>();
  private readonly timeoutMs: number;
  private readonly pacingMs: number;
  private queued = 0;
  private disposed = false;

  constructor(private readonly opts: {
    send: (peer: string, type: "attachment.get" | "attachment.chunk", payload: RoomAttachmentRequest | RoomAttachmentResponse) => boolean;
    read: (peer: string, ref: RoomAttachmentRef) => Promise<Buffer>;
    timeoutMs?: number;
    pacingMs?: number;
  }) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.pacingMs = opts.pacingMs ?? 60;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2 ** 31 - 1
      || !Number.isFinite(this.pacingMs) || this.pacingMs < 0 || this.pacingMs > 2 ** 31 - 1) {
      throw new Error("Invalid attachment timing configuration");
    }
  }

  fetch(peer: string, ref: RoomAttachmentRef, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new Error("Attachment transfer disposed"));
      const parsed = parseReference(ref);
      if (!parsed) return reject(new Error("Invalid attachment reference"));
      const abortError = () => Object.assign(new Error("Attachment fetch aborted"), { name: "AbortError" });
      if (signal?.aborted) return reject(abortError());
      if (this.fetches.size >= MAX_FETCHES) return reject(new Error("Attachment fetch busy"));
      const transfer: Fetch = {
        peer, ref: parsed, active: true, offset: 0, buffer: Buffer.alloc(parsed.size), signal, resolve, reject,
      };
      this.fetches.add(transfer);
      if (signal) {
        transfer.onAbort = () => this.finish(transfer, abortError());
        signal.addEventListener("abort", transfer.onAbort, { once: true });
      }
      this.requestChunk(transfer);
    });
  }

  private requestChunk(transfer: Fetch): void {
    if (!transfer.active) return;
    const pending: Pending = {
      transfer, id: randomUUID(), sent: false, offset: transfer.offset,
      length: Math.min(ROOM_ATTACHMENT_LIMITS.chunkBytes, transfer.ref.size - transfer.offset),
    };
    transfer.pending = pending;
    this.pending.set(pending.id, pending);
    // This is a per-chunk budget, including time spent waiting in the send queue.
    pending.timer = setTimeout(() => this.finish(transfer, new Error("Attachment chunk timed out")), this.timeoutMs);
    pending.timer.unref();
    const accepted = this.enqueue(transfer.peer, {
      type: "attachment.get",
      payload: { requestId: pending.id, attachment: { ...transfer.ref }, offset: pending.offset },
      owner: transfer,
      beforeSend: () => { pending.sent = true; },
      complete: error => { if (error) this.finish(transfer, error); },
    });
    if (!accepted) this.finish(transfer, new Error("Attachment send queue busy"));
  }

  handle(peer: string, type: "attachment.get" | "attachment.chunk", payload: unknown): void {
    if (this.disposed) return;
    if (type === "attachment.get") {
      const request = parseRequest(payload);
      if (!request) return;
      if (this.serving.size >= MAX_SERVING) {
        // Busy errors use the same bounded, paced queue. If that queue is full,
        // drop the error; the requester has a chunk timeout, never a retry queue.
        this.enqueue(peer, {
          type: "attachment.chunk",
          payload: { requestId: request.requestId, offset: request.offset, error: "Attachment serving busy" },
        });
        return;
      }
      const job: Serving = { peer, active: true, reading: true };
      this.serving.add(job);
      job.timer = setTimeout(() => this.stopServing(job), this.timeoutMs);
      job.timer.unref();
      void this.serve(job, request);
      return;
    }
    if (type !== "attachment.chunk" || !record(payload) || !requestId(payload.requestId)) return;
    const pending = this.pending.get(payload.requestId);
    if (!pending || !pending.sent || pending.transfer.peer !== peer) return;
    const transfer = pending.transfer;
    if (payload.offset !== pending.offset || !Number.isSafeInteger(payload.offset)) {
      this.finish(transfer, new Error("Invalid attachment chunk offset"));
    } else if (keys(payload, ["requestId", "offset", "error"])
      && typeof payload.error === "string" && payload.error.length > 0 && payload.error.length <= 512) {
      this.finish(transfer, new Error(`Attachment peer error: ${payload.error}`));
    } else if (!keys(payload, ["requestId", "offset", "data"]) || typeof payload.data !== "string"
      || payload.data.length !== Math.ceil(pending.length / 3) * 4) {
      this.finish(transfer, new Error("Invalid attachment chunk length or data"));
    } else {
      const bytes = Buffer.from(payload.data, "base64");
      if (bytes.length !== pending.length || bytes.toString("base64") !== payload.data) {
        this.finish(transfer, new Error("Invalid attachment chunk base64"));
      } else {
        this.clearPending(transfer);
        bytes.copy(transfer.buffer!, transfer.offset);
        transfer.offset += bytes.length;
        if (transfer.offset === transfer.ref.size) {
          if (createHash("sha256").update(transfer.buffer!).digest("hex") !== transfer.ref.sha256) {
            this.finish(transfer, new Error("Attachment SHA256 mismatch"));
          } else {
            this.finish(transfer);
          }
        } else {
          this.requestChunk(transfer);
        }
      }
    }
  }

  private clearPending(transfer: Fetch): void {
    if (!transfer.pending) return;
    clearTimeout(transfer.pending.timer);
    this.pending.delete(transfer.pending.id);
    transfer.pending = undefined;
  }

  private finish(transfer: Fetch, error?: Error): void {
    if (!transfer.active) return;
    transfer.active = false;
    this.clearPending(transfer);
    this.removeOutput(transfer);
    if (transfer.signal && transfer.onAbort) transfer.signal.removeEventListener("abort", transfer.onAbort);
    transfer.signal = undefined;
    transfer.onAbort = undefined;
    this.fetches.delete(transfer);
    const bytes = transfer.buffer!;
    transfer.buffer = undefined;
    if (error) transfer.reject(error);
    else transfer.resolve(bytes);
  }

  // Return only the encoded chunk. No full cache Buffer enters a paced closure
  // or survives in a per-request cache; each pull authorizes and reads afresh.
  private async readChunk(peer: string, request: RoomAttachmentRequest): Promise<RoomAttachmentResponse> {
    try {
      const bytes = await this.opts.read(peer, { ...request.attachment });
      if (!Buffer.isBuffer(bytes) || bytes.length !== request.attachment.size || bytes.length > ROOM_ATTACHMENT_LIMITS.fileBytes) {
        throw new Error("Invalid cache buffer size");
      }
      return {
        requestId: request.requestId,
        offset: request.offset,
        data: bytes.subarray(request.offset, request.offset + ROOM_ATTACHMENT_LIMITS.chunkBytes).toString("base64"),
      };
    } catch {
      return { requestId: request.requestId, offset: request.offset, error: "Attachment read failed" };
    }
  }

  private async serve(job: Serving, request: RoomAttachmentRequest): Promise<void> {
    const response = await this.readChunk(job.peer, request);
    job.reading = false;
    if (!job.active) {
      this.serving.delete(job);
      return;
    }
    if (!this.enqueue(job.peer, {
      type: "attachment.chunk", payload: response, owner: job,
      // send() may synchronously deliver the next pull. The completed read must
      // free its slot first, so two legitimate sequential fetches stay usable.
      beforeSend: () => this.stopServing(job),
    })) this.stopServing(job);
  }

  private stopServing(job: Serving): void {
    job.active = false;
    clearTimeout(job.timer);
    job.timer = undefined;
    this.removeOutput(job);
    // read() has no cancellation API. A disconnected/timed-out read still
    // occupies its slot until the actual Promise settles.
    if (!job.reading) this.serving.delete(job);
  }

  private enqueue(peer: string, message: Outbound): boolean {
    if (this.disposed || (message.owner && !message.owner.active) || this.queued >= MAX_QUEUED) return false;
    let pipeline = this.pipelines.get(peer);
    if (!pipeline) {
      if (this.pipelines.size >= MAX_PIPELINES) return false;
      pipeline = { peer, closed: false, pumping: false, queue: [], nextSendAt: 0 };
      this.pipelines.set(peer, pipeline);
    }
    if (pipeline.queue.length >= MAX_PEER_QUEUE) return false;
    pipeline.queue.push(message);
    this.queued++;
    this.pump(pipeline);
    return true;
  }

  private pump(pipeline: Pipeline): void {
    if (pipeline.closed || pipeline.pumping || pipeline.timer || this.disposed) return;
    const delay = pipeline.nextSendAt - Date.now();
    if (delay > 0) {
      pipeline.timer = setTimeout(() => {
        pipeline.timer = undefined;
        this.pump(pipeline);
      }, delay);
      pipeline.timer.unref();
      return;
    }
    const message = pipeline.queue.shift();
    if (!message) {
      // Keep the last-send timestamp only through its cooldown. No disconnected
      // peer tombstones or permanently retained idle connection keys.
      if (this.pipelines.get(pipeline.peer) === pipeline) this.pipelines.delete(pipeline.peer);
      return;
    }
    this.queued--;
    pipeline.pumping = true;
    pipeline.nextSendAt = Date.now() + this.pacingMs;
    let error: Error | undefined;
    try {
      message.beforeSend?.();
      if (!this.opts.send(pipeline.peer, message.type, message.payload)) error = new Error("Attachment send failed");
    } catch {
      error = new Error("Attachment send failed");
    }
    message.complete?.(error);
    pipeline.pumping = false;
    this.pump(pipeline);
  }

  private removeOutput(owner: Lifetime): void {
    for (const pipeline of this.pipelines.values()) {
      const kept = pipeline.queue.filter(message => message.owner !== owner);
      this.queued -= pipeline.queue.length - kept.length;
      pipeline.queue = kept;
    }
  }

  disconnect(peer: string): void {
    const pipeline = this.pipelines.get(peer);
    if (pipeline) {
      pipeline.closed = true;
      clearTimeout(pipeline.timer);
      this.queued -= pipeline.queue.length;
      pipeline.queue.length = 0;
      this.pipelines.delete(peer);
    }
    for (const transfer of this.fetches) {
      if (transfer.peer === peer) this.finish(transfer, new Error("Attachment peer disconnected"));
    }
    for (const job of this.serving) {
      if (job.peer === peer) this.stopServing(job);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pipeline of this.pipelines.values()) {
      pipeline.closed = true;
      clearTimeout(pipeline.timer);
      pipeline.queue.length = 0;
    }
    this.pipelines.clear();
    this.queued = 0;
    for (const transfer of this.fetches) this.finish(transfer, new Error("Attachment transfer disposed"));
    for (const job of this.serving) this.stopServing(job);
  }
}
