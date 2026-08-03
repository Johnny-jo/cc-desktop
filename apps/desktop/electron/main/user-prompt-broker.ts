import { randomUUID } from "node:crypto";
import type {
  UserPromptDecision,
  UserPromptRequest,
} from "@claude-desktop/shared";

export type UserPromptBrokerDeps = {
  requestFromUi: (req: UserPromptRequest) => void;
  timeoutMs?: number;
  getSessionId?: () => string;
};

type Pending = {
  resolve: (decision: UserPromptDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Bridges SDK onElicitation / onUserDialog to the renderer.
 * Separate from PermissionBroker (tool allow/deny).
 */
export class UserPromptBroker {
  private readonly requestFromUi: UserPromptBrokerDeps["requestFromUi"];
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, Pending>();

  constructor(deps: UserPromptBrokerDeps) {
    this.requestFromUi = deps.requestFromUi;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * SDK onElicitation adapter.
   */
  makeOnElicitation(sessionId: string) {
    return async (request: {
      serverName: string;
      message: string;
      mode?: "form" | "url";
      url?: string;
      requestedSchema?: Record<string, unknown>;
      title?: string;
      displayName?: string;
      description?: string;
    }): Promise<{
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    }> => {
      const decision = await this.ask({
        sessionId,
        kind: "elicitation",
        title:
          request.title ??
          request.displayName ??
          `Input required (${request.serverName})`,
        message:
          request.message ||
          request.description ||
          "The agent needs additional information.",
        schema: request.requestedSchema,
        url: request.url,
      });

      if (decision.behavior === "accept") {
        return { action: "accept", content: decision.content };
      }
      if (decision.behavior === "decline") {
        return { action: "decline" };
      }
      return { action: "cancel" };
    };
  }

  /**
   * SDK onUserDialog adapter.
   */
  makeOnUserDialog(sessionId: string) {
    return async (request: {
      dialogKind: string;
      payload: Record<string, unknown>;
      toolUseID?: string;
    }): Promise<
      { behavior: "completed"; result: unknown } | { behavior: "cancelled" }
    > => {
      const message =
        typeof request.payload?.message === "string"
          ? request.payload.message
          : typeof request.payload?.prompt === "string"
            ? request.payload.prompt
            : `Dialog: ${request.dialogKind}`;

      const decision = await this.ask({
        sessionId,
        kind: "dialog",
        title: request.dialogKind,
        message,
        dialogKind: request.dialogKind,
        payload: request.payload,
      });

      if (decision.behavior === "accept") {
        return {
          behavior: "completed",
          result: decision.result ?? decision.content ?? { ok: true },
        };
      }
      return { behavior: "cancelled" };
    };
  }

  respond(requestId: string, decision: UserPromptDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(decision);
    return true;
  }

  private ask(
    partial: Omit<UserPromptRequest, "requestId">,
  ): Promise<UserPromptDecision> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ behavior: "cancel", message: "Timed out waiting for user" });
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, timer });
      this.requestFromUi({ ...partial, requestId });
    });
  }
}
