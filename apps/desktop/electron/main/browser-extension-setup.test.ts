import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const modulePath = path.resolve(import.meta.dirname, "../../resources/playwright-mcp/extension-setup.cjs");
const { getBrowserExtensionStatus, prepareBrowserExtension } = existsSync(modulePath) ? require(modulePath) : {};
const id = "mmlmfjhmonkocbjadbfplnigmagldckm";
const updateUrl = "https://clients2.google.com/service/update2/crx";
let localAppData: string;
let profile: string;
let exe: string;
let registeredUrl: string | undefined;
let registryError: Error | undefined;
let registrationError: Error | undefined;
let spawnError: Error | undefined;
let queryErrorText: string | undefined;
let structuredRegistry: Record<string, unknown>;
let structuredError: Error | undefined;
let options: Record<string, unknown>;
let execFile: ReturnType<typeof vi.fn>;
let spawn: ReturnType<typeof vi.fn>;

function key(channel = "msedge") {
  return `HKCU\\Software\\${channel === "msedge" ? "Microsoft\\Edge" : "Google\\Chrome"}\\Extensions\\${id}`;
}
function seedBrowser(channel = "msedge") {
  const components = channel === "msedge" ? ["Microsoft", "Edge"] : ["Google", "Chrome"];
  const root = path.join(localAppData, ...components, "User Data");
  profile = path.join(root, "Profile 2");
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { last_used: "Profile 2" } }));
  exe = path.join(localAppData, ...components, "Application", channel === "msedge" ? "msedge.exe" : "chrome.exe");
  mkdirSync(path.dirname(exe), { recursive: true });
  writeFileSync(exe, "synthetic executable; never executed");
}
function seedExtension(state?: number, reasons: unknown = [], manifest = true, file = "Preferences") {
  if (manifest) {
    const folder = path.join(profile, "Extensions", id, "0.0.84_0");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Playwright", version: "0.0.84" }));
  }
  if (state !== undefined) writeFileSync(path.join(profile, file), JSON.stringify({ extensions: { settings: {
    [id]: { state, disable_reasons: reasons, manifest: { version: "0.0.84" } },
  } } }));
}
function seedModernExtension(extra: Record<string, unknown> = {}) {
  seedExtension();
  writeFileSync(path.join(profile, "Preferences"), JSON.stringify({ extensions: { settings: {
    [id]: { path: `${id}/0.0.84_0`, location: 1, from_webstore: true, manifest: { version: "0.0.84" }, ...extra },
  } } }));
}
beforeEach(() => {
  localAppData = mkdtempSync(path.join(tmpdir(), "agentos-extension-setup-"));
  seedBrowser();
  registeredUrl = undefined; registryError = undefined; registrationError = undefined; spawnError = undefined;
  queryErrorText = undefined; structuredRegistry = { exists: false }; structuredError = undefined;
  execFile = vi.fn((_exe, args: string[], _settings, callback) => {
    if (/powershell\.exe$/i.test(_exe)) return callback(structuredError ?? null, JSON.stringify(structuredRegistry), structuredError?.message ?? "");
    if (registryError) return callback(registryError, "", "");
    if (args[0] === "query") {
      if (registeredUrl) return callback(null, `    update_url    REG_SZ    ${registeredUrl}\r\n`, "");
      return callback(Object.assign(new Error("missing"), { code: 1 }), "", queryErrorText ?? "ERROR: The system was unable to find the specified registry key or value.");
    }
    if (registrationError) return callback(registrationError, "", "");
    registeredUrl = args[args.indexOf("/d") + 1];
    callback(null, "The operation completed successfully.", "");
  });
  spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit(spawnError ? "error" : "spawn", spawnError));
    return child;
  });
  options = { localAppData, platform: "win32", env: {}, execFile, spawn };
});
afterEach(() => { rmSync(localAppData, { recursive: true, force: true }); });

describe("official browser extension preparation", () => {
  it("reads status without writes or launches and does not confuse a folder with enabled installation", async () => {
    mkdirSync(path.join(profile, "Extensions", id), { recursive: true });
    const result = await getBrowserExtensionStatus("msedge", undefined, options);
    expect(result).toMatchObject({ browser: "msedge", profileName: "Profile 2", state: "pending-download", registered: false });
    expect(result.message).toMatch(/尚未|未登记/);
    expect(execFile.mock.calls.every(call => call[1][0] === "query")).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["Preferences", "Secure Preferences"])("reports ready only with enabled %s metadata and a manifest", async (file) => {
    seedExtension(1, [], true, file);
    expect(await prepareBrowserExtension("msedge", "Profile 2", options)).toMatchObject({ state: "ready", registered: false });
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile.mock.calls.every(call => call[1][0] === "query")).toBe(true);
  });

  it.each([{}, { disable_reasons: [] }, { disable_reasons: 0 }])("recognizes modern enabled records without obsolete state: %j", async (extra) => {
    seedModernExtension(extra);
    expect(await prepareBrowserExtension("msedge", undefined, options)).toMatchObject({ state: "ready" });
    expect(execFile.mock.calls.every(call => call[1][0] === "query")).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["denied", "conflict"])("connects an already-enabled manual installation despite %s registry registration", async (kind) => {
    seedModernExtension();
    if (kind === "denied") registryError = Object.assign(new Error("access denied"), { code: "EACCES" });
    else registeredUrl = "https://other.example/update";
    expect(await getBrowserExtensionStatus("msedge", undefined, options)).toMatchObject({ state: "ready" });
    expect(await prepareBrowserExtension("msedge", undefined, options)).toMatchObject({ state: "ready" });
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([{ disable_reasons: [8] }, { disable_reasons: 8 }, { state: 0 }, { state: 2 }])("keeps modern or legacy disabled records pending: %j", async (extra) => {
    seedModernExtension(extra);
    expect(await getBrowserExtensionStatus("msedge", undefined, options)).toMatchObject({ state: "pending-enable" });
  });

  it.each([
    { blacklist: true }, { blacklist_state: 1 }, { omaha_blocklist_state: 1 },
    { omaha_blocklist_state: 5 }, { extension_telemetry_service_blocklist_state: 1 },
  ])("does not report malware-blocklisted records ready: %j", async (extra) => {
    seedModernExtension({ state: 1, disable_reasons: [], ...extra });
    expect(await getBrowserExtensionStatus("msedge", undefined, options)).toMatchObject({ state: "pending-enable" });
  });

  it("does not mistake an acknowledged greylist for a malware blocklist", async () => {
    seedModernExtension({ blacklist_state: 2, omaha_blocklist_state: 4, acknowledged_blocklist_state: 4 });
    expect(await getBrowserExtensionStatus("msedge", undefined, options)).toMatchObject({ state: "ready" });
  });

  it.each([undefined, {}])("requires actual settings metadata as well as installed files: %j", async (record) => {
    seedExtension();
    if (record) writeFileSync(path.join(profile, "Preferences"), JSON.stringify({ extensions: { settings: { [id]: record } } }));
    expect(await getBrowserExtensionStatus("msedge", undefined, options)).toMatchObject({ state: "pending-enable" });
  });

  it("explains queued registration and possible browser restart without claiming an active download", async () => {
    registeredUrl = updateUrl;
    const result = await getBrowserExtensionStatus("msedge", undefined, options);
    expect(result).toMatchObject({ state: "pending-download", registered: true });
    expect(result.message).toMatch(/已登记|已注册/);
    expect(result.message).toMatch(/重启/);
    expect(result.message).not.toMatch(/正在.*下载|确认.*启用|安装并启用/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not label metadata without files ready", async () => {
    seedExtension(1, [], false);
    expect(await getBrowserExtensionStatus("msedge", undefined, options)).toMatchObject({ state: "pending-download" });
  });

  it.each([[0, []], [1, [8]], [1, 8]])("requires browser confirmation when state=%j reasons=%j", async (state, reasons) => {
    seedExtension(state as number, reasons);
    const result = await prepareBrowserExtension("msedge", undefined, options);
    expect(result).toMatchObject({ state: "pending-enable", registered: true });
    expect(result.message).toMatch(/启用|确认/);
  });

  it("honors disabled Secure Preferences over an older enabled record", async () => {
    seedExtension(1);
    seedExtension(0, [8], true, "Secure Preferences");
    expect(await getBrowserExtensionStatus("msedge", undefined, options)).toMatchObject({ state: "pending-enable" });
  });

  it("uses a modern secure record without inheriting obsolete state from Preferences", async () => {
    seedExtension(0);
    writeFileSync(path.join(profile, "Secure Preferences"), JSON.stringify({ extensions: { settings: {
      [id]: { path: `${id}/0.0.84_0`, location: 1, disable_reasons: [] },
    } } }));
    expect(await getBrowserExtensionStatus("msedge", undefined, options)).toMatchObject({ state: "ready" });
  });

  it.each(["msedge", "chrome"])("registers only the official %s key and scopes launch to the selected profile", async (channel) => {
    if (channel === "chrome") seedBrowser(channel);
    const result = await prepareBrowserExtension(channel, undefined, options);
    expect(result).toMatchObject({ browser: channel, profileName: "Profile 2", state: "pending-download", registered: true });
    expect(execFile.mock.calls[0]).toEqual([expect.stringMatching(/reg\.exe$/i), ["query", key(channel), "/v", "update_url"], { windowsHide: true, encoding: "buffer" }, expect.any(Function)]);
    expect(execFile.mock.calls.filter(call => call[1][0] === "add")).toEqual([
      [expect.stringMatching(/reg\.exe$/i), ["add", key(channel), "/v", "update_url", "/t", "REG_SZ", "/d", updateUrl, "/f"], { windowsHide: true, encoding: "buffer" }, expect.any(Function)],
    ]);
    expect(spawn).toHaveBeenCalledWith(exe, ["--profile-directory=Profile 2", `${channel === "msedge" ? "edge" : "chrome"}://extensions/?id=${id}`], { windowsHide: false, stdio: "ignore" });
  });

  it("explains Chrome's required first-use confirmation for an externally installed extension", async () => {
    seedBrowser("chrome");
    seedModernExtension({ disable_reasons: [8192] });
    const result = await getBrowserExtensionStatus("chrome", undefined, options);
    expect(result).toMatchObject({ state: "pending-enable", profileName: "Profile 2" });
    expect(result.message).toContain("Google Chrome");
    expect(result.message).toContain("Playwright Extension");
    expect(result.message).toMatch(/首次|确认/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not repeat registry mutation or browser launch and rereads status after enabling", async () => {
    await Promise.all([prepareBrowserExtension("msedge", undefined, options), prepareBrowserExtension("msedge", undefined, options)]);
    await prepareBrowserExtension("msedge", undefined, options);
    expect(execFile.mock.calls.filter(call => call[1][0] === "add")).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    seedExtension(1);
    expect(await prepareBrowserExtension("msedge", undefined, options)).toMatchObject({ state: "ready", registered: false });
  });

  it("checks installation again immediately after the browser starts", async () => {
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation((...args) => { seedExtension(1); return original(...args); });
    expect(await prepareBrowserExtension("msedge", undefined, options)).toMatchObject({ state: "ready", registered: true });
  });

  it("does not launch when registration fails", async () => {
    registrationError = new Error("write denied");
    await expect(prepareBrowserExtension("msedge", undefined, options)).rejects.toThrow(/登记|write denied/);
    expect(spawn).not.toHaveBeenCalled();
    expect(registeredUrl).toBeUndefined();
  });

  it("preserves an existing official registration", async () => {
    registeredUrl = updateUrl;
    await prepareBrowserExtension("msedge", undefined, options);
    expect(execFile.mock.calls.every(call => call[1][0] === "query")).toBe(true);
  });

  it("uses structured read-only registry fallback for localized missing values", async () => {
    queryErrorText = "ERREUR : le système n’a pas trouvé la clé ou la valeur de Registre spécifiée.";
    expect(await prepareBrowserExtension("msedge", undefined, options)).toMatchObject({ registered: true, state: "pending-download" });
    const fallbackCalls = execFile.mock.calls.filter(call => /powershell\.exe$/i.test(call[0]));
    expect(fallbackCalls).toHaveLength(1);
    const [, args, settings] = fallbackCalls[0];
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(settings).toMatchObject({ windowsHide: true });
    const script = Buffer.from(args[3], "base64").toString("utf16le");
    expect(script).toContain("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey");
    expect(script).toContain(key().replace(/^HKCU\\/, ""));
    expect(script).toContain("UTF8Encoding");
    expect(script).not.toMatch(/LocalMachine|Policies|SetValue/);
    expect(execFile.mock.calls.filter(call => call[1][0] === "add")).toHaveLength(1);
  });

  it("does not treat localized registry access errors as missing entries", async () => {
    queryErrorText = "ERREUR : Accès refusé.";
    structuredError = Object.assign(new Error("Accès refusé"), { code: 2 });
    await expect(prepareBrowserExtension("msedge", undefined, options)).rejects.toThrow(/登记|注册|读取|Accès/);
    expect(execFile.mock.calls.filter(call => /powershell\.exe$/i.test(call[0]))).toHaveLength(1);
    expect(execFile.mock.calls.filter(call => call[1][0] === "add")).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    { exists: true, kind: "String", value: "https://other.example/update" },
    {},
  ])("rejects conflicting or unrecognized structured registry results: %j", async (result) => {
    queryErrorText = "ERREUR : erreur de lecture.";
    structuredRegistry = result;
    await expect(prepareBrowserExtension("msedge", undefined, options)).rejects.toThrow(/登记|注册|读取/);
    expect(execFile.mock.calls.filter(call => /powershell\.exe$/i.test(call[0]))).toHaveLength(1);
    expect(execFile.mock.calls.filter(call => call[1][0] === "add")).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a conflicting registration", async () => {
    registeredUrl = "https://other.example/update";
    await expect(prepareBrowserExtension("msedge", undefined, options)).rejects.toThrow(/登记|注册/);
    expect(execFile.mock.calls.every(call => call[1][0] === "query")).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("requires an installed browser before registry mutation", async () => {
    rmSync(exe);
    await expect(prepareBrowserExtension("msedge", undefined, options)).rejects.toThrow(/浏览器|Edge/);
    expect(execFile.mock.calls.every(call => call[1][0] === "query")).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("propagates registry and launch failures without editing profile data", async () => {
    seedExtension(0);
    const before = readFileSync(path.join(profile, "Preferences"), "utf8");
    registryError = Object.assign(new Error("access denied"), { code: "EACCES" });
    await expect(prepareBrowserExtension("msedge", undefined, options)).rejects.toThrow(/access denied|注册|登记/);
    registryError = undefined;
    spawnError = new Error("launch denied");
    await expect(prepareBrowserExtension("msedge", undefined, options)).rejects.toThrow(/launch denied|启动/);
    spawnError = undefined;
    await prepareBrowserExtension("msedge", undefined, options);
    expect(execFile.mock.calls.filter(call => call[1][0] === "add")).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(readFileSync(path.join(profile, "Preferences"), "utf8")).toBe(before);
  });

  it("rejects a non-string profile even when it is falsy", async () => {
    await expect(prepareBrowserExtension("msedge", 0, options)).rejects.toThrow(/profile/i);
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([["firefox", undefined], ["msedge", "../outside"], ["msedge", "..\\outside"]])("rejects unsafe input %s %s before any command", async (channel, selectedProfile) => {
    await expect(prepareBrowserExtension(channel, selectedProfile, options)).rejects.toThrow();
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects unsupported platforms without commands", async () => {
    await expect(prepareBrowserExtension("msedge", undefined, { ...options, platform: "linux" })).rejects.toThrow(/Windows/);
    expect(execFile).not.toHaveBeenCalled();
  });
});
