import { createHash, randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROOM_ATTACHMENT_LIMITS,
  type RoomAttachmentRef,
  type RoomAttachmentRequest,
  type RoomAttachmentResponse,
} from "@claude-desktop/shared";
import { RoomAttachmentTransfer } from "./room-attachment-transfer";

type Options = ConstructorParameters<typeof RoomAttachmentTransfer>[0];
type Frame = {
  from: "left" | "right";
  peer: string;
  type: "attachment.get" | "attachment.chunk";
  payload: RoomAttachmentRequest | RoomAttachmentResponse;
  time: number;
};

const LEFT = "user:left/socket:1";
const RIGHT = "user:right/socket:1";
const transports: RoomAttachmentTransfer[] = [];

function reference(bytes: Buffer): RoomAttachmentRef {
  return {
    id: randomUUID(),
    name: "bytes.bin",
    size: bytes.length,
    mimeType: "application/octet-stream",
    kind: "binary",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function transport(opts: Options): RoomAttachmentTransfer {
  const result = new RoomAttachmentTransfer(opts);
  transports.push(result);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function request(ref: RoomAttachmentRef, offset = 0): RoomAttachmentRequest {
  return { requestId: randomUUID(), attachment: ref, offset };
}

// Only the wire/cache callbacks are substitutes: both endpoints run the real class.
function wiredPair(
  rightBytes: Buffer,
  options: { leftBytes?: Buffer; pacingMs?: number; timeoutMs?: number } = {},
  intercept?: (frame: Frame, deliver: () => void) => boolean,
) {
  const frames: Frame[] = [];
  const reads: Array<{ side: "left" | "right"; peer: string; ref: RoomAttachmentRef }> = [];
  let left: RoomAttachmentTransfer;
  let right: RoomAttachmentTransfer;
  function send(from: "left" | "right"): Options["send"] {
    return (peer, type, payload) => {
      const frame = { from, peer, type, payload, time: Date.now() };
      frames.push(frame);
      const deliver = () => (from === "left" ? right : left).handle(
        from === "left" ? LEFT : RIGHT, type, payload,
      );
      if (intercept) return intercept(frame, deliver);
      deliver();
      return true;
    };
  }
  const timings = { pacingMs: options.pacingMs ?? 0, timeoutMs: options.timeoutMs ?? 1_000 };
  left = transport({
    ...timings,
    send: send("left"),
    read: async (peer, ref) => {
      reads.push({ side: "left", peer, ref });
      return options.leftBytes ?? rightBytes;
    },
  });
  right = transport({
    ...timings,
    send: send("right"),
    read: async (peer, ref) => {
      reads.push({ side: "right", peer, ref });
      return rightBytes;
    },
  });
  return { left, right, frames, reads };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => {
  for (const instance of transports.splice(0)) instance.dispose();
  vi.useRealTimers();
});

describe("RoomAttachmentTransfer", () => {
  it("pulls exact sequential chunks between real endpoints using fresh random IDs", async () => {
    const bytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.chunkBytes * 2 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const ref = reference(bytes);
    const { left, frames, reads } = wiredPair(bytes);
    const result = expect(left.fetch(RIGHT, ref)).resolves.toEqual(bytes);
    await Promise.all([result, vi.runAllTimersAsync()]);

    expect(frames.map(frame => frame.type)).toEqual([
      "attachment.get", "attachment.chunk",
      "attachment.get", "attachment.chunk",
      "attachment.get", "attachment.chunk",
    ]);
    const requests = frames.filter(frame => frame.type === "attachment.get")
      .map(frame => frame.payload as RoomAttachmentRequest);
    expect(requests.map(request => request.offset)).toEqual([0, 49_152, 98_304]);
    expect(new Set(requests.map(request => request.requestId)).size).toBe(3);
    for (const request of requests) {
      expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.attachment).toEqual(ref);
    }
    const chunks = frames.filter(frame => frame.type === "attachment.chunk")
      .map(frame => Buffer.from((frame.payload as RoomAttachmentResponse).data!, "base64"));
    expect(chunks.map(chunk => chunk.length)).toEqual([49_152, 49_152, 17]);
    expect(reads).toEqual(requests.map(() => ({ side: "right", peer: LEFT, ref })));
  });

  it("exchanges one empty response for a zero byte file", async () => {
    const bytes = Buffer.alloc(0);
    const { left, frames } = wiredPair(bytes);
    const result = expect(left.fetch(RIGHT, reference(bytes))).resolves.toEqual(bytes);
    await Promise.all([result, vi.runAllTimersAsync()]);
    expect(frames).toHaveLength(2);
    expect(frames[1].payload).toMatchObject({ offset: 0, data: "" });
  });

  it("rejects bytes whose SHA256 differs from the reference", async () => {
    const bytes = Buffer.from("actual cache bytes");
    const { left } = wiredPair(bytes);
    const ref = { ...reference(bytes), sha256: "0".repeat(64) };
    const result = expect(left.fetch(RIGHT, ref)).rejects.toThrow(/sha256|hash/i);
    await Promise.all([result, vi.runAllTimersAsync()]);
  });

  it.each([
    ["null", () => null],
    ["array", () => []],
    ["missing fields", () => ({})],
    ["extra property", (r: RoomAttachmentRequest) => ({ ...r, path: "/private" })],
    ["empty ID", (r: RoomAttachmentRequest) => ({ ...r, requestId: "" })],
    ["oversized ID", (r: RoomAttachmentRequest) => ({ ...r, requestId: "x".repeat(129) })],
    ["non-string ID", (r: RoomAttachmentRequest) => ({ ...r, requestId: 7 })],
    ["negative offset", (r: RoomAttachmentRequest) => ({ ...r, offset: -1 })],
    ["fractional offset", (r: RoomAttachmentRequest) => ({ ...r, offset: 0.5 })],
    ["NaN offset", (r: RoomAttachmentRequest) => ({ ...r, offset: NaN })],
    ["infinite offset", (r: RoomAttachmentRequest) => ({ ...r, offset: Infinity })],
    ["string offset", (r: RoomAttachmentRequest) => ({ ...r, offset: "0" })],
    ["EOF offset", (r: RoomAttachmentRequest) => ({ ...r, offset: r.attachment.size })],
    ["past EOF", (r: RoomAttachmentRequest) => ({ ...r, offset: r.attachment.size + 1 })],
    ["missing metadata", (r: RoomAttachmentRequest) => ({ ...r, attachment: null })],
    ["invalid attachment ID", (r: RoomAttachmentRequest) => ({ ...r, attachment: { ...r.attachment, id: "../secret" } })],
    ["path in metadata", (r: RoomAttachmentRequest) => ({ ...r, attachment: { ...r.attachment, path: "/private" } })],
    ["invalid filename", (r: RoomAttachmentRequest) => ({ ...r, attachment: { ...r.attachment, name: "../secret" } })],
    ["oversized file", (r: RoomAttachmentRequest) => ({ ...r, attachment: { ...r.attachment, size: ROOM_ATTACHMENT_LIMITS.fileBytes + 1 } })],
    ["negative size", (r: RoomAttachmentRequest) => ({ ...r, attachment: { ...r.attachment, size: -1 } })],
    ["fractional size", (r: RoomAttachmentRequest) => ({ ...r, attachment: { ...r.attachment, size: 0.5 } })],
    ["invalid hash", (r: RoomAttachmentRequest) => ({ ...r, attachment: { ...r.attachment, sha256: "Z".repeat(64) } })],
    ["invalid kind", (r: RoomAttachmentRequest) => ({ ...r, attachment: { ...r.attachment, kind: "file" } })],
    ["invalid MIME", (r: RoomAttachmentRequest) => ({ ...r, attachment: { ...r.attachment, mimeType: "bad" } })],
  ])("ignores malicious request: %s", async (_name, corrupt) => {
    const bytes = Buffer.from("f");
    const { right, reads, frames } = wiredPair(bytes);
    expect(() => right.handle(LEFT, "attachment.get", corrupt(request(reference(bytes))))).not.toThrow();
    expect(reads).toHaveLength(0);
    await vi.runAllTimersAsync();
    expect(frames).toHaveLength(0);
  });

  it.each([-1, ROOM_ATTACHMENT_LIMITS.fileBytes + 1, 0.5, NaN, Infinity])("rejects invalid local size %s before sending or allocating a fetch", async size => {
    const { left, frames } = wiredPair(Buffer.from("f"));
    const ref = { ...reference(Buffer.from("f")), size };
    const result = left.fetch(RIGHT, ref).catch(error => error);
    expect(frames).toHaveLength(0);
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringMatching(/invalid/i) }));
  });

  it.each([
    ["wrong offset", (r: RoomAttachmentResponse) => ({ ...r, offset: r.offset + 1 })],
    ["negative offset", (r: RoomAttachmentResponse) => ({ ...r, offset: -1 })],
    ["missing offset", (r: RoomAttachmentResponse) => ({ requestId: r.requestId, data: r.data })],
    ["empty nonempty chunk", (r: RoomAttachmentResponse) => ({ ...r, data: "" })],
    ["truncated chunk", (r: RoomAttachmentResponse) => ({ ...r, data: "Zm9v" })],
    ["oversized chunk", (r: RoomAttachmentResponse) => ({ ...r, data: "A".repeat(65_540) })],
    ["noncanonical padding bits", (r: RoomAttachmentResponse) => ({ ...r, data: "Zm9vZh==" })],
    ["missing padding", (r: RoomAttachmentResponse) => ({ ...r, data: "Zm9vZg" })],
    ["whitespace", (r: RoomAttachmentResponse) => ({ ...r, data: "Zm9vZg==\n" })],
    ["URL alphabet", (r: RoomAttachmentResponse) => ({ ...r, data: "____Zg==" })],
    ["non-string data", (r: RoomAttachmentResponse) => ({ ...r, data: 42 })],
    ["missing data", (r: RoomAttachmentResponse) => ({ requestId: r.requestId, offset: 0 })],
    ["extra property", (r: RoomAttachmentResponse) => ({ ...r, extra: true })],
    ["data and error", (r: RoomAttachmentResponse) => ({ ...r, error: "denied" })],
    ["empty error", (r: RoomAttachmentResponse) => ({ requestId: r.requestId, offset: 0, error: "" })],
    ["oversized error", (r: RoomAttachmentResponse) => ({ requestId: r.requestId, offset: 0, error: "x".repeat(513) })],
  ])("rejects malformed matching response: %s", async (_name, corrupt) => {
    const bytes = Buffer.from("foof");
    const sent: RoomAttachmentRequest[] = [];
    const client = transport({ pacingMs: 0, read: async () => bytes, send: (_peer, type, payload) => {
      if (type === "attachment.get") sent.push(payload as RoomAttachmentRequest);
      return true;
    } });
    let settled: Buffer | Error | undefined;
    const done = client.fetch(RIGHT, reference(bytes)).then(value => { settled = value; }, error => { settled = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    const response = { requestId: sent[0].requestId, offset: 0, data: bytes.toString("base64") };
    expect(() => client.handle(RIGHT, "attachment.chunk", corrupt(response))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeInstanceOf(Error);
    expect(sent).toHaveLength(1);
    await done;
  });

  it("ignores unsolicited IDs and a different connection belonging to the same user", async () => {
    const bytes = Buffer.from("foof");
    const { left, frames } = wiredPair(bytes, {}, (frame, deliver) => {
      if (frame.type === "attachment.chunk") {
        const payload = frame.payload as RoomAttachmentResponse;
        left.handle("user:right/socket:2", "attachment.chunk", { ...payload, error: "forged", data: undefined });
        left.handle(RIGHT, "attachment.chunk", { ...payload, requestId: randomUUID(), data: "!" });
        for (const junk of [null, [], {}, "data", { requestId: 123 }]) {
          expect(() => left.handle(RIGHT, "attachment.chunk", junk)).not.toThrow();
        }
      }
      deliver();
      return true;
    });
    await Promise.all([expect(left.fetch(RIGHT, reference(bytes))).resolves.toEqual(bytes), vi.runAllTimersAsync()]);
    for (let i = 0; i < 100; i++) left.handle(`unsolicited:${i}`, "attachment.chunk", { requestId: randomUUID(), offset: 0, data: "!" });
    await vi.runAllTimersAsync();
    expect(frames).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports read/authorization failure without sending cache contents or private errors", async () => {
    const bytes = Buffer.from("foof");
    const responses: RoomAttachmentResponse[] = [];
    const server = transport({
      pacingMs: 0,
      read: async () => { throw new Error("secret /private/cache/path"); },
      send: (_peer, _type, payload) => { responses.push(payload as RoomAttachmentResponse); return true; },
    });
    const req = request(reference(bytes));
    server.handle(LEFT, "attachment.get", req);
    await vi.runAllTimersAsync();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ requestId: req.requestId, offset: 0, error: expect.stringMatching(/read|unavailable|denied/i) });
    expect(responses[0].data).toBeUndefined();
    expect(responses[0].error).not.toMatch(/secret|private/);
  });

  it.each([Buffer.from("foo"), Buffer.from("foofx"), Buffer.alloc(ROOM_ATTACHMENT_LIMITS.fileBytes + 1), "foof"])(
    "refuses cache bytes inconsistent with the reference (case %#)", async actual => {
      const responses: RoomAttachmentResponse[] = [];
      const server = transport({ pacingMs: 0, read: async () => actual as Buffer, send: (_peer, _type, payload) => {
        responses.push(payload as RoomAttachmentResponse);
        return true;
      } });
      server.handle(LEFT, "attachment.get", request(reference(Buffer.from("foof"))));
      await vi.runAllTimersAsync();
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toMatch(/size|buffer|read|invalid/i);
      expect(responses[0].data).toBeUndefined();
    },
  );

  it("rejects a third global fetch as busy and frees capacity on abort", async () => {
    const bytes = Buffer.from("f");
    const sent: string[] = [];
    const client = transport({ pacingMs: 0, send: peer => { sent.push(peer); return true; }, read: async () => bytes });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = client.fetch("socket:1", reference(bytes), firstAbort.signal).catch(error => error);
    const second = client.fetch("socket:2", reference(bytes), secondAbort.signal).catch(error => error);
    let excess: unknown;
    void client.fetch("socket:3", reference(bytes)).catch(error => { excess = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(excess).toEqual(expect.objectContaining({ message: expect.stringMatching(/busy/i) }));
    expect(sent).toHaveLength(2);
    firstAbort.abort();
    expect(await first).toMatchObject({ name: "AbortError" });
    const thirdAbort = new AbortController();
    const third = client.fetch("socket:3", reference(bytes), thirdAbort.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(3);
    secondAbort.abort();
    thirdAbort.abort();
    await Promise.all([second, third]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts at most two incoming reads globally and replies busy to excess", async () => {
    const bytes = Buffer.from("f");
    const waiting = [deferred<Buffer>(), deferred<Buffer>()];
    let reads = 0;
    const responses: RoomAttachmentResponse[] = [];
    const server = transport({ pacingMs: 0, read: () => waiting[reads++ % 2].promise, send: (_peer, _type, payload) => {
      responses.push(payload as RoomAttachmentResponse);
      return true;
    } });
    for (let i = 0; i < 5; i++) server.handle(`socket:${i}`, "attachment.get", request(reference(bytes)));
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(responses).toHaveLength(3);
    expect(responses.every(response => /busy/i.test(response.error ?? ""))).toBe(true);
    waiting.forEach(read => read.resolve(bytes));
    await vi.runAllTimersAsync();
    expect(responses.filter(response => response.data)).toHaveLength(2);
    server.handle("socket:5", "attachment.get", request(reference(bytes)));
    await vi.runAllTimersAsync();
    expect(reads).toBe(3);
  });

  it("times out a missing chunk, clears its listener, and ignores its late reply", async () => {
    const bytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.chunkBytes + 1, 3);
    const requests: RoomAttachmentRequest[] = [];
    const client = transport({ timeoutMs: 25, pacingMs: 0, read: async () => bytes, send: (_peer, _type, payload) => {
      requests.push(payload as RoomAttachmentRequest);
      return true;
    } });
    const abort = new AbortController();
    let result: unknown;
    const done = client.fetch(RIGHT, reference(bytes), abort.signal).catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(25);
    expect(result).toEqual(expect.objectContaining({ message: expect.stringMatching(/timed out|timeout/i) }));
    await done;
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    client.handle(RIGHT, "attachment.chunk", { requestId: requests[0].requestId, offset: 0, data: bytes.subarray(0, 49_152).toString("base64") });
    await vi.runAllTimersAsync();
    expect(requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send or attach a listener for an already aborted signal", async () => {
    const bytes = Buffer.from("f");
    const { left, frames } = wiredPair(bytes);
    const abort = new AbortController();
    abort.abort("caller cancelled");
    const result = left.fetch(RIGHT, reference(bytes), abort.signal).catch(error => error);
    expect(frames).toHaveLength(0);
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an active fetch and ignores data from a read that finishes later", async () => {
    const bytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.chunkBytes + 1, 1);
    let reply: (() => void) | undefined;
    const { left, frames } = wiredPair(bytes, {}, (frame, deliver) => {
      if (frame.type === "attachment.chunk") reply = deliver;
      else deliver();
      return true;
    });
    const abort = new AbortController();
    let result: unknown;
    const done = left.fetch(RIGHT, reference(bytes), abort.signal).catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(1);
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toMatchObject({ name: "AbortError" });
    await done;
    reply!();
    await vi.runAllTimersAsync();
    expect(frames).toHaveLength(2);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  });

  it("disconnects only fetches belonging to the exact connection key", async () => {
    const bytes = Buffer.from("f");
    const requests: Array<{ peer: string; payload: RoomAttachmentRequest }> = [];
    const client = transport({ pacingMs: 0, read: async () => bytes, send: (peer, _type, payload) => {
      requests.push({ peer, payload: payload as RoomAttachmentRequest }); return true;
    } });
    let disconnected: unknown;
    const first = client.fetch(RIGHT, reference(bytes)).catch(error => { disconnected = error; });
    const otherPeer = "user:right/socket:2";
    const second = client.fetch(otherPeer, reference(bytes));
    await vi.advanceTimersByTimeAsync(0);
    client.disconnect(RIGHT);
    await vi.advanceTimersByTimeAsync(0);
    expect(disconnected).toEqual(expect.objectContaining({ message: expect.stringMatching(/disconnect/i) }));
    for (const { peer, payload } of requests) client.handle(peer, "attachment.chunk", { requestId: payload.requestId, offset: 0, data: "Zg==" });
    await Promise.all([first, expect(second).resolves.toEqual(bytes), vi.runAllTimersAsync()]);
    expect(requests).toHaveLength(2);
  });

  it("keeps disconnected unresolved reads counted until they actually finish", async () => {
    const bytes = Buffer.from("f");
    const waiting = [deferred<Buffer>(), deferred<Buffer>()];
    const sent: Array<{ peer: string; payload: RoomAttachmentResponse }> = [];
    let reads = 0;
    const server = transport({ pacingMs: 0, read: () => waiting[reads++ % 2].promise, send: (peer, _type, payload) => {
      sent.push({ peer, payload: payload as RoomAttachmentResponse }); return true;
    } });
    server.handle(LEFT, "attachment.get", request(reference(bytes)));
    server.handle(RIGHT, "attachment.get", request(reference(bytes)));
    server.disconnect(LEFT);
    server.handle("new socket", "attachment.get", request(reference(bytes)));
    expect(reads).toBe(2);
    waiting.forEach(read => read.resolve(bytes));
    await vi.runAllTimersAsync();
    expect(sent.some(frame => frame.peer === LEFT)).toBe(false);
    expect(sent.find(frame => frame.peer === "new socket")?.payload.error).toMatch(/busy/i);
    expect(sent.find(frame => frame.peer === RIGHT)?.payload.data).toBe("Zg==");
  });

  it("disposes pending fetches and suppresses unresolved reads and all new work", async () => {
    const bytes = Buffer.from("f");
    const waiting = deferred<Buffer>();
    const sent: unknown[] = [];
    const instance = transport({ pacingMs: 0, read: () => waiting.promise, send: (_peer, _type, payload) => { sent.push(payload); return true; } });
    let result: unknown;
    const done = instance.fetch(RIGHT, reference(bytes)).catch(error => { result = error; });
    instance.handle(LEFT, "attachment.get", request(reference(bytes)));
    await vi.advanceTimersByTimeAsync(0);
    instance.dispose();
    instance.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(expect.objectContaining({ message: expect.stringMatching(/disposed/i) }));
    await done;
    await expect(instance.fetch("new", reference(bytes))).rejects.toThrow(/disposed/i);
    instance.handle("new", "attachment.get", request(reference(bytes)));
    waiting.resolve(bytes);
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, "throw"])("fails a fetch promptly when send returns %s", async failure => {
    const bytes = Buffer.from("f");
    const instance = transport({ pacingMs: 0, read: async () => bytes, send: () => {
      if (failure === "throw") throw new Error("socket failure");
      return false;
    } });
    let result: unknown;
    void instance.fetch(RIGHT, reference(bytes)).catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(expect.objectContaining({ message: expect.stringMatching(/send/i) }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("paces requests and replies together per peer at 60ms by default", async () => {
    const bytes = Buffer.from("f");
    const frames: Array<{ type: string; time: number }> = [];
    const instance = transport({ timeoutMs: 1_000, read: async () => bytes, send: (peer, type, payload) => {
      frames.push({ type, time: Date.now() });
      if (type === "attachment.get") instance.handle(peer, "attachment.chunk", { requestId: payload.requestId, offset: 0, data: "Zg==" });
      return true;
    } });
    const first = instance.fetch(RIGHT, reference(bytes));
    const second = instance.fetch(RIGHT, reference(bytes));
    instance.handle(RIGHT, "attachment.get", request(reference(bytes)));
    instance.handle(RIGHT, "attachment.get", request(reference(bytes)));
    await vi.advanceTimersByTimeAsync(59);
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(121);
    expect(frames.map(frame => frame.type)).toEqual(["attachment.get", "attachment.get", "attachment.chunk", "attachment.chunk"]);
    expect(frames.map(frame => frame.time)).toEqual([1_000, 1_060, 1_120, 1_180]);
    await Promise.all([expect(first).resolves.toEqual(bytes), expect(second).resolves.toEqual(bytes), vi.runAllTimersAsync()]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a peer's outbound queue at 16 and fails a fetch when it is full", async () => {
    const bytes = Buffer.from("f");
    const waiting = deferred<Buffer>();
    const sent: RoomAttachmentResponse[] = [];
    let reads = 0;
    const instance = transport({ timeoutMs: 10_000, read: () => { reads++; return waiting.promise; }, send: (_peer, _type, payload) => {
      sent.push(payload as RoomAttachmentResponse); return true;
    } });
    for (let i = 0; i < 200; i++) instance.handle(RIGHT, "attachment.get", request(reference(bytes)));
    let result: unknown;
    void instance.fetch(RIGHT, reference(bytes)).catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual(expect.objectContaining({ message: expect.stringMatching(/busy/i) }));
    expect(reads).toBe(2);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_020);
    expect(sent).toHaveLength(17);
    expect(sent.every(response => /busy/i.test(response.error ?? ""))).toBe(true);
    instance.disconnect(RIGHT);
    waiting.resolve(bytes);
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(17);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops aborted queued requests and disconnected queued replies before sending", async () => {
    const bytes = Buffer.from("f");
    const frames: Array<{ peer: string; type: string }> = [];
    const instance = transport({ timeoutMs: 1_000, read: async () => bytes, send: (peer, type, payload) => {
      frames.push({ peer, type });
      if (type === "attachment.get") instance.handle(peer, "attachment.chunk", { requestId: payload.requestId, offset: 0, data: "Zg==" });
      return true;
    } });
    await instance.fetch(RIGHT, reference(bytes));
    const abort = new AbortController();
    const cancelled = instance.fetch(RIGHT, reference(bytes), abort.signal).catch(error => error);
    instance.handle(RIGHT, "attachment.get", request(reference(bytes)));
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    instance.disconnect(RIGHT);
    await vi.runAllTimersAsync();
    expect(await cancelled).toMatchObject({ name: "AbortError" });
    expect(frames).toEqual([{ peer: RIGHT, type: "attachment.get" }]);
    await Promise.all([expect(instance.fetch(LEFT, reference(bytes))).resolves.toEqual(bytes), vi.runAllTimersAsync()]);
    expect(frames.at(-1)?.peer).toBe(LEFT);
  });

  it("expires stalled serving reads without letting late completion send a response", async () => {
    const bytes = Buffer.from("f");
    const waiting = deferred<Buffer>();
    let reads = 0;
    const sent: RoomAttachmentResponse[] = [];
    const instance = transport({ pacingMs: 0, timeoutMs: 20, read: () => { reads++; return waiting.promise; }, send: (_peer, _type, payload) => {
      sent.push(payload as RoomAttachmentResponse); return true;
    } });
    instance.handle(LEFT, "attachment.get", request(reference(bytes)));
    instance.handle(RIGHT, "attachment.get", request(reference(bytes)));
    await vi.advanceTimersByTimeAsync(20);
    instance.handle("new", "attachment.get", request(reference(bytes)));
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    const sentBeforeRead = sent.length;
    expect(sent.at(-1)?.error).toMatch(/busy/i);
    waiting.resolve(bytes);
    await vi.runAllTimersAsync();
    expect(sent).toHaveLength(sentBeforeRead);
    instance.handle("new", "attachment.get", request(reference(bytes)));
    await vi.runAllTimersAsync();
    expect(reads).toBe(3);
    expect(sent.at(-1)?.data).toBe("Zg==");
  });

  it("supports two simultaneous multi-chunk fetches in both directions with synchronous wires", async () => {
    const rightBytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.chunkBytes * 2 + 3, 19);
    const leftBytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.chunkBytes + 7, 23);
    const { left, right, frames } = wiredPair(rightBytes, { leftBytes });
    const results = Promise.all([
      left.fetch(RIGHT, reference(rightBytes)), left.fetch(RIGHT, reference(rightBytes)),
      right.fetch(LEFT, reference(leftBytes)), right.fetch(LEFT, reference(leftBytes)),
    ]);
    await Promise.all([
      expect(results).resolves.toEqual([rightBytes, rightBytes, leftBytes, leftBytes]),
      vi.runAllTimersAsync(),
    ]);
    expect(frames.some(frame => (frame.payload as RoomAttachmentResponse).error)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { pacingMs: NaN }, { pacingMs: Infinity }, { pacingMs: -1 }, { pacingMs: 2 ** 31 },
    { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: -1 }, { timeoutMs: 0 }, { timeoutMs: 2 ** 31 },
  ])("rejects invalid timing configuration %#", timing => {
    expect(() => transport({ ...timing, read: async () => Buffer.alloc(0), send: () => true })).toThrow(/invalid/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains hostile object access without authorizing a read or sending a frame", () => {
    const bytes = Buffer.from("f");
    const { right, reads, frames } = wiredPair(bytes);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const getter = { get requestId() { throw new Error("getter executed"); } };
    const hidden = request(reference(bytes));
    Object.defineProperty(hidden.attachment, "path", { value: "/private", enumerable: false });
    for (const input of [revoked.proxy, getter, hidden]) {
      expect(() => right.handle(LEFT, "attachment.get", input)).not.toThrow();
      expect(() => right.handle(LEFT, "attachment.chunk", input)).not.toThrow();
    }
    expect(reads).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });

  it("transfers the full 10MiB limit with a bounded final chunk", async () => {
    const bytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.fileBytes, 0xa5);
    const ref = reference(bytes);
    const { left, frames, reads } = wiredPair(bytes);
    const result = left.fetch(RIGHT, ref);
    const [received] = await Promise.all([result, vi.runAllTimersAsync()]);
    expect(received.length).toBe(bytes.length);
    expect(createHash("sha256").update(received).digest("hex")).toBe(ref.sha256);
    expect(reads).toHaveLength(Math.ceil(bytes.length / ROOM_ATTACHMENT_LIMITS.chunkBytes));
    const last = frames.at(-1)!.payload as RoomAttachmentResponse;
    expect(Buffer.from(last.data!, "base64").length).toBe(bytes.length % ROOM_ATTACHMENT_LIMITS.chunkBytes);
  });

  it("renews the chunk timeout while a whole transfer takes longer than timeoutMs", async () => {
    const bytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.chunkBytes * 2 + 1, 5);
    const { left } = wiredPair(bytes, { timeoutMs: 25 }, (frame, deliver) => {
      if (frame.type === "attachment.chunk") setTimeout(deliver, 20);
      else deliver();
      return true;
    });
    await Promise.all([expect(left.fetch(RIGHT, reference(bytes))).resolves.toEqual(bytes), vi.runAllTimersAsync()]);
    expect(Date.now()).toBe(1_060);
  });

  it("ignores replayed chunks without advancing or resurrecting a finished fetch", async () => {
    const bytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.chunkBytes + 1, 7);
    const replies: RoomAttachmentResponse[] = [];
    const { left, frames } = wiredPair(bytes, {}, (frame, deliver) => {
      deliver();
      if (frame.type === "attachment.chunk") {
        replies.push(frame.payload as RoomAttachmentResponse);
        for (const response of replies) left.handle(RIGHT, "attachment.chunk", response);
      }
      return true;
    });
    await Promise.all([expect(left.fetch(RIGHT, reference(bytes))).resolves.toEqual(bytes), vi.runAllTimersAsync()]);
    for (const response of replies) left.handle(RIGHT, "attachment.chunk", response);
    await vi.runAllTimersAsync();
    expect(frames).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "hash", "peer error"])("removes abort listeners after %s", async kind => {
    const bytes = Buffer.from("foof");
    const abort = new AbortController();
    const { left } = wiredPair(bytes, {}, (frame, deliver) => {
      if (kind === "peer error" && frame.type === "attachment.chunk") {
        left.handle(RIGHT, "attachment.chunk", { requestId: frame.payload.requestId, offset: 0, error: "denied" });
      } else deliver();
      return true;
    });
    const ref = reference(bytes);
    if (kind === "hash") ref.sha256 = "0".repeat(64);
    const outcome = left.fetch(RIGHT, ref, abort.signal).catch(error => error);
    await vi.runAllTimersAsync();
    if (kind === "success") expect(await outcome).toEqual(bytes);
    else expect(await outcome).toBeInstanceOf(Error);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("snapshots metadata before asynchronous authorization and reads", async () => {
    const bytes = Buffer.alloc(ROOM_ATTACHMENT_LIMITS.chunkBytes + 1, 7);
    const ref = reference(bytes);
    const original = { ...ref };
    const { left, reads } = wiredPair(bytes);
    const result = left.fetch(RIGHT, ref);
    ref.size = 0;
    ref.sha256 = "0".repeat(64);
    ref.name = "changed.bin";
    await Promise.all([expect(result).resolves.toEqual(bytes), vi.runAllTimersAsync()]);
    expect(reads.every(read => read.ref.size === original.size && read.ref.sha256 === original.sha256)).toBe(true);
  });

  it("times out queued requests and replies before the next paced send", async () => {
    const bytes = Buffer.from("f");
    const sent: string[] = [];
    const instance = transport({ timeoutMs: 20, read: async () => bytes, send: (peer, type, payload) => {
      sent.push(type);
      if (type === "attachment.get") instance.handle(peer, "attachment.chunk", { requestId: payload.requestId, offset: 0, data: "Zg==" });
      return true;
    } });
    await instance.fetch(RIGHT, reference(bytes));
    const result = instance.fetch(RIGHT, reference(bytes)).catch(error => error);
    instance.handle(RIGHT, "attachment.get", request(reference(bytes)));
    await vi.runAllTimersAsync();
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringMatching(/timed out/i) }));
    expect(sent).toEqual(["attachment.get"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the combined outgoing queue across many peers", async () => {
    const bytes = Buffer.from("f");
    const waiting = deferred<Buffer>();
    const sent: Array<{ peer: string; time: number }> = [];
    let reads = 0;
    const instance = transport({ timeoutMs: 5_000, read: () => { reads++; return waiting.promise; }, send: peer => {
      sent.push({ peer, time: Date.now() }); return true;
    } });
    instance.handle("reading:1", "attachment.get", request(reference(bytes)));
    instance.handle("reading:2", "attachment.get", request(reference(bytes)));
    for (let peer = 0; peer < 16; peer++) {
      for (let i = 0; i < 100; i++) instance.handle(`flood:${peer}`, "attachment.get", request(reference(bytes)));
    }
    expect(reads).toBe(2);
    expect(sent.length).toBeLessThanOrEqual(16);
    await vi.advanceTimersByTimeAsync(1_020);
    expect(sent.length).toBeLessThanOrEqual(16 + 64);
    expect(sent.length).toBeGreaterThan(16);
    for (const peer of new Set(sent.map(frame => frame.peer))) {
      const times = sent.filter(frame => frame.peer === peer).map(frame => frame.time);
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(60);
    }
    instance.dispose();
    waiting.resolve(bytes);
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds peer cooldown state and recovers through connection churn", async () => {
    const bytes = Buffer.from("f");
    const waiting = deferred<Buffer>();
    const sent: string[] = [];
    const instance = transport({ timeoutMs: 5_000, read: () => waiting.promise, send: peer => { sent.push(peer); return true; } });
    instance.handle(LEFT, "attachment.get", request(reference(bytes)));
    instance.handle(RIGHT, "attachment.get", request(reference(bytes)));
    for (let i = 0; i < 1_000; i++) instance.handle(`socket:${i}`, "attachment.get", request(reference(bytes)));
    expect(sent.length).toBeLessThanOrEqual(64);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(66);
    for (let i = 0; i < 10_000; i++) instance.disconnect(`socket:${i}`);
    instance.disconnect(LEFT);
    instance.disconnect(RIGHT);
    waiting.resolve(bytes);
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    const count = sent.length;
    instance.handle("fresh socket", "attachment.get", request(reference(bytes)));
    await vi.runAllTimersAsync();
    expect(sent.slice(count)).toEqual(["fresh socket"]);
  });

  it("paces independent peers independently", async () => {
    const bytes = Buffer.from("f");
    const sent: Array<{ peer: string; time: number }> = [];
    const instance = transport({ read: async () => bytes, send: (peer, _type, payload) => {
      sent.push({ peer, time: Date.now() });
      instance.handle(peer, "attachment.chunk", { requestId: payload.requestId, offset: 0, data: "Zg==" });
      return true;
    } });
    await Promise.all([
      instance.fetch(RIGHT, reference(bytes)), instance.fetch(LEFT, reference(bytes)), vi.runAllTimersAsync(),
    ]);
    expect(sent).toEqual([{ peer: RIGHT, time: 1_000 }, { peer: LEFT, time: 1_000 }]);
  });
});
