import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readClaudeCodeModel,
  writeClaudeCodeModel,
} from "./claude-settings-sync";

describe("claude-settings-sync", () => {
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

  function tmpFile(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "cd-claude-settings-"));
    dirs.push(d);
    return path.join(d, "settings.json");
  }

  it("reads model from Claude Code settings.json", () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ env: { X: "1" }, model: "k3" }), "utf8");
    expect(readClaudeCodeModel(file)).toBe("k3");
  });

  it("writes model without dropping other keys", () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "grok-4.5" }, model: "k3" }, null, 2),
      "utf8",
    );
    writeClaudeCodeModel("grok-4.6", file);
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
      env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: string };
      model: string;
    };
    expect(data.model).toBe("grok-4.6");
    expect(data.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("grok-4.5");
  });

  it("returns null when file is missing", () => {
    expect(readClaudeCodeModel(tmpFile())).toBeNull();
  });
});
