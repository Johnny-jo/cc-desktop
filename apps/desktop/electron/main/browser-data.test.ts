import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const modulePath = path.resolve(import.meta.dirname, "../../resources/playwright-mcp/browser-data.cjs");
const { resolveBrowserProfile, searchBrowserHistory, searchBrowserBookmarks } = existsSync(modulePath) ? require(modulePath) : {};
const epoch = 11644473600000;
const chromeTime = (date: number) => (date + epoch) * 1000;
let localAppData: string;
let root: string;
let directory: string;

function profile(profileName?: string) {
  return resolveBrowserProfile("msedge", { localAppData, profileName });
}

function seedHistory(wal = false) {
  const db = new DatabaseSync(path.join(directory, "History"));
  db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER)");
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  const insert = db.prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)");
  const now = Date.now();
  insert.run("https://example.org/latest", "Newest", chromeTime(now - 1000));
  insert.run("https://example.org/find?q=100%25", "100%_literal", chromeTime(now - 2000));
  insert.run("https://example.org/other", "100XXliteral", chromeTime(now - 3000));
  insert.run("https://example.org/old", "Old", chromeTime(now - 40 * 86400000));
  insert.run("file:///private", "Unsafe", chromeTime(now));
  insert.run("https://user:password@example.org/private", "Credentials", chromeTime(now));
  return db;
}

beforeEach(() => {
  localAppData = mkdtempSync(path.join(tmpdir(), "agentos-browser-test-"));
  root = path.join(localAppData, "Microsoft", "Edge", "User Data");
  directory = path.join(root, "Profile 1");
  mkdirSync(directory, { recursive: true });
  mkdirSync(path.join(root, "Default"));
  writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { last_used: "Profile 1", info_cache: { "Profile 1": { name: "Work" } } } }));
});

afterEach(() => { vi.restoreAllMocks(); rmSync(localAppData, { recursive: true, force: true }); });

describe("browser profile selection", () => {
  it("uses Edge last-used metadata and supports an explicit safe profile directory", () => {
    expect(profile()).toEqual({ channel: "msedge", directory, profileName: "Profile 1" });
    expect(profile("Default").directory).toBe(path.join(root, "Default"));
  });

  it("uses Chrome's own browser root", () => {
    const chromeRoot = path.join(localAppData, "Google", "Chrome", "User Data");
    mkdirSync(path.join(chromeRoot, "Default"), { recursive: true });
    expect(resolveBrowserProfile("chrome", { localAppData })).toEqual({ channel: "chrome", directory: path.join(chromeRoot, "Default"), profileName: "Default" });
  });

  it("explains a missing Chrome installation or first-run profile", () => {
    expect(() => resolveBrowserProfile("chrome", { localAppData })).toThrow(/未检测到 Google Chrome 的本地配置/);
  });

  it("uses registered Chrome profiles when Default and last_used are absent", () => {
    const chromeRoot = path.join(localAppData, "Google", "Chrome", "User Data");
    mkdirSync(path.join(chromeRoot, "Profile 3"), { recursive: true });
    writeFileSync(path.join(chromeRoot, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 3": { name: "User" } } } }));
    expect(resolveBrowserProfile("chrome", { localAppData }).profileName).toBe("Profile 3");
  });

  it("prefers a valid last-active directory over a stale last-used directory", () => {
    writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { last_used: "Profile 99", last_active_profiles: ["../../outside", "Profile 1"] } }));
    expect(profile().profileName).toBe("Profile 1");
  });

  it.each(["Work.Profile", "工作"])("supports safe dotted and Unicode profile names %j from settings and metadata", (profileName) => {
    const selectedDirectory = path.join(root, profileName);
    mkdirSync(selectedDirectory);
    expect(profile(profileName)).toEqual({ channel: "msedge", directory: selectedDirectory, profileName });
    writeFileSync(path.join(root, "Local State"), JSON.stringify({ profile: { last_used: profileName } }));
    expect(profile()).toEqual({ channel: "msedge", directory: selectedDirectory, profileName });
  });

  it("falls back to Default for missing, corrupt, unsafe, or missing-profile metadata", () => {
    for (const value of ["invalid json", JSON.stringify({ profile: { last_used: "../../outside" } }), JSON.stringify({ profile: { last_used: "Profile 99" } })]) {
      writeFileSync(path.join(root, "Local State"), value);
      expect(profile().profileName).toBe("Default");
    }
    rmSync(path.join(root, "Local State"));
    expect(profile().profileName).toBe("Default");
  });

  it.each(["../outside", "..\\outside", "C:\\outside", "", ".", "..", "Default:stream", "Default/child", "Bad<name", "Bad>name", 'Bad"name', "Bad|name", "Bad?name", "Bad*name", "Bad\u0000name", "Bad\u001fname", "x".repeat(81)])("rejects unsafe explicit profile %j", (profileName) => {
    expect(resolveBrowserProfile).toBeTypeOf("function");
    expect(() => profile(profileName)).toThrow(/profile/i);
  });

  it("rejects unsupported browsers, missing profiles and arbitrary query directories", () => {
    expect(() => resolveBrowserProfile("firefox", { localAppData })).toThrow(/browser|channel/i);
    expect(() => profile("Profile 99")).toThrow(/profile.*not found|profile.*exist/i);
    expect(() => searchBrowserHistory({ channel: "msedge", directory, profileName: "Profile 1" })).toThrow(/resolved|profile/i);
  });

  it("rejects a profile junction escaping the browser user-data root", () => {
    const outside = path.join(localAppData, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, "Linked"), "junction");
    expect(() => profile("Linked")).toThrow(/profile.*not found/i);
  });
});

describe("read-only browser history", () => {
  it("returns recent safe URLs in newest order with ISO timestamps, bounded before unsafe rows", () => {
    seedHistory().close();
    const results = searchBrowserHistory(profile(), { limit: 2 });
    expect(results.map((item: { title: string }) => item.title)).toEqual(["Newest", "100%_literal"]);
    expect(results[0]).toEqual({ url: "https://example.org/latest", title: "Newest", visitedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect(searchBrowserHistory(profile(), { days: 365 })).toHaveLength(4);
  });

  it("treats SQL wildcard and injection characters literally and searches URL or title", () => {
    seedHistory().close();
    expect(searchBrowserHistory(profile(), { query: "100%_" })).toHaveLength(1);
    expect(searchBrowserHistory(profile(), { query: "EXAMPLE.ORG/latest" })).toHaveLength(1);
    expect(searchBrowserHistory(profile(), { query: "' OR 1=1 --" })).toEqual([]);
    expect(searchBrowserHistory(profile(), { query: "missing" })).toEqual([]);
  });

  it("matches non-ASCII letter case and preserves 64-bit Chromium visit precision", () => {
    const db = seedHistory();
    const visited = Date.now() - 1000;
    db.prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)").run("https://example.org/unicode", "ÉCOLE", BigInt(visited + epoch) * 1000n + 456n);
    db.close();
    expect(searchBrowserHistory(profile(), { query: "école" })).toEqual([{ url: "https://example.org/unicode", title: "ÉCOLE", visitedAt: new Date(visited).toISOString() }]);
  });

  it("does not change the source bytes or create sidecars", () => {
    seedHistory().close();
    const before = readFileSync(path.join(directory, "History"));
    const files = readdirSync(directory);
    searchBrowserHistory(profile());
    expect(readFileSync(path.join(directory, "History"))).toEqual(before);
    expect(readdirSync(directory)).toEqual(files);
  });

  it("reads committed WAL records from a live database without changing its original files", () => {
    const db = seedHistory(true);
    try {
      const files = ["History", "History-wal", "History-shm"];
      const before = files.map((name) => readFileSync(path.join(directory, name)));
      expect(searchBrowserHistory(profile(), { query: "Newest" })).toHaveLength(1);
      files.forEach((name, index) => expect(readFileSync(path.join(directory, name))).toEqual(before[index]));
    } finally { db.close(); }
  });

  it("reads a copied WAL database when no source shm exists, without creating source files", () => {
    const db = seedHistory(true);
    const snapshot = path.join(root, "Default");
    try {
      copyFileSync(path.join(directory, "History"), path.join(snapshot, "History"));
      copyFileSync(path.join(directory, "History-wal"), path.join(snapshot, "History-wal"));
      const before = readdirSync(snapshot);
      expect(searchBrowserHistory(profile("Default"), { query: "Newest" })).toHaveLength(1);
      expect(readdirSync(snapshot)).toEqual(before);
    } finally { db.close(); }
  });

  it("retries a database changed during copying and removes its temporary snapshot", () => {
    seedHistory().close();
    const writer = new DatabaseSync(path.join(directory, "History"));
    const copy = fs.copyFileSync;
    let changed = false;
    const createTemp = vi.spyOn(fs, "mkdtempSync");
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation((source, target, mode) => {
      copy(source, target, mode);
      if (!changed && source === path.join(directory, "History")) {
        changed = true;
        writer.prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)").run("https://example.org/new", "After copy", chromeTime(Date.now() - 1000));
      }
    });
    try {
      expect(searchBrowserHistory(profile(), { query: "After copy" })).toHaveLength(1);
      expect(copySpy.mock.calls.filter(([source]) => source === path.join(directory, "History"))).toHaveLength(2);
      const snapshot = createTemp.mock.results[0].value as string;
      expect(path.isAbsolute(snapshot)).toBe(true);
      expect(existsSync(snapshot)).toBe(false);
    } finally { writer.close(); }
  });

  it("removes temporary data and gives an actionable error when history is corrupt", () => {
    writeFileSync(path.join(directory, "History"), "corrupt synthetic database");
    const createTemp = vi.spyOn(fs, "mkdtempSync");
    expect(() => searchBrowserHistory(profile())).toThrow(/close.*browser.*retry/i);
    expect(existsSync(createTemp.mock.results[0].value as string)).toBe(false);
  });
});

describe("read-only browser bookmarks", () => {
  beforeEach(() => {
    writeFileSync(path.join(directory, "Bookmarks"), JSON.stringify({ roots: {
      bookmark_bar: { type: "folder", name: "Favorites", children: [
        { type: "url", name: "News", url: "HTTPS://EXAMPLE.ORG" },
        { type: "folder", name: "Work", children: [ { type: "url", name: "Docs", url: "https://example.org/docs" } ] },
        { type: "url", name: "Script", url: "javascript:alert(1)" },
        { type: "url", name: "Credentials", url: "https://user:password@example.org" },
      ] }, other: { type: "folder", name: "Other", children: [] },
    } }));
  });

  it("returns safe normalized URLs and nested folder paths without changing bookmarks", () => {
    const before = readFileSync(path.join(directory, "Bookmarks"));
    expect(searchBrowserBookmarks(profile())).toEqual([
      { url: "https://example.org/", title: "News", folder: "Favorites" },
      { url: "https://example.org/docs", title: "Docs", folder: "Favorites/Work" },
    ]);
    expect(readFileSync(path.join(directory, "Bookmarks"))).toEqual(before);
  });

  it("filters by title, URL or folder with a bounded result and supports no match", () => {
    expect(searchBrowserBookmarks(profile(), { query: "work", limit: 1 })).toEqual([{ url: "https://example.org/docs", title: "Docs", folder: "Favorites/Work" }]);
    expect(searchBrowserBookmarks(profile(), { query: "EXAMPLE.ORG", limit: 1 })).toHaveLength(1);
    expect(searchBrowserBookmarks(profile(), { query: "missing" })).toEqual([]);
  });
});

describe("query validation and missing files", () => {
  it.each([{ query: "x".repeat(201) }, { query: 4 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: NaN }, { limit: "2" }, { days: 0 }, { days: 366 }, { days: 1.5 }])("rejects invalid history arguments %j", (options) => {
    expect(() => searchBrowserHistory(profile(), options)).toThrow(/query|limit|days/i);
  });

  it.each([{ query: "x".repeat(201) }, { query: null }, { limit: 0 }, { limit: 101 }, { limit: Infinity }])("rejects invalid bookmark arguments %j", (options) => {
    expect(() => searchBrowserBookmarks(profile(), options)).toThrow(/query|limit/i);
  });

  it("reports which selected profile has no history or bookmarks", () => {
    expect(() => searchBrowserHistory(profile())).toThrow(/history.*Profile 1.*(open|visit|browser)/i);
    expect(() => searchBrowserBookmarks(profile())).toThrow(/bookmarks.*Profile 1.*(add|save|browser)/i);
  });
});
