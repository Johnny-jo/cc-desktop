import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

type ClaudeSettingsFile = {
  model?: unknown;
  [key: string]: unknown;
};

export function readClaudeCodeModel(filePath = claudeSettingsPath()): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as ClaudeSettingsFile;
    return typeof data.model === "string" && data.model.trim()
      ? data.model.trim()
      : null;
  } catch {
    return null;
  }
}

export function writeClaudeCodeModel(
  model: string,
  filePath = claudeSettingsPath(),
): void {
  const next = model.trim();
  if (!next) return;
  let data: ClaudeSettingsFile = {};
  try {
    if (fs.existsSync(filePath)) {
      data = JSON.parse(fs.readFileSync(filePath, "utf8")) as ClaudeSettingsFile;
    }
  } catch {
    data = {};
  }
  if (data.model === next) return;
  data.model = next;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function watchClaudeCodeModel(
  onChange: (model: string) => void,
  filePath = claudeSettingsPath(),
): () => void {
  let last = readClaudeCodeModel(filePath);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    const model = readClaudeCodeModel(filePath);
    if (!model || model === last) return;
    last = model;
    onChange(model);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, 120);
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const watcher = fs.watch(path.dirname(filePath), (event, filename) => {
      if (!filename || filename.toString() !== path.basename(filePath)) return;
      if (event === "change" || event === "rename") schedule();
    });
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  } catch {
    return () => {
      if (timer) clearTimeout(timer);
    };
  }
}
