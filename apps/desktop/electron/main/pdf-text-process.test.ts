import { afterEach, expect, it, vi } from "vitest";
import { PdfTextProcess, type PdfProcessHandle } from "./pdf-text-process";

afterEach(() => { vi.useRealTimers(); });
function processFixture(autoReply = true) {
  let receive: Parameters<PdfProcessHandle["onMessage"]>[0] = () => {};
  let exit = () => {};
  const child: PdfProcessHandle = {
    send: vi.fn(request => { if (autoReply) queueMicrotask(() => receive({ id: request.id, type: "result", text: "extracted" })); }),
    kill: vi.fn(), onMessage: callback => { receive = callback; }, onExit: callback => { exit = callback; }, onError: () => {},
  };
  return { child, exit: () => exit(), receive: (id: number) => receive({ id, type: "progress" }) };
}

it("reuses a lazy subprocess and releases it after idle", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { child } = processFixture();
  const spawn = vi.fn(async () => child);
  const parser = new PdfTextProcess({ spawn, idleMs: 100 });
  expect(spawn).not.toHaveBeenCalled();
  expect(await parser.extract(new Uint8Array([1]))).toBe("extracted");
  expect(await parser.extract(new Uint8Array([2]))).toBe("extracted");
  expect(spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(101);
  expect(child.kill).toHaveBeenCalledOnce();
  parser.dispose();
});

it("terminates a stalled native parser and rejects the document", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { child } = processFixture(false);
  const parser = new PdfTextProcess({ spawn: async () => child, stallMs: 100 });
  const result = expect(parser.extract(new Uint8Array([1]))).rejects.toThrow("OCR 超时");
  await vi.advanceTimersByTimeAsync(101); await result;
  expect(child.kill).toHaveBeenCalledOnce(); parser.dispose();
});

it("reports a subprocess crash and starts fresh on the next document", async () => {
  const first = processFixture(false), second = processFixture();
  const spawn = vi.fn().mockResolvedValueOnce(first.child).mockResolvedValueOnce(second.child);
  const parser = new PdfTextProcess({ spawn });
  const result = expect(parser.extract(new Uint8Array([1]))).rejects.toThrow("进程退出");
  await vi.waitFor(() => expect(first.child.send).toHaveBeenCalled());
  first.exit(); await result;
  expect(await parser.extract(new Uint8Array([2]))).toBe("extracted");
  expect(spawn).toHaveBeenCalledTimes(2); parser.dispose();
});

it("cancels active and queued work on dispose", async () => {
  const { child } = processFixture(false);
  const parser = new PdfTextProcess({ spawn: async () => child });
  const active = expect(parser.extract(new Uint8Array([1]))).rejects.toThrow("已停止");
  const queued = expect(parser.extract(new Uint8Array([2]))).rejects.toThrow("已停止");
  await vi.waitFor(() => expect(child.send).toHaveBeenCalled()); parser.dispose();
  await active; await queued; expect(child.kill).toHaveBeenCalledOnce();
});

it("stops OCR when the requesting SDK connection is cancelled", async () => {
  const { child } = processFixture(false);
  const parser = new PdfTextProcess({ spawn: async () => child });
  const controller = new AbortController();
  const result = expect(parser.extract(new Uint8Array([1]), controller.signal)).rejects.toThrow("已取消");
  await vi.waitFor(() => expect(child.send).toHaveBeenCalled()); controller.abort();
  await result; expect(child.kill).toHaveBeenCalledOnce(); parser.dispose();
});
