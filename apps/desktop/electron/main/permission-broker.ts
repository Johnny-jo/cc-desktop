import { randomUUID } from "node:crypto";
import type {
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "@claude-desktop/shared";
import {
  isDestructiveBash,
  matchSessionRule,
  ruleFromToolInput,
  type SessionAllowRule,
} from "@claude-desktop/shared";

export type ToolPermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message?: string };

export type PermissionBrokerDeps = {
  getMode: () => PermissionMode;
  requestFromUi: (req: PermissionRequest) => void;
  timeoutMs?: number;
};

type PendingEntry = {
  resolve: (result: ToolPermissionResult) => void;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function extractMatchInput(
  toolName: string,
  input: Record<string, unknown>,
): { toolName: string; path?: string; command?: string } {
  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    const path = String(input.file_path ?? input.path ?? "");
    return { toolName, path: path || undefined };
  }
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    return { toolName, command: command || undefined };
  }
  return { toolName };
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
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
  private readonly timeoutMs: number;

  private readonly rules = new Map<string, SessionAllowRule[]>();
  private readonly pending = new Map<string, PendingEntry>();

  constructor(deps: PermissionBrokerDeps) {
    this.getMode = deps.getMode;
    this.requestFromUi = deps.requestFromUi;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    sessionId: string,
  ): Promise<ToolPermissionResult> {
    const mode = this.getMode();

    if (
      mode === "plan" &&
      (toolName === "Edit" || toolName === "Write" || toolName === "Bash")
    ) {
      return { behavior: "deny", message: "Plan mode: writes disabled" };
    }

    // Destructive Bash always requires confirmation (even under acceptEdits).
    if (toolName === "Bash" && isDestructiveBash(String(input.command ?? ""))) {
      return this.askUi(toolName, input, sessionId);
    }

    if (mode === "acceptEdits" && (toolName === "Edit" || toolName === "Write")) {
      return { behavior: "allow", updatedInput: input };
    }

    const matchInput = extractMatchInput(toolName, input);
    if (matchSessionRule(this.rules.get(sessionId) ?? [], matchInput)) {
      return { behavior: "allow", updatedInput: input };
    }

    return this.askUi(toolName, input, sessionId);
  }

  respond(requestId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    if (decision.behavior === "allow") {
      if (decision.scope === "session") {
        const list = this.rules.get(entry.sessionId) ?? [];
        list.push(ruleFromToolInput(entry.toolName, entry.input));
        this.rules.set(entry.sessionId, list);
      }
      entry.resolve({ behavior: "allow", updatedInput: entry.input });
    } else {
      entry.resolve({
        behavior: "deny",
        message: decision.message,
      });
    }
    return true;
  }

  clearSession(sessionId: string): void {
    this.rules.delete(sessionId);
  }

  private askUi(
    toolName: string,
    input: Record<string, unknown>,
    sessionId: string,
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
      const timer = setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        resolve({
          behavior: "deny",
          message: "Permission request timed out",
        });
      }, this.timeoutMs);

      this.pending.set(requestId, {
        resolve,
        sessionId,
        toolName,
        input,
        timer,
      });

      this.requestFromUi(req);
    });
  }
}
