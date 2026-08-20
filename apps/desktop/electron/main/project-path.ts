import path from "node:path";

/** Minimal path API so tests can inject path.win32 / path.posix. */
export type PathApi = {
  sep: string;
  resolve: (...parts: string[]) => string;
  relative: (from: string, to: string) => string;
  isAbsolute: (p: string) => boolean;
};

/**
 * Resolve `rel` under `cwd`. Returns the absolute target, or null if it
 * would escape the project root.
 *
 * Windows specifics the old `startsWith(base + sep)` check got wrong:
 * - drive-letter case (`D:\` vs `d:\`) is not significant
 * - a leading `/` or `\` is "absolute from the current drive root", so
 *   renderer-supplied `/docs/a.md` was rewritten to `D:\docs\a.md`
 */
export function resolveInside(
  cwd: string,
  rel: string,
  pathApi: PathApi = path,
): string | null {
  if (!cwd) return null;
  const base = pathApi.resolve(stripLongPathPrefix(cwd, pathApi));
  const input = coerceRel(rel ?? "", pathApi, base);
  const target = pathApi.resolve(base, input || ".");
  if (!contained(base, target, pathApi)) return null;
  return target;
}

function contained(base: string, target: string, pathApi: PathApi): boolean {
  const relToBase = pathApi.relative(base, target);
  if (!relToBase) return true;
  if (pathApi.isAbsolute(relToBase)) return false;
  if (relToBase === ".." || relToBase.startsWith(".." + pathApi.sep)) {
    return false;
  }
  return true;
}

/** `\\?\D:\foo` / `//?/D:/foo` → `D:\foo` so relative() can compare. */
function stripLongPathPrefix(p: string, pathApi: PathApi): string {
  if (pathApi.sep !== "\\") return p;
  if (p.startsWith("\\\\?\\")) return p.slice(4);
  if (p.startsWith("//?/")) return p.slice(4);
  return p;
}

/**
 * On Windows, `/docs/a.md` and `\docs\a.md` are drive-root absolute.
 * The editor/changes panel means "project-relative" — strip the prefix
 * unless this is a real drive-letter, UNC, or Git-bash `/d/proj/...` path.
 */
function coerceRel(rel: string, pathApi: PathApi, base: string): string {
  const stripped = stripLongPathPrefix(rel, pathApi);
  if (pathApi.sep !== "\\") return stripped;
  if (/^[a-zA-Z]:[\\/]/.test(stripped)) return stripped;
  if (stripped.startsWith("\\\\") || stripped.startsWith("//")) return stripped;
  const msys = msysDriveAbs(stripped);
  if (msys) {
    const trial = pathApi.resolve(msys);
    if (contained(base, trial, pathApi)) return msys;
  }
  return stripped.replace(/^[\\/]+/, "");
}

/** `/d/foo` or `\d\foo` or `d/foo` → `d:/foo` (Git bash / MSYS). */
function msysDriveAbs(rel: string): string | null {
  const s = rel.replace(/\\/g, "/");
  const m = s.match(/^\/?([a-zA-Z])\/(.*)$/);
  if (!m) return null;
  return `${m[1]}:/${m[2]}`;
}
