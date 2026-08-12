import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SkillInfo = {
  name: string;
  scope: "user" | "project";
  path: string;
};

/** User-level skills directory (~/.claude/skills). */
export function userSkillsDir(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

/** Project-level skills directory (<cwd>/.claude/skills). */
export function projectSkillsDir(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return path.join(cwd, ".claude", "skills");
}

/** A directory is a skill when it contains SKILL.md. */
function isSkillDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

function scanDir(dir: string, scope: "user" | "project"): SkillInfo[] {
  const out: SkillInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (isSkillDir(full)) {
      out.push({ name: e.name, scope, path: full });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** All installed skills (user scope first, then project). */
export function listSkills(cwd: string | null | undefined): {
  userDir: string;
  projectDir: string | null;
  skills: SkillInfo[];
} {
  const userDir = userSkillsDir();
  const projectDir = projectSkillsDir(cwd);
  const skills = [
    ...scanDir(userDir, "user"),
    ...(projectDir ? scanDir(projectDir, "project") : []),
  ];
  return { userDir, projectDir, skills };
}

/** Ensure a skills dir exists and return it (for "open folder"). */
export function ensureSkillsDir(scope: "user" | "project", cwd?: string | null): string {
  const dir = scope === "user" ? userSkillsDir() : projectSkillsDir(cwd);
  if (!dir) throw new Error("No project open");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Delete an installed skill. Safety: only deletes directories that look like
 * a skill (contain SKILL.md) and live under the expected skills root.
 */
export function deleteSkill(
  name: string,
  scope: "user" | "project",
  cwd?: string | null,
): { ok: boolean; error?: string } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    return { ok: false, error: "Invalid skill name" };
  }
  const root = scope === "user" ? userSkillsDir() : projectSkillsDir(cwd);
  if (!root) return { ok: false, error: "No project open" };
  const target = path.join(root, name);
  // Must stay inside the skills root and actually be a skill.
  if (path.dirname(target) !== path.resolve(root) && path.dirname(target) !== root) {
    return { ok: false, error: "Path escapes skills directory" };
  }
  if (!isSkillDir(target)) {
    return { ok: false, error: "Not an installed skill (missing SKILL.md)" };
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
