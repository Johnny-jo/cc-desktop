import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { nativeConnection } = createRequire(import.meta.url)("../../resources/windows-computer/native-connection.cjs");
class Worker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  kill = vi.fn();
}

describe("Windows computer helper connection", () => {
  it("isolates late output and exit from a cancelled action when the model immediately observes again", async () => {
    const old = new Worker(), fresh = new Worker();
    const driver = nativeConnection(vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh));
    const controller = new AbortController();
    const initial = driver.request("click", {}, controller.signal);
    controller.abort();
    await expect(initial).rejects.toThrow("interrupted");
    const retried = driver.request("observe_window", {}, new AbortController().signal);
    old.stdout.write('{"value":"old click"}\n');
    old.emit("exit", 1);
    fresh.stdout.write('{"value":"new observation"}\n');
    await expect(retried).resolves.toBe("new observation");
    expect(old.kill).toHaveBeenCalledOnce();
    driver.close();
  });

  it("keeps a user-stopped connection revoked even if the model asks to reconnect its worker", async () => {
    const child = new Worker(), spawn = vi.fn(() => child);
    const driver = nativeConnection(spawn);
    const signal = new AbortController().signal;
    const active = driver.request("invoke_control", {}, signal);
    child.emit("exit", 42);
    await expect(active).rejects.toThrow("stopped by the user");
    await expect(driver.request("list_windows", {}, signal)).rejects.toThrow("stopped by the user");
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("honors a delayed emergency stop from a retired helper while its replacement is active", async () => {
    const old = new Worker(), fresh = new Worker();
    const driver = nativeConnection(vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(fresh));
    const controller = new AbortController();
    const before = driver.request("click", {}, controller.signal);
    controller.abort();
    await expect(before).rejects.toThrow("interrupted");
    const after = driver.request("activate_window", {}, new AbortController().signal);
    old.emit("exit", 42);
    await expect(after).rejects.toThrow("stopped by the user");
    expect(fresh.kill).toHaveBeenCalledOnce();
  });

  it("drops an idle OCR process and starts a fresh one on the next image", async () => {
    vi.useFakeTimers();
    try {
      const first = new Worker(), next = new Worker();
      const driver = nativeConnection(vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(next), 1000, { idleMs: 60 });
      const signal = new AbortController().signal;
      const a = driver.request("analyze", {}, signal);
      first.stdout.write('{"value":"A"}\n');
      await expect(a).resolves.toBe("A");
      await vi.advanceTimersByTimeAsync(60);
      expect(first.kill).toHaveBeenCalledOnce();
      const b = driver.request("analyze", {}, signal);
      first.emit("exit", 0);
      next.stdout.write('{"value":"B"}\n');
      await expect(b).resolves.toBe("B");
      driver.close();
    } finally { vi.useRealTimers(); }
  });

  it("discards in-flight image analysis when the desktop hotkey revokes the connection", async () => {
    const native = new Worker(), analyzer = new Worker();
    const vision = nativeConnection(() => analyzer);
    const driver = nativeConnection(() => native, 1000, { onRevoke: () => vision.close() });
    const signal = new AbortController().signal;
    const capture = driver.request("capture_window", {}, signal);
    native.stdout.write('{"value":"fixture frame"}\n');
    await capture;
    const reading = vision.request("analyze", {}, signal);
    native.emit("exit", 42);
    analyzer.stdout.write('{"value":"revoked image"}\n');
    await expect(reading).rejects.toThrow("closed");
    expect(analyzer.kill).toHaveBeenCalledOnce();
  });
});
