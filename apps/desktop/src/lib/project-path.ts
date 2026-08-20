/** Join a possibly-relative change path against the project root. */
export function resolvePath(projectPath: string | null, p: string): string {
  if (!projectPath) return p;
  if (isWindowsAbs(p) || isUnc(p)) return p;
  return `${projectPath.replace(/[\\/]+$/, "")}/${p.replace(/^[\\/]+/, "")}`;
}

/**
 * Convert a change path (absolute or relative) to a project-relative path
 * for the in-app editor. Null when it cannot be resolved under the project.
 *
 * Must not return a leading `/` — on Windows `path.resolve(cwd, "/docs/a.md")`
 * jumps to `D:\docs\a.md` and the main-process guard reports "path escapes project".
 */
export function toProjectRel(projectPath: string | null, p: string): string | null {
  if (!projectPath) return null;
  const root = collapse(stripLongPrefix(pSlash(projectPath)).replace(/\/+$/, ""));
  const abs = toAbs(projectPath, p);
  const rootLc = root.toLowerCase();
  const absLc = abs.toLowerCase();
  if (absLc === rootLc) return "";
  const prefix = rootLc + "/";
  if (!absLc.startsWith(prefix)) return null;
  const rel = abs.slice(root.length + 1);
  if (!rel || rel.split("/").includes("..")) return null;
  return rel;
}

function pSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripLongPrefix(p: string): string {
  if (p.startsWith("//?/")) return p.slice(4);
  return p;
}

function isWindowsAbs(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p);
}

function isUnc(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

function toAbs(projectPath: string, p: string): string {
  const s = stripLongPrefix(pSlash(p));
  if (isWindowsAbs(s)) return collapse(s.replace(/\/+$/, ""));
  const root = collapse(stripLongPrefix(pSlash(projectPath)).replace(/\/+$/, ""));
  const msys = msysToWin(s, root);
  if (msys) return msys;
  const stripped = s.replace(/^\/+/, "");
  // `/D:/proj/a.md` (POSIX-wrapped Windows abs) after stripping
  if (isWindowsAbs(stripped)) return collapse(stripped.replace(/\/+$/, ""));
  const msys2 = msysToWin(stripped, root);
  if (msys2) return msys2;
  return collapse(stripped ? `${root}/${stripped}` : root);
}

/** Git-bash `/d/proj/a.md` → `d:/proj/a.md` when that path is under root. */
function msysToWin(s: string, root: string): string | null {
  const m = s.replace(/\\/g, "/").match(/^\/?([a-zA-Z])\/(.*)$/);
  if (!m) return null;
  const candidate = collapse(`${m[1]}:/${m[2]}`);
  const rootLc = root.toLowerCase();
  const candLc = candidate.toLowerCase();
  if (candLc === rootLc || candLc.startsWith(rootLc + "/")) return candidate;
  return null;
}

/** Collapse `.` / `..` / duplicate slashes. Drive-root `..` is dropped. */
function collapse(p: string): string {
  const winAbs = isWindowsAbs(p);
  const parts = p.split("/");
  const out: string[] = [];
  const drive = winAbs ? parts.shift() : undefined;
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(part);
  }
  if (drive != null) return [drive, ...out].join("/");
  return out.join("/");
}
