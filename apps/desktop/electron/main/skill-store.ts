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
 * Retired app-generated skill. Keep the exact old content for migration only:
 * workspace rules now live inline in the room session prompt.
 */
export const BUILTIN_PATH_GUARD_SKILL = "room-workspace-guard";

export const LEGACY_PATH_GUARD_SKILL_MD = `---
name: ${BUILTIN_PATH_GUARD_SKILL}
description: 群聊/远程执行时的工作区路径守卫规则。当任务来自群聊房间、或提示词提到"路径守卫"时必读。
---

# 工作区路径守卫

你在群聊房间里被派任务时，工作区主人启用了路径守卫：

1. 所有文件操作（Read/Write/Edit/MultiEdit/Glob/Grep/LS）必须限制在主人打开的项目目录内，越界会被直接拒绝。
2. Bash 命令同样受限：命令中出现目录外的绝对路径、\`..\` 逃逸、\`~\` 或 \`$HOME\` 主目录、\`cd\`/\`pushd\` 到目录外，都会被直接拒绝。
3. 被拒绝后不要换招绕过（换工具、拼相对路径、先写临时目录再移动、用 python/node 写文件，都算违规且同样会被拦）。
4. 正确做法：在允许的项目目录内完成任务；确需访问目录外内容时，在回复里向工作区主人说明理由和具体路径，由主人决定。
`;

export function retireBuiltinPathGuardSkill(): void {
  try {
    const dir = path.join(userSkillsDir(), BUILTIN_PATH_GUARD_SKILL);
    const file = path.join(dir, "SKILL.md");
    // Never follow a linked directory/file or remove user-customized content.
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(file).isFile()) return;
    const content = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    if (content !== LEGACY_PATH_GUARD_SKILL_MD) return;
    // Only remove the known generated entry point; preserve sibling files.
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Could not retire built-in workspace guard skill:", err);
    }
  }
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
