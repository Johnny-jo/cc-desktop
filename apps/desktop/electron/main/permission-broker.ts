import { randomUUID } from "node:crypto";
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "@claude-desktop/shared";
import {
  isDestructiveBash,
  matchPersistedRules,
  matchSessionRule,
  normalizeRuleString,
  ruleFromToolInput,
  type SessionAllowRule,
} from "@claude-desktop/shared";

export type ToolPermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message?: string };

export type PermissionBrokerDeps = {
  getMode: () => PermissionMode;
  requestFromUi: (req: PermissionRequest) => void;
  onResolved?: (requestId: string, sessionId: string) => void;
  /** Persisted Claude Code-style rules from settings (allow wins after deny) */
  getAllowRules?: () => string[];
  getDenyRules?: () => string[];
  /** Persist an allow rule ("Always allow" in the UI) */
  onAddAllowRule?: (rule: string) => void;
  timeoutMs?: number;
};

type PendingEntry = {
  resolve: (result: ToolPermissionResult) => void;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
  detachAbort: () => void;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Read-only / harmless tools that never require a permission prompt, in any
 * mode. TodoWrite is pure in-memory agent state (no file side effects),
 * matching Claude Code. This is a second direct-allow layer on top of the SDK
 * `allowedTools` list — the broker evaluates tools independently, so without
 * this these read-only tools would still hit the modal under `default` mode.
 */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  // In-memory task/todo state — no file side effects, like TodoWrite.
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

function extractMatchInput(
  toolName: string,
  input: Record<string, unknown>,
): { toolName: string; path?: string; command?: string } {
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    const path = String(input.file_path ?? input.path ?? "");
    return { toolName, path: path || undefined };
  }
  if (toolName === "Bash" || toolName === "PowerShell") {
    const command = String(input.command ?? "");
    return { toolName, command: command || undefined };
  }
  return { toolName };
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" || toolName === "PowerShell") {
    return String(input.command ?? "").slice(0, 120);
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    return String(input.file_path ?? input.path ?? "");
  }
  return toolName;
}

export class PermissionBroker {
  private readonly getMode: PermissionBrokerDeps["getMode"];
  private readonly requestFromUi: PermissionBrokerDeps["requestFromUi"];
  private readonly getAllowRules: () => string[];
  private readonly getDenyRules: () => string[];
  private readonly onAddAllowRule: ((rule: string) => void) | undefined;
  private readonly timeoutMs: number;
  private readonly onResolved: PermissionBrokerDeps["onResolved"];

  private readonly rules = new Map<string, SessionAllowRule[]>();
  private readonly pending = new Map<string, PendingEntry>();

  constructor(deps: PermissionBrokerDeps) {
    this.getMode = deps.getMode;
    this.onResolved = deps.onResolved;
    this.requestFromUi = deps.requestFromUi;
    this.getAllowRules = deps.getAllowRules ?? (() => []);
    this.getDenyRules = deps.getDenyRules ?? (() => []);
    this.onAddAllowRule = deps.onAddAllowRule;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ToolPermissionResult> {
    if (signal?.aborted) return { behavior: "deny", message: "Permission request cancelled" };
    return this.automaticDecision(toolName, input, sessionId)
      ?? this.askUi(toolName, input, sessionId, signal);
  }

  /** The same policy applies to new calls and to calls already waiting in the queue. */
  private automaticDecision(
    toolName: string, input: Record<string, unknown>, sessionId: string,
  ): ToolPermissionResult | null {
    const mode = this.getMode();
    const matchInput = extractMatchInput(toolName, input);

    // Persisted deny rules hard-block first (silent, by design).
    if (matchPersistedRules(this.getDenyRules(), matchInput)) {
      return { behavior: "deny", message: `Denied by rule (${toolName})` };
    }

    // Read-only / harmless tools never prompt, regardless of mode. This also
    // covers tools running inside a Task subagent, which otherwise would each
    // hit the modal. (Plan mode below still hard-blocks writes.)
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    // Persisted allow rules auto-approve before mode logic — but never
    // bypass plan mode or destructive-Bash confirmation below.
    const allowedByRule = matchPersistedRules(this.getAllowRules(), matchInput);

    if (
      mode === "plan" &&
      (toolName === "Edit" || toolName === "Write" || toolName === "Bash" || toolName === "PowerShell")
    ) {
      return { behavior: "deny", message: "Plan mode: writes disabled" };
    }

    // Destructive Bash always requires confirmation (even under auto/acceptEdits).
    if ((toolName === "Bash" || toolName === "PowerShell") && isDestructiveBash(String(input.command ?? ""))) {
      return null;
    }

    if (allowedByRule) {
      return { behavior: "allow", updatedInput: input };
    }

    if (
      (mode === "acceptEdits" || mode === "auto") &&
      (toolName === "Edit" || toolName === "Write")
    ) {
      return { behavior: "allow", updatedInput: input };
    }

    if (mode === "auto") {
      // Auto-approve everything except destructive Bash.
      return { behavior: "allow", updatedInput: input };
    }

    if (matchSessionRule(this.rules.get(sessionId) ?? [], matchInput)) {
      return { behavior: "allow", updatedInput: input };
    }

    return null;
  }

  respond(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    if (decision.behavior === "deny") {
      this.finish(requestId, entry, { behavior: "deny", message: decision.message });
      return true;
    }
    // Don't remove the request (or its timeout) until saving succeeds: a
    // renderer can retry the save or explicitly allow just this invocation.
    let matchesGrant: ((other: PendingEntry) => boolean) | undefined;
    if (decision.scope !== "once" && entry.toolName !== "AskUserQuestion") {
      const rule = ruleFromToolInput(entry.toolName, entry.input);
      if (decision.scope === "session") {
        const list = this.rules.get(entry.sessionId) ?? [];
        list.push(rule);
        this.rules.set(entry.sessionId, list);
        matchesGrant = other => other.sessionId === entry.sessionId &&
          matchSessionRule([rule], extractMatchInput(other.toolName, other.input));
      } else {
        const spec = rule.commandExact !== undefined
          ? (rule.toolName === "Bash" ? "=" : "") + rule.commandExact
          : rule.commandPrefix ? rule.commandPrefix + ":*"
          : rule.pathPrefix ? rule.pathPrefix + "**" : undefined;
        const raw = spec === undefined ? rule.toolName : `${rule.toolName}(${spec})`;
        const normalized = normalizeRuleString(raw);
        if (!normalized || !this.onAddAllowRule) throw new Error("Cannot save this permission rule");
        this.onAddAllowRule(normalized);
        matchesGrant = other => matchPersistedRules([normalized], extractMatchInput(other.toolName, other.input));
      }
    }
    this.finish(requestId, entry, { behavior: "allow", updatedInput: decision.updatedInput ?? entry.input });
    if (matchesGrant) {
      for (const [id, other] of this.pending) {
        if (!matchesGrant(other)) continue;
        const result = this.automaticDecision(other.toolName, other.input, other.sessionId);
        if (result) this.finish(id, other, result);
      }
    }
    return true;
  }

  private finish(id: string, entry: PendingEntry, result: ToolPermissionResult): void {
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.detachAbort();
    entry.resolve(result);
    this.onResolved?.(id, entry.sessionId);
  }

  clearSession(sessionId: string): void {
    this.rules.delete(sessionId);
  }

  private askUi(
    toolName: string,
    input: Record<string, unknown>,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ToolPermissionResult> {
    const requestId = randomUUID();
    const req: PermissionRequest = {
      requestId,
      sessionId,
      toolName,
      summary: summarize(toolName, input),
      inputPreview: input,
    };

    return new Promise<ToolPermissionResult>((resolve) => {
      const deny = (message: string) => {
        const entry = this.pending.get(requestId);
        if (entry) this.finish(requestId, entry, { behavior: "deny", message });
      };
      const onAbort = () => deny("Permission request cancelled");
      const timer = setTimeout(() => deny("Permission request timed out"), this.timeoutMs);

      this.pending.set(requestId, {
        resolve,
        sessionId,
        toolName,
        input,
        timer,
        detachAbort: () => signal?.removeEventListener("abort", onAbort),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.requestFromUi(req);
    });
  }
}
