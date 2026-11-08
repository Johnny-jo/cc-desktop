import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const modulePath = path.resolve(import.meta.dirname, "../../resources/playwright-mcp/browser-auth.cjs");
const { saveBrowserAuthorization, loadBrowserAuthorization, removeBrowserAuthorization, hasBrowserAuthorization } = existsSync(modulePath) ? require(modulePath) : {};
const token = Buffer.alloc(32, 7).toString("base64url");
const otherToken = Buffer.alloc(32, 9).toString("base64url");
let directory: string;
let storePath: string;
let protect: ReturnType<typeof vi.fn>;
let unprotect: ReturnType<typeof vi.fn>;
let options: Record<string, unknown>;

beforeEach(() => {
  // The Windows sandbox permits atomic rename within the workspace, but not the OS temp directory.
  const fixtureRoot = path.resolve(import.meta.dirname, "../../../../.tmp");
  mkdirSync(fixtureRoot, { recursive: true });
  directory = mkdtempSync(path.join(fixtureRoot, "agentos-browser-auth-test-"));
  storePath = path.join(directory, "private", "browser-auth.json");
  protect = vi.fn(async (value: string) => Buffer.from(`synthetic-protected:${value}`).toString("base64"));
  unprotect = vi.fn(async (value: string) => Buffer.from(value, "base64").toString().slice("synthetic-protected:".length));
  options = { protect, unprotect };
});
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

describe("encrypted browser authorization", () => {
  it("normalizes the official copied assignment and stores only ciphertext metadata", async () => {
    expect(await saveBrowserAuthorization(storePath, "msedge", "Profile 2", `  PLAYWRIGHT_MCP_EXTENSION_TOKEN=${token}\n`, options)).toEqual({ configured: true });
    expect(protect).toHaveBeenCalledWith(token);
    expect(await loadBrowserAuthorization(storePath, "msedge", "profile 2", options)).toBe(token);
    expect(hasBrowserAuthorization(storePath, "msedge", "PROFILE 2")).toBe(true);
    const raw = readFileSync(storePath, "utf8");
    expect(raw).not.toContain(token);
    const saved = JSON.parse(raw);
    expect(saved.version).toBe(1);
    expect(Object.keys(saved.entries)).toEqual(["msedge:profile 2"]);
    expect(Object.keys(saved.entries["msedge:profile 2"]).sort()).toEqual(["browser", "ciphertext", "profileName", "updatedAt"]);
    expect(readdirSync(path.dirname(storePath))).toEqual(["browser-auth.json"]);
  });

  it("isolates browser and profile and never decrypts a different profile's record", async () => {
    await saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, options);
    expect(await loadBrowserAuthorization(storePath, "chrome", "Profile 2", options)).toBeUndefined();
    expect(await loadBrowserAuthorization(storePath, "msedge", "Default", options)).toBeUndefined();
    expect(hasBrowserAuthorization(storePath, "chrome", "Profile 2")).toBe(false);
    expect(unprotect).not.toHaveBeenCalled();
  });

  it("serializes concurrent profile writes so neither authorization is lost", async () => {
    await Promise.all([
      saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, options),
      saveBrowserAuthorization(storePath, "chrome", "Default", otherToken, options),
    ]);
    expect(await loadBrowserAuthorization(storePath, "msedge", "Profile 2", options)).toBe(token);
    expect(await loadBrowserAuthorization(storePath, "chrome", "Default", options)).toBe(otherToken);
    expect(Object.keys(JSON.parse(readFileSync(storePath, "utf8")).entries)).toHaveLength(2);
  });

  it("removes just the selected case-insensitive entry without crypto", async () => {
    await saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, options);
    await saveBrowserAuthorization(storePath, "chrome", "Default", otherToken, options);
    protect.mockClear(); unprotect.mockClear();
    await removeBrowserAuthorization(storePath, "msedge", "PROFILE 2");
    expect(hasBrowserAuthorization(storePath, "msedge", "Profile 2")).toBe(false);
    expect(hasBrowserAuthorization(storePath, "chrome", "Default")).toBe(true);
    expect(protect).not.toHaveBeenCalled();
    expect(unprotect).not.toHaveBeenCalled();
  });

  it("handles an absent store without creating files", async () => {
    expect(hasBrowserAuthorization(storePath, "msedge", "Profile 2")).toBe(false);
    expect(await loadBrowserAuthorization(storePath, "msedge", "Profile 2", options)).toBeUndefined();
    await removeBrowserAuthorization(storePath, "msedge", "Profile 2");
    expect(existsSync(storePath)).toBe(false);
  });

  it.each(["bad", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "B", "=" + token])("rejects invalid token shape %j before crypto or writes", async (value) => {
    await expect(saveBrowserAuthorization(storePath, "msedge", "Profile 2", value, options)).rejects.toThrow(/授权|令牌/);
    expect(protect).not.toHaveBeenCalled();
    expect(existsSync(path.dirname(storePath))).toBe(false);
  });

  it.each([["firefox", "Default"], ["msedge", "../outside"], ["chrome", "..\\outside"], ["msedge", ""], ["msedge", "x".repeat(81)]])("rejects invalid browser/profile %s %s before crypto or writes", async (browser, profile) => {
    await expect(saveBrowserAuthorization(storePath, browser, profile, token, options)).rejects.toThrow();
    expect(protect).not.toHaveBeenCalled();
    expect(existsSync(storePath)).toBe(false);
  });

  it("requires an absolute store path before touching crypto", async () => {
    await expect(saveBrowserAuthorization("browser-auth.json", "msedge", "Default", token, options)).rejects.toThrow(/路径|absolute/i);
    expect(protect).not.toHaveBeenCalled();
  });

  it("returns safe actionable errors for corrupt files and does not overwrite them", async () => {
    mkdirSync(path.dirname(storePath));
    const corrupt = `not-json ${token}`;
    writeFileSync(storePath, corrupt);
    await expect(loadBrowserAuthorization(storePath, "msedge", "Profile 2", options)).rejects.toThrow(/损坏|授权/);
    await expect(saveBrowserAuthorization(storePath, "msedge", "Profile 2", otherToken, options)).rejects.toThrow(/损坏|授权/);
    try { hasBrowserAuthorization(storePath, "msedge", "Profile 2"); } catch (error) { expect(String(error)).not.toContain(token); }
    expect(readFileSync(storePath, "utf8")).toBe(corrupt);
  });

  it("rejects plaintext or unknown fields in a store instead of trusting a partial schema", async () => {
    mkdirSync(path.dirname(storePath));
    writeFileSync(storePath, JSON.stringify({ version: 1, entries: { "msedge:profile 2": { browser: "msedge", profileName: "Profile 2", token } } }));
    await expect(loadBrowserAuthorization(storePath, "msedge", "Profile 2", options)).rejects.toThrow(/损坏|授权/);
    expect(unprotect).not.toHaveBeenCalled();
  });

  it("hides crypto provider errors and preserves the previous ciphertext on failure", async () => {
    await saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, options);
    const before = readFileSync(storePath, "utf8");
    protect.mockRejectedValueOnce(new Error(`secret ${otherToken}`));
    await expect(saveBrowserAuthorization(storePath, "msedge", "Profile 2", otherToken, options)).rejects.not.toThrow(otherToken);
    expect(readFileSync(storePath, "utf8")).toBe(before);
    unprotect.mockRejectedValueOnce(new Error(`secret ${token}`));
    await expect(loadBrowserAuthorization(storePath, "msedge", "Profile 2", options)).rejects.toThrow(/解密|重新配置/);
  });

  it("preserves the committed file and cleans staging data when atomic replacement fails", async () => {
    await saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, options);
    const before = readFileSync(storePath, "utf8");
    const fs = require("node:fs") as typeof import("node:fs");
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("synthetic atomic replacement failure"));
    await expect(saveBrowserAuthorization(storePath, "chrome", "Default", otherToken, options)).rejects.toThrow(/安全保存|权限/);
    expect(readFileSync(storePath, "utf8")).toBe(before);
    expect(readdirSync(path.dirname(storePath))).toEqual(["browser-auth.json"]);
  });

  it("refuses a provider that returns plaintext or an invalid decrypted token", async () => {
    protect.mockResolvedValueOnce(token);
    await expect(saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, options)).rejects.toThrow(/加密结果/);
    expect(existsSync(storePath)).toBe(false);
    await saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, options);
    unprotect.mockResolvedValueOnce("invalid");
    await expect(loadBrowserAuthorization(storePath, "msedge", "Profile 2", options)).rejects.toThrow(/解密|重新配置/);
  });

  it("continues serialized saves after a failed earlier operation", async () => {
    protect.mockRejectedValueOnce(new Error("synthetic provider unavailable"));
    const results = await Promise.allSettled([
      saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, options),
      saveBrowserAuthorization(storePath, "chrome", "Default", otherToken, options),
    ]);
    expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(await loadBrowserAuthorization(storePath, "chrome", "Default", options)).toBe(otherToken);
  });

  it("rejects unavailable platform crypto without a plaintext fallback", async () => {
    await expect(saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, { platform: "linux" })).rejects.toThrow(/Windows|加密/);
    expect(existsSync(storePath)).toBe(false);
  });
});

describe("DPAPI subprocess protocol", () => {
  it("passes only stdin secrets to fixed CurrentUser DPAPI scripts", async () => {
    const ciphertext = Buffer.from("opaque-dpapi-fixture").toString("base64");
    const inputs: string[] = [];
    const spawn = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      let input = "";
      child.stdin.on("data", value => { input += value.toString(); });
      child.stdin.on("finish", () => { inputs.push(input); queueMicrotask(() => { child.stdout.end(inputs.length === 1 ? ciphertext : token); child.emit("close", 0); }); });
      return child;
    });
    const protocolOptions = { platform: "win32", env: { SystemRoot: "C:\\Windows" }, spawn };
    await saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, protocolOptions);
    expect(await loadBrowserAuthorization(storePath, "msedge", "Profile 2", protocolOptions)).toBe(token);
    expect(inputs).toEqual([token, ciphertext]);
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const [executable, args, settings] of spawn.mock.calls as unknown as Array<[string, string[], unknown]>) {
      expect(executable).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
      expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      expect(args.join(" ")).not.toContain(token);
      expect(args.join(" ")).not.toContain(ciphertext);
      const script = Buffer.from(args[3], "base64").toString("utf16le");
      expect(script).toContain("CurrentUser");
      expect(script).toContain("AgentOS.Playwright.ExtensionToken.v1");
      expect(script).toContain("UTF8Encoding");
      expect(settings).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    }
  });

  it("bounds a stuck provider and does not expose secret output on failure", async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const spawn = vi.fn(() => child);
    const pending = saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, { platform: "win32", spawn, timeoutMs: 10 });
    await expect(pending).rejects.toThrow(/超时|加密/);
    expect(child.kill).toHaveBeenCalled();
    expect(existsSync(storePath)).toBe(false);
  });

  it("suppresses subprocess output and errors that contain secret values", async () => {
    const spawn = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      child.stdin.on("finish", () => queueMicrotask(() => {
        child.stdout.end(token);
        child.stderr.end(otherToken);
        child.emit("close", 1);
      }));
      return child;
    });
    let caught: unknown;
    try { await saveBrowserAuthorization(storePath, "msedge", "Profile 2", token, { platform: "win32", spawn }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(token);
    expect(String(caught)).not.toContain(otherToken);
    expect(caught).not.toHaveProperty("cause");
    expect(existsSync(storePath)).toBe(false);
  });
});
