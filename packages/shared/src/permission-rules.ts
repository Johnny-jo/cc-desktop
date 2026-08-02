export type SessionAllowRule = {
  toolName: string;
  pathPrefix?: string;
  commandPrefix?: string;
};

const DESTRUCTIVE =
  /\b(rm\s+-rf|rm\s+-fr|del\s+\/s|format\s+|mkfs\.|Remove-Item\s+-Recurse\s+-Force)\b/i;

export function isDestructiveBash(command: string): boolean {
  return DESTRUCTIVE.test(command);
}

export function matchSessionRule(
  rules: SessionAllowRule[],
  input: { toolName: string; path?: string; command?: string },
): boolean {
  return rules.some((r) => {
    if (r.toolName !== input.toolName) return false;
    if (r.pathPrefix != null) {
      if (!input.path || !input.path.replace(/\\/g, "/").startsWith(r.pathPrefix.replace(/\\/g, "/"))) {
        return false;
      }
    }
    if (r.commandPrefix != null) {
      if (!input.command || !input.command.startsWith(r.commandPrefix)) return false;
    }
    return true;
  });
}

export function ruleFromToolInput(
  toolName: string,
  input: Record<string, unknown>,
): SessionAllowRule {
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    const path = String(input.file_path ?? input.path ?? "");
    const normalized = path.replace(/\\/g, "/");
    const dir = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/") + 1)
      : "";
    return { toolName, pathPrefix: dir || normalized };
  }
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    return { toolName, commandPrefix: command.slice(0, 40) };
  }
  return { toolName };
}
