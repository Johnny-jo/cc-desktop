import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const modulePath = path.resolve("resources/playwright-mcp/control-runtime.cjs");
let runtime: any = {};
try { runtime = require(modulePath); } catch (error: any) { if (error.code !== "MODULE_NOT_FOUND") throw error; }

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describe("browser runtime resource ownership", () => {
  it("identifies HTTP and WebSocket endpoints on the same loopback browser as one resource without exposing tokens", () => {
    expect(typeof runtime.browserResource).toBe("function");
    const first = runtime.browserResource({ connection: "cdp", cdpEndpoint: "http://localhost:9222/" });
    expect(first).toBe(runtime.browserResource({ connection: "cdp", cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/uuid" }));
    expect(first).not.toContain("secret");
    expect(runtime.browserResource({ connection: "isolated" })).toBeUndefined();
    expect(() => runtime.browserResource({ connection: "cdp", cdpEndpoint: "http://user:secret@localhost:9222" })).toThrow(/CDP/);
    for (const endpoint of ["http://localhost:9222/?token=secret", "http://localhost:9222/#fragment", "http://local\nhost:9222/", "", "http://localhost/" + "x".repeat(2048)]) {
      expect(() => runtime.browserResource({ connection: "cdp", cdpEndpoint: endpoint })).toThrow(/CDP/);
    }
  });

  it("serializes tool calls, rejects queued writes after revocation, and never executes cancelled queued work", async () => {
    expect(typeof runtime.createCallQueue).toBe("function");
    const queue = runtime.createCallQueue("cancelled");
    const entered = deferred(); const unblock = deferred(); const events: string[] = [];
    const first = queue.run(async () => { events.push("first"); entered.resolve(); await unblock.promise; });
    const observedFirst = first.catch((error: Error) => error.message);
    await entered.promise;
    const second = queue.run(async () => { events.push("second"); });
    const observedSecond = second.catch((error: Error) => error.message);
    expect(events).toEqual(["first"]);
    queue.revoke(); unblock.resolve();
    expect(await observedFirst).toBe("cancelled");
    expect(await observedSecond).toBe("cancelled");
    expect(events).toEqual(["first"]);
    const next = runtime.createCallQueue("cancelled"); const signal = new AbortController(); signal.abort();
    await expect(next.run(async () => { events.push("aborted"); }, signal.signal)).rejects.toThrow();
    expect(events).toEqual(["first"]);
  });

  it("runs later calls after earlier calls settle in order", async () => {
    expect(typeof runtime.createCallQueue).toBe("function");
    const queue = runtime.createCallQueue("cancelled"); const events: string[] = [];
    const first = queue.run(async () => { events.push("first"); await Promise.resolve(); events.push("done"); throw new Error("action failed"); });
    const second = queue.run(async () => { events.push("second"); });
    await expect(first).rejects.toThrow("action failed"); await second;
    expect(events).toEqual(["first", "done", "second"]);
  });

  it("releases attached connections once without closing user contexts or pages", async () => {
    expect(typeof runtime.createOwnership).toBe("function");
    const events: string[] = [];
    const ownership = runtime.createOwnership({ attached: true,
      browser: { close: async () => events.push("disconnect-owner"), unbind: async () => events.push("unbind") },
      driver: { close: async () => events.push("disconnect-driver") },
      context: { close: async () => events.push("close-context") },
      beforeRelease: async () => events.push("indicators"), releaseLease: async () => events.push("lease"),
    });
    await Promise.all([ownership.release(), ownership.release()]);
    expect(events).toEqual(["indicators", "disconnect-driver", "unbind", "disconnect-owner", "lease"]);
  });

  it("closes its own isolated context and browser and releases after cleanup failure", async () => {
    expect(typeof runtime.createOwnership).toBe("function");
    const events: string[] = [];
    const ownership = runtime.createOwnership({ attached: false,
      browser: { close: async () => events.push("browser"), unbind: async () => events.push("unbind") },
      context: { close: async () => events.push("context") },
      beforeRelease: async () => { throw new Error("page closed"); }, releaseLease: async () => events.push("lease"),
    });
    await ownership.release(); expect(events).toEqual(["context", "unbind", "browser", "lease"]);
  });

  it("disconnects and releases the lease when decorative cleanup never resolves", async () => {
    const events: string[] = [];
    const ownership = runtime.createOwnership({ attached: true,
      browser: { close: async () => events.push("disconnect"), unbind: async () => {} },
      beforeRelease: () => new Promise(() => {}), releaseLease: async () => events.push("lease"),
    });
    const released = await Promise.race([ownership.release().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1000))]);
    expect(released).toBe(true); expect(events).toEqual(["disconnect", "lease"]);
  });
});
