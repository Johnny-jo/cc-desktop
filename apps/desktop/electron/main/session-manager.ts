import { randomUUID } from "node:crypto";
import type {
  FileChange,
  SdkNormalizedEvent,
  SessionSummary,
} from "@claude-desktop/shared";
import type { PermissionBroker } from "./permission-broker";
import type { DiffTracker } from "./diff-tracker";
import type { CpaSupervisor } from "./cpa-supervisor";
import type { SettingsStore } from "./settings-store";
import { normalizeSdkEvent } from "./normalize-sdk-event";

export type QueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncGenerator<unknown> | AsyncIterable<unknown>;

export type SessionManagerDeps = {
  queryFn: QueryFn;
  permissionBroker: PermissionBroker;
  diffTracker: DiffTracker;
  cpa: CpaSupervisor;
  settings: SettingsStore;
  emit: (event: SdkNormalizedEvent) => void;
  emitSession: (s: SessionSummary) => void;
  emitDiff: (sessionId: string, changes: FileChange[]) => void;
};

type SessionEntry = {
  summary: SessionSummary;
  abortController: AbortController | null;
  /** SDK session id when known (from result/session_id on messages) */
  sdkSessionId?: string;
};

const ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
] as const;

function titleFromPrompt(prompt: string): string {
  const t = prompt.trim().replace(/\s+/g, " ");
  if (!t) return "New session";
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

function extractSdkSessionId(msg: unknown): string | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  const rec = msg as Record<string, unknown>;
  if (typeof rec.session_id === "string" && rec.session_id.length > 0) {
    return rec.session_id;
  }
  return undefined;
}

function isToolUseBlock(
  block: unknown,
): block is { type: "tool_use"; name: string; input: Record<string, unknown> } {
  if (typeof block !== "object" || block === null) return false;
  const b = block as Record<string, unknown>;
  return (
    b.type === "tool_use" &&
    typeof b.name === "string" &&
    (typeof b.input === "object" && b.input !== null)
  );
}

export class SessionManager {
  private readonly queryFn: QueryFn;
  private readonly permissionBroker: PermissionBroker;
  private readonly diffTracker: DiffTracker;
  private readonly cpa: CpaSupervisor;
  private readonly settings: SettingsStore;
  private readonly emit: SessionManagerDeps["emit"];
  private readonly emitSession: SessionManagerDeps["emitSession"];
  private readonly emitDiff: SessionManagerDeps["emitDiff"];

  private readonly sessions = new Map<string, SessionEntry>();

  constructor(deps: SessionManagerDeps) {
    this.queryFn = deps.queryFn;
    this.permissionBroker = deps.permissionBroker;
    this.diffTracker = deps.diffTracker;
    this.cpa = deps.cpa;
    this.settings = deps.settings;
    this.emit = deps.emit;
    this.emitSession = deps.emitSession;
    this.emitDiff = deps.emitDiff;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((e) => ({ ...e.summary }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  abort(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry?.abortController) return;
    try {
      entry.abortController.abort();
    } catch {
      // ignore
    }
  }

  async start(prompt: string, cwd: string): Promise<string> {
    await this.ensureCpaOrThrow();

    const sessionId = randomUUID();
    const now = Date.now();
    const summary: SessionSummary = {
      id: sessionId,
      title: titleFromPrompt(prompt),
      cwd,
      updatedAt: now,
      status: "running",
    };
    this.sessions.set(sessionId, { summary, abortController: null });
    this.emitSession({ ...summary });

    await this.runTurn(sessionId, prompt, { resume: false });
    return sessionId;
  }

  async continue(sessionId: string, prompt: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    await this.ensureCpaOrThrow(sessionId);

    entry.summary = {
      ...entry.summary,
      status: "running",
      updatedAt: Date.now(),
    };
    this.emitSession({ ...entry.summary });

    await this.runTurn(sessionId, prompt, { resume: true });
  }

  private async ensureCpaOrThrow(sessionId?: string): Promise<void> {
    const status = await this.cpa.ensureReady();
    if (status.state === "ready") return;

    const message =
      status.state === "error"
        ? status.message
        : `CPA is not ready (state=${status.state})`;

    const sid = sessionId ?? "unknown";
    this.emit({
      type: "result",
      sessionId: sid,
      ok: false,
      error: `CPA: ${message}`,
    });
    throw new Error(`CPA: ${message}`);
  }

  private async runTurn(
    sessionId: string,
    prompt: string,
    opts: { resume: boolean },
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    const abortController = new AbortController();
    entry.abortController = abortController;

    const settings = this.settings.get();
    const env = this.cpa.buildProcessEnv(settings.defaultModel);

    const options: Record<string, unknown> = {
      cwd: entry.summary.cwd,
      includePartialMessages: true,
      permissionMode: settings.permissionMode,
      env,
      allowedTools: [...ALLOWED_TOOLS],
      abortController,
      canUseTool: (name: string, input: Record<string, unknown>) =>
        this.permissionBroker.canUseTool(name, input, sessionId),
    };

    if (opts.resume) {
      options.resume = entry.sdkSessionId ?? sessionId;
    }

    try {
      const stream = this.queryFn({ prompt, options });
      for await (const msg of stream) {
        if (abortController.signal.aborted) break;

        const sdkId = extractSdkSessionId(msg);
        if (sdkId) {
          entry.sdkSessionId = sdkId;
        }

        this.handleToolUseForDiff(sessionId, msg);

        const events = normalizeSdkEvent(msg, sessionId);
        for (const event of events) {
          this.emit(event);
          if (event.type === "result") {
            entry.summary = {
              ...entry.summary,
              status: event.ok ? "idle" : "error",
              updatedAt: Date.now(),
            };
            this.emitSession({ ...entry.summary });
          }
        }
      }

      // If stream ended without result, mark idle
      if (entry.summary.status === "running") {
        entry.summary = {
          ...entry.summary,
          status: "idle",
          updatedAt: Date.now(),
        };
        this.emitSession({ ...entry.summary });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "result",
        sessionId,
        ok: false,
        error: message,
      });
      entry.summary = {
        ...entry.summary,
        status: "error",
        updatedAt: Date.now(),
      };
      this.emitSession({ ...entry.summary });
      throw err;
    } finally {
      if (entry.abortController === abortController) {
        entry.abortController = null;
      }
    }
  }

  private handleToolUseForDiff(sessionId: string, msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const rec = msg as Record<string, unknown>;
    if (rec.type !== "assistant") return;
    const message = rec.message as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message.content)) return;

    for (const block of message.content) {
      if (!isToolUseBlock(block)) continue;
      if (block.name !== "Edit" && block.name !== "Write") continue;

      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      this.diffTracker.onToolUse(sessionId, block.name, input);
      this.emitDiff(sessionId, this.diffTracker.list(sessionId));
    }
  }
}
