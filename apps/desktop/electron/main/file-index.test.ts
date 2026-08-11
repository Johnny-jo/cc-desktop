import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearFileIndexCache, listProjectFiles } from "./file-index";

describe("file-index listProjectFiles", () => {
  const dirs: string[] = [];

  afterEach(() => {
    clearFileIndexCache();
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    dirs.length = 0;
  });

  function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "file-index-"));
    dirs.push(d);
    return d;
  }

  function write(root: string, rel: string): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x");
  }

  it("enumerates files recursively, returning paths relative to cwd", async () => {
    const root = tmpDir();
    write(root, "src/index.ts");
    write(root, "src/lib/util.ts");
    write(root, "README.md");

    const { files, truncated } = await listProjectFiles(root);
    expect(files).toContain("README.md");
    expect(files.some((f) => f.endsWith("index.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("util.ts"))).toBe(true);
    expect(truncated).toBeUndefined();
  });

  it("skips ignored directories like node_modules and .git", async () => {
    const root = tmpDir();
    write(root, "src/app.ts");
    write(root, "node_modules/pkg/index.js");
    write(root, ".git/config");
    write(root, "dist/bundle.js");

    const { files } = await listProjectFiles(root);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes(".git"))).toBe(false);
    expect(files.some((f) => f.includes("dist"))).toBe(false);
    expect(files.some((f) => f.endsWith("app.ts"))).toBe(true);
  });

  it("filters by case-insensitive substring and prefers basename matches", async () => {
    const root = tmpDir();
    write(root, "src/components/Composer.tsx");
    write(root, "src/lib/composer-utils.ts");
    write(root, "docs/comp/notes.md");

    const { files } = await listProjectFiles(root, "comp");
    expect(files.length).toBeGreaterThan(0);
    // basename match (Composer.tsx / composer-utils.ts) should outrank a
    // match that only appears in a directory segment (docs/comp/...).
    const firstBase = path.basename(files[0]).toLowerCase();
    expect(firstBase.includes("comp")).toBe(true);
  });

  it("respects the result limit and reports truncation", async () => {
    const root = tmpDir();
    for (let i = 0; i < 20; i++) {
      write(root, `f/file-${String(i).padStart(2, "0")}.txt`);
    }

    const { files, truncated } = await listProjectFiles(root, "", 5);
    expect(files).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it("serves subsequent queries from cache without re-walking", async () => {
    const root = tmpDir();
    write(root, "src/a.ts");

    const first = await listProjectFiles(root);
    // Add a file after the first walk; a cached second call must NOT see it.
    write(root, "src/b.ts");
    const second = await listProjectFiles(root);

    expect(first.files).toEqual(second.files);
    expect(second.files.some((f) => f.endsWith("b.ts"))).toBe(false);

    // After clearing the cache the new file appears.
    clearFileIndexCache();
    const third = await listProjectFiles(root);
    expect(third.files.some((f) => f.endsWith("b.ts"))).toBe(true);
  });
});
