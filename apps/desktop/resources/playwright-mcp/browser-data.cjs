'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const resolvedProfiles = new WeakSet();
const CHROME_EPOCH_MS = 11644473600000;
const DAY_MS = 86400000;

function isProfileName(value) {
  // Keep the name rules aligned with shared mcp-servers.ts:isSafeBrowserProfile.
  return typeof value === 'string' && value.length <= 80 &&
    value !== '.' && value !== '..' && !/[<>:"/\\|?*\u0000-\u001f]/.test(value);
}

function containedIn(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function existingProfile(root, profileName) {
  const directory = path.join(root, profileName);
  try {
    return fs.statSync(directory).isDirectory() && containedIn(fs.realpathSync(root), fs.realpathSync(directory));
  } catch { return false; }
}

/** Resolve a browser-owned profile; query tools never accept a caller-provided filesystem path. */
function resolveBrowserProfile(channel, { profileName, localAppData = process.env.LOCALAPPDATA } = {}) {
  const components = channel === 'msedge' ? ['Microsoft', 'Edge'] : channel === 'chrome' ? ['Google', 'Chrome'] : null;
  if (!components) throw new Error('Unsupported browser channel. Choose msedge or chrome.');
  if (typeof localAppData !== 'string' || !path.isAbsolute(localAppData)) {
    throw new Error('LOCALAPPDATA is unavailable. Open the selected browser on this Windows account first.');
  }
  const root = path.join(localAppData, ...components, 'User Data');
  if (profileName !== undefined && !isProfileName(profileName)) throw new Error('Invalid browser profile name; choose a profile directory such as Default or Profile 1.');
  if (!fs.existsSync(root)) {
    const browser = channel === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
    throw new Error(`未检测到 ${browser} 的本地配置。请先安装并打开一次该浏览器，再重新检测。`);
  }
  if (profileName === undefined) {
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile;
    } catch { /* Missing/corrupt state is common before the browser first opens. */ }
    const cache = metadata?.info_cache;
    const candidates = [metadata?.last_used,
      ...(Array.isArray(metadata?.last_active_profiles) ? metadata.last_active_profiles : []),
      'Default', ...(cache && typeof cache === 'object' && !Array.isArray(cache) ? Object.keys(cache) : [])];
    profileName = candidates.find(candidate => isProfileName(candidate) && existingProfile(root, candidate)) ?? 'Default';
  }
  if (!existingProfile(root, profileName)) {
    throw new Error(`Browser profile ${profileName} was not found for ${channel}. Open that browser profile first or choose an existing profile in settings.`);
  }
  const profile = Object.freeze({ channel, directory: path.join(root, profileName), profileName });
  resolvedProfiles.add(profile);
  return profile;
}

function checkProfile(profile) {
  if (!profile || !resolvedProfiles.has(profile)) throw new Error('Use a browser profile returned by resolveBrowserProfile; arbitrary data paths are not accepted.');
  // Recheck junctions/symlinks in case a selected profile was replaced after resolution.
  if (!existingProfile(path.dirname(profile.directory), profile.profileName)) throw new Error('The selected browser profile is no longer available. Open the browser and select its profile again.');
}

function queryOptions(options, history) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Query options must be an object.');
  const { query = '', limit = 20, days = 30 } = options;
  if (typeof query !== 'string' || query.length > 200) throw new TypeError('query must be a string of at most 200 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100.');
  if (history && (!Number.isInteger(days) || days < 1 || days > 365)) throw new TypeError('days must be an integer from 1 to 365.');
  return { query: query.toLowerCase(), limit, days };
}

function dataFile(profile, name) {
  const filename = path.join(profile.directory, name);
  try {
    if (fs.statSync(filename).isFile() && containedIn(fs.realpathSync(profile.directory), fs.realpathSync(filename))) return filename;
  } catch { /* Report an actionable selected-profile error below. */ }
  throw new Error(`${name} is unavailable for browser profile ${profile.profileName}. Open this browser profile and ${name === 'History' ? 'visit a page' : 'save a bookmark'} first.`);
}

function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function fileSignature(filename) {
  try {
    const stat = fs.statSync(filename, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function cleanupSnapshot(tempRoot, directory) {
  const absolute = path.resolve(directory);
  if (!containedIn(tempRoot, absolute) || !path.basename(absolute).startsWith('agentos-browser-history-')) {
    throw new Error('Refusing to remove browser snapshot outside the checked temporary root.');
  }
  fs.rmSync(absolute, { recursive: true, force: true });
}

function withHistorySnapshot(filename, read) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'agentos-browser-history-'));
  try {
    // Opening a live WAL in place, even read-only, can create or update its -shm.
    // Copy only the history database and recovery journals, never other browser data.
    const suffixes = ['', '-wal', '-journal'];
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = suffixes.map((suffix) => fileSignature(filename + suffix));
      if (!before[0]) throw new Error('History was removed while it was being read.');
      for (const [index, suffix] of suffixes.entries()) {
        const target = path.join(directory, `History${suffix}`);
        if (before[index] !== null) fs.copyFileSync(filename + suffix, target);
        else fs.rmSync(target, { force: true });
      }
      const after = suffixes.map((suffix) => fileSignature(filename + suffix));
      if (before.every((signature, index) => signature === after[index])) { stable = true; break; }
    }
    if (!stable) throw new Error('History is changing too quickly to take a consistent snapshot.');
    const database = new DatabaseSync(path.join(directory, 'History'), { readOnly: true });
    try {
      database.exec('PRAGMA query_only = ON');
      return read(database);
    } finally { database.close(); }
  } catch (error) {
    throw new Error('Unable to read browser history safely. Close the selected browser briefly and retry, or choose another profile.', { cause: error });
  } finally { cleanupSnapshot(tempRoot, directory); }
}

/** Return the most recent visit per URL, with only safe URLs, titles and ISO timestamps. */
function searchBrowserHistory(profile, options = {}) {
  checkProfile(profile);
  const { query, limit, days } = queryOptions(options, true);
  const filename = dataFile(profile, 'History');
  const now = Date.now();
  const cutoff = BigInt(now - days * DAY_MS + CHROME_EPOCH_MS) * 1000n;
  return withHistorySnapshot(filename, (database) => {
    database.function('agentos_safe_url', { deterministic: true }, (url) => safeUrl(url));
    database.function('agentos_lower', { deterministic: true }, (value) => typeof value === 'string' ? value.toLowerCase() : '');
    // instr makes %, _ and SQL syntax literal. Every caller value remains a bound parameter.
    const statement = database.prepare(`
      SELECT agentos_safe_url(url) AS url, COALESCE(title, '') AS title, last_visit_time
      FROM urls
      WHERE last_visit_time >= ? AND last_visit_time <= ?
        AND agentos_safe_url(url) IS NOT NULL
        AND (instr(agentos_lower(title), ?) > 0 OR instr(agentos_lower(url), ?) > 0)
      ORDER BY last_visit_time DESC
      LIMIT ?
    `);
    // Chromium microseconds exceed Number.MAX_SAFE_INTEGER; preserve integers until milliseconds.
    statement.setReadBigInts(true);
    const rows = statement.all(cutoff, BigInt(now + CHROME_EPOCH_MS) * 1000n, query, query, limit);
    return rows.map((row) => ({ url: row.url, title: row.title, visitedAt: new Date(Number(row.last_visit_time / 1000n) - CHROME_EPOCH_MS).toISOString() }));
  });
}

function searchBrowserBookmarks(profile, options = {}) {
  checkProfile(profile);
  const { query, limit } = queryOptions(options, false);
  const filename = dataFile(profile, 'Bookmarks');
  let bookmarks;
  try { bookmarks = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { throw new Error(`Bookmarks could not be read for browser profile ${profile.profileName}. Open the browser and retry after it has saved bookmarks.`, { cause: error }); }
  const results = [];
  const stack = Object.values(bookmarks.roots || {}).reverse().map((node) => ({ node, folders: [] }));
  while (stack.length && results.length < limit) {
    const { node, folders } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'folder') {
      const nested = typeof node.name === 'string' && node.name ? [...folders, node.name] : folders;
      for (const child of [...(Array.isArray(node.children) ? node.children : [])].reverse()) stack.push({ node: child, folders: nested });
    } else if (node.type === 'url') {
      const url = safeUrl(node.url);
      const title = typeof node.name === 'string' ? node.name : '';
      const folder = folders.join('/');
      if (url && [url, title, folder].some((value) => value.toLowerCase().includes(query))) results.push({ url, title, folder });
    }
  }
  return results;
}

module.exports = { resolveBrowserProfile, searchBrowserHistory, searchBrowserBookmarks };
