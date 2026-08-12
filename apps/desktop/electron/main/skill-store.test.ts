import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteSkill, listSkills } from "./skill-store";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dirs.length = 0;
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  dirs.push(d);
  return d;
}

describe("skill-store", () => {
  it("lists project skills with SKILL.md only", () => {
    const cwd = tmp();
    const skillsRoot = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(path.join(skillsRoot, "pdf"), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, "pdf", "SKILL.md"), "# pdf");
    fs.mkdirSync(path.join(skillsRoot, "not-a-skill"), { recursive: true });

    const res = listSkills(cwd);
    const projectSkills = res.skills.filter((s) => s.scope === "project");
    expect(projectSkills).toHaveLength(1);
    expect(projectSkills[0]).toMatchObject({ name: "pdf", scope: "project" });
    expect(res.projectDir).toBe(skillsRoot);
  });

  it("deleteSkill removes a real skill and refuses non-skill dirs", () => {
    const cwd = tmp();
    const skillsRoot = path.join(cwd, ".claude", "skills");
    fs.mkdirSync(path.join(skillsRoot, "demo"), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, "demo", "SKILL.md"), "# demo");
    fs.mkdirSync(path.join(skillsRoot, "plain"), { recursive: true });

    expect(deleteSkill("demo", "project", cwd).ok).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, "demo"))).toBe(false);

    const bad = deleteSkill("plain", "project", cwd);
    expect(bad.ok).toBe(false);
    expect(fs.existsSync(path.join(skillsRoot, "plain"))).toBe(true);
  });

  it("deleteSkill rejects traversal-ish names", () => {
    const cwd = tmp();
    expect(deleteSkill("..", "project", cwd).ok).toBe(false);
    expect(deleteSkill("a/b", "project", cwd).ok).toBe(false);
  });
});
