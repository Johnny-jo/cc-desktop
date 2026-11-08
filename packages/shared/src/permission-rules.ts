export type SessionAllowRule = {
  toolName: string;
  pathPrefix?: string;
  commandPrefix?: string;
  commandExact?: string;
};

const DESTRUCTIVE =
  /\b(rm\s+-rf|rm\s+-fr|del\s+\/s|format\s+|mkfs\.|Remove-Item\s+-Recurse\s+-Force)\b/i;

export function isDestructiveBash(command: string): boolean {
  return DESTRUCTIVE.test(command);
}

// Only extend a literal command with ordinary argument words. Operators,
// substitutions, newlines, quoting and globbing need a separate decision.
const SIMPLE_COMMAND = /^[\w./:@%,+-]+(?: +[\w./:@%,+=-]+)*$/;
function matchesCommandPrefix(prefix: string, command?: string): boolean {
  const value = command?.trim();
  return !!value && (value === prefix || (value.startsWith(prefix + " ") && SIMPLE_COMMAND.test(value)));
}

export function matchSessionRule(
  rules: SessionAllowRule[],
  input: { toolName: string; path?: string; command?: string },
): boolean {
  return rules.some((r) => {
    if (r.toolName !== input.toolName) return false;
    if (r.commandExact !== undefined && input.command?.trim() !== r.commandExact) return false;
    if (r.pathPrefix != null) {
      if (!input.path || !input.path.replace(/\\/g, "/").startsWith(r.pathPrefix.replace(/\\/g, "/"))) {
        return false;
      }
    }
    if (r.commandPrefix != null) {
      if (!matchesCommandPrefix(r.commandPrefix, input.command)) return false;
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
    const command = String(input.command ?? "").trim();
    return SIMPLE_COMMAND.test(command) ? { toolName, commandPrefix: command } : { toolName, commandExact: command };
  }
  if (toolName === "PowerShell") {
    return { toolName, commandExact: String(input.command ?? "").trim() };
  }
  return { toolName };
}

/**
 * Persisted permission rule, Claude Code settings.json style:
 *   "Edit"            — bare tool name matches all uses
 *   "Edit(src/**)"    — path glob (matched against normalized / paths)
 *   "Bash(npm run *)" — command glob; without wildcards acts as a prefix
 *   "Bash(git status:*)" — generated simple command with optional argument words
 *   "Bash(=ls *.md)" / "PowerShell(Get-Item *.md)" — literal approved script
 */
export type PersistedPermissionRule = {
  toolName: string;
  spec?: string;
};

export function parsePermissionRule(
  raw: string,
): PersistedPermissionRule | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\(([\s\S]+)\))?$/);
  if (!m) return null;
  const rule: PersistedPermissionRule = { toolName: m[1]! };
  if (m[2] != null) {
    const spec = m[2].trim();
    if (!spec) return null;
    rule.spec = spec;
  }
  return rule;
}

export function normalizeRuleString(raw: string): string | null {
  const r = parsePermissionRule(raw);
  if (!r) return null;
  return r.spec != null ? `${r.toolName}(${r.spec})` : r.toolName;
}

/** Tiny glob matcher: `*` (any run, incl. /) and `?` (single char). */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return re.test(value);
}

/**
 * Match one persisted rule against a tool invocation. Returns false when the
 * rule has a spec but the invocation lacks the corresponding value.
 */
export function matchPersistedRule(
  rule: PersistedPermissionRule,
  input: { toolName: string; path?: string; command?: string },
): boolean {
  if (rule.toolName !== input.toolName) return false;
  if (rule.spec == null) return true;
  // PowerShell commands may contain wildcards, pipes, newlines and Windows
  // paths. Treat the approved script literally, including its backslashes.
  if (rule.toolName === "PowerShell") return input.command?.trim() === rule.spec;
  if (rule.toolName === "Bash" && rule.spec.startsWith("=")) return input.command?.trim() === rule.spec.slice(1);
  if (rule.toolName === "Bash" && rule.spec.endsWith(":*") && SIMPLE_COMMAND.test(rule.spec.slice(0, -2))) {
    return matchesCommandPrefix(rule.spec.slice(0, -2), input.command);
  }
  const spec = rule.spec.replace(/\\/g, "/");
  if (rule.toolName === "Bash") {
    if (!input.command) return false;
    if (!/[*?]/.test(spec)) return input.command.startsWith(spec);
    return globMatch(spec, input.command);
  }
  // File tools (Edit/Write/Read/NotebookEdit…): match against path.
  if (!input.path) return false;
  const p = input.path.replace(/\\/g, "/");
  if (!/[*?]/.test(spec)) return p.startsWith(spec);
  return globMatch(spec, p);
}

/** Parse + match a list of rule strings (as stored in settings). */
export function matchPersistedRules(
  rules: string[],
  input: { toolName: string; path?: string; command?: string },
): boolean {
  for (const raw of rules) {
    const r = parsePermissionRule(raw);
    if (r && matchPersistedRule(r, input)) return true;
  }
  return false;
}
