import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const modulePath = path.resolve("resources/playwright-mcp/browser-lease.cjs");
let lease: any = {};
try { lease = require(modulePath); } catch (error: any) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

function child(resource: string) {
  const program = `const {acquireBrowserLease}=require(${JSON.stringify(modulePath)}); acquireBrowserLease(${JSON.stringify(resource)}).then(async lease=>{console.log('acquired');process.stdin.once('data',async()=>{await lease.release();process.exit(0)});process.stdin.resume()}).catch(e=>{console.log(e.message);process.exit(2)});`;
  const process = spawn(globalThis.process.execPath, ["-e", program], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  cleanup.push(async () => { if (process.exitCode === null) process.kill(); });
  let output = "";
  const ready = new Promise<string>((resolve, reject) => {
    process.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) resolve(output.trim()); });
    process.once("error", reject); process.once("exit", () => resolve(output.trim()));
  });
  const exited = new Promise<void>(resolve => process.once("exit", () => resolve()));
  return { process, ready, exited };
}

describe("browser process lease", () => {
  it("excludes another process on one browser and releases the lease when the owner exits", async () => {
    expect(typeof lease.acquireBrowserLease).toBe("function");
    const resource = `fixture-${globalThis.process.pid}-${Date.now()}`;
    const owner = child(resource); expect(await owner.ready).toBe("acquired");
    const contender = child(resource); expect(await contender.ready).toMatch(/already controlled|正在由其他/);
    expect(await contender.ready).not.toContain(resource);
    await contender.exited;
    owner.process.kill(); await owner.exited;
    const next = await lease.acquireBrowserLease(resource); cleanup.push(() => next.release());
    await next.release(); await next.release();
    const again = await lease.acquireBrowserLease(resource); cleanup.push(() => again.release());
  }, 15000);

  it("allows independent browsers concurrently and isolated mode requires no lease", async () => {
    expect(typeof lease.acquireBrowserLease).toBe("function");
    const first = await lease.acquireBrowserLease(`fixture-a-${globalThis.process.pid}`); cleanup.push(() => first.release());
    const second = await lease.acquireBrowserLease(`fixture-b-${globalThis.process.pid}`); cleanup.push(() => second.release());
    const isolated = await lease.acquireBrowserLease(undefined); await isolated.release();
  });
});
