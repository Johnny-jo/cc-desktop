import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Project file index for @-mention autocomplete.
 *
 * Lazily enumerates files under the project root with a BFS walk, skipping
 * dependency/build dirs, then caches the result briefly so repeated keystrokes
 * don't re-walk the tree. Hard caps bound worst-case cost on huge repos.
 */

/** Directories never descended into (dependencies, build output, VCS, caches). */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  "coverage",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".idea",
  ".vscode",
]);

/** Stop enumerating once this many files have been collected. */
const MAX_FILES = 5000;
/** Stop enumerating after this long even if MAX_FILES not reached. */
const MAX_WALK_MS = 3000;
/** Cache a walked tree for this long before re-walking. */
const CACHE_TTL_MS = 30 * 1000;
/** Directories read concurrently during the walk. */
const WALK_CONCURRENCY = 8;

type CacheEntry = { files: string[]; truncated: boolean; at: number };

const cache = new Map<string, CacheEntry>();

/** Clear the index cache (exposed for tests). */
export function clearFileIndexCache(): void {
  cache.clear();
}

async function walkProject(cwd: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const start = Date.now();
  let truncated = false;

  // BFS queue of absolute dir paths still to read.
  const queue: string[] = [cwd];

  const readDir = async (dir: string): Promise<string[]> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      if (truncated) break;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) subdirs.push(abs);
      } else if (e.isFile()) {
        files.push(path.relative(cwd, abs));
        if (files.length >= MAX_FILES) truncated = true;
      }
    }
    return subdirs;
  };

  // Process the queue with a small concurrency pool.
  while (queue.length && !truncated) {
    if (Date.now() - start > MAX_WALK_MS) {
      truncated = true;
      break;
    }
    const batch = queue.splice(0, WALK_CONCURRENCY);
    const results = await Promise.all(batch.map(readDir));
    for (const subdirs of results) queue.push(...subdirs);
  }

  files.sort();
  return { files, truncated };
}

function rankMatch(rel: string, query: string): number {
  // Prefer matches in the basename over matches deeper in the path; then
  // earlier occurrence; then shorter path. Lower is better.
  const lower = rel.toLowerCase();
  const q = query.toLowerCase();
  const base = path.basename(lower);
  const baseIdx = base.indexOf(q);
  const pathIdx = lower.indexOf(q);
  const inBase = baseIdx >= 0;
  const idx = inBase ? baseIdx : pathIdx;
  return (inBase ? 0 : 1_000_000) + (idx < 0 ? 999_999 : idx) * 1000 + rel.length / 1000;
}

/**
 * List project files, optionally filtered by a case-insensitive substring.
 * Returns paths relative to cwd, best matches first.
 */
export async function listProjectFiles(
  cwd: string,
  query = "",
  limit = 50,
): Promise<{ files: string[]; truncated?: boolean }> {
  const cached = cache.get(cwd);
  let entry: CacheEntry;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    entry = cached;
  } else {
    const { files, truncated } = await walkProject(cwd);
    entry = { files, truncated, at: Date.now() };
    cache.set(cwd, entry);
  }

  let result = entry.files;
  let truncated = entry.truncated;

  if (query) {
    const q = query.toLowerCase();
    result = result
      .filter((f) => f.toLowerCase().includes(q))
      .sort((a, b) => rankMatch(a, query) - rankMatch(b, query));
  }

  if (result.length > limit) {
    result = result.slice(0, limit);
    truncated = true;
  }

  return { files: result, ...(truncated ? { truncated: true } : {}) };
}
