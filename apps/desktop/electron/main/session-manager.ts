import { randomUUID } from "node:crypto";
import type {
  FileChange,
  SdkNormalizedEvent,
  SessionSummary,
  SessionUsage,
  SlashCommandItem,
  TurnUsage,
} from "@claude-desktop/shared";
import type { PermissionBroker } from "./permission-broker";
import type { DiffTracker } from "./diff-tracker";
import type { CpaSupervisor } from "./cpa-supervisor";
import type { SettingsStore } from "./settings-store";
import type { UserPromptBroker } from "./user-prompt-broker";
import type { SessionArchive, StoredSession } from "./session-archive";
import { normalizeSdkEvent } from "./normalize-sdk-event";
import { MessageStream } from "./message-stream";

/**
 * Production query may receive a string (legacy/tests) or AsyncIterable (streaming).
 * When the result is a Query-like object it may expose supportedCommands / interrupt / close.
 */
export type QueryHandle = AsyncGenerator<unknown> | AsyncIterable<unknown>;

export type QueryFn = (args: {
  prompt: string | AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => QueryHandle;

export type SessionManagerDeps = {
  queryFn: QueryFn;
  permissionBroker: PermissionBroker;
  userPromptBroker?: UserPromptBroker;
  diffTracker: DiffTracker;
  cpa: CpaSupervisor;
  settings: SettingsStore;
  /** Persist session index + transcripts across restarts */
  archive?: SessionArchive;
  emit: (event: SdkNormalizedEvent) => void;
  emitSession: (s: SessionSummary) => void;
  emitDiff: (sessionId: string, changes: FileChange[]) => void;
  /** Optional: notify UI when SDK slash/skills list is refreshed */
  emitSlashCommands?: (sessionId: string, commands: SlashCommandItem[]) => void;
};

type QueryControl = {
  supportedCommands?: () => Promise<
    Array<{
      name: string;
      description: string;
      argumentHint?: string;
      aliases?: string[];
    }>
  >;
  interrupt?: () => Promise<unknown>;
  close?: () => void;
};

type SessionEntry = {
  summary: SessionSummary;
  abortController: AbortController | null;
  sdkSessionId?: string;
  /** Streaming input queue (kept open across turns) */
  input?: MessageStream;
  /** Live query handle for control requests */
  query?: QueryHandle & QueryControl;
  /** Background consumer promise */
  consumer?: Promise<void>;
  /** SDK + skill slash commands for this session */
  slashCommands: SlashCommandItem[];
  /** True while waiting for a result after push */
  turnActive: boolean;
};

/**
 * Base tool set for the agent. Prefer `tools` (availability) over bare
 * `allowedTools` (auto-approve). Using bare allowedTools shadows canUseTool
 * and skips the permission modal — see CLAUDE_SDK_CAN_USE_TOOL_SHADOWED.
 */
const SESSION_TOOLS = [
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
    typeof b.input === "object" &&
    b.input !== null
  );
}

function isResultMessage(msg: unknown): boolean {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: string }).type === "result"
  );
}

export class SessionManager {
  private readonly queryFn: QueryFn;
  private readonly permissionBroker: PermissionBroker;
  private readonly userPromptBroker: UserPromptBroker | undefined;
  private readonly diffTracker: DiffTracker;
  private readonly cpa: CpaSupervisor;
  private readonly settings: SettingsStore;
  private readonly archive: SessionArchive | undefined;
  private readonly emit: SessionManagerDeps["emit"];
  private readonly emitSession: SessionManagerDeps["emitSession"];
  private readonly emitDiff: SessionManagerDeps["emitDiff"];
  private readonly emitSlashCommands: SessionManagerDeps["emitSlashCommands"];

  private readonly sessions = new Map<string, SessionEntry>();

  constructor(deps: SessionManagerDeps) {
    this.queryFn = deps.queryFn;
    this.permissionBroker = deps.permissionBroker;
    this.userPromptBroker = deps.userPromptBroker;
    this.diffTracker = deps.diffTracker;
    this.cpa = deps.cpa;
    this.settings = deps.settings;
    this.archive = deps.archive;
    this.emit = deps.emit;
    this.emitSession = deps.emitSession;
    this.emitDiff = deps.emitDiff;
    this.emitSlashCommands = deps.emitSlashCommands;

    // Hydrate session list + file changes from disk (no live query until continue).
    if (this.archive) {
      for (const stored of this.archive.loadIndex()) {
        this.sessions.set(stored.id, {
          summary: {
            id: stored.id,
            title: stored.title,
            cwd: stored.cwd,
            updatedAt: stored.updatedAt,
            status: stored.status === "running" ? "idle" : stored.status,
            ...(stored.usage ? { usage: stored.usage } : {}),
          },
          abortController: null,
          sdkSessionId: stored.sdkSessionId,
          slashCommands: [],
          turnActive: false,
        });
        const changes = this.archive.loadChanges(stored.id);
        if (changes.length) {
          this.diffTracker.hydrate(stored.id, changes);
        }
      }
    }
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((e) => ({ ...e.summary }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const e = this.sessions.get(sessionId);
    return e ? { ...e.summary } : undefined;
  }

  /** Transcript for UI restore (from disk archive). */
  getTranscript(sessionId: string) {
    return this.archive?.loadItems(sessionId) ?? [];
  }

  saveTranscript(
    sessionId: string,
    items: import("@claude-desktop/shared").ChatItem[],
  ): void {
    this.archive?.saveItems(sessionId, items);
  }

  private persistSummary(entry: SessionEntry): void {
    if (!this.archive) return;
    const stored: StoredSession = {
      ...entry.summary,
      ...(entry.sdkSessionId ? { sdkSessionId: entry.sdkSessionId } : {}),
    };
    this.archive.upsertSummary(stored);
  }

  private persistChanges(sessionId: string): void {
    if (!this.archive) return;
    this.archive.saveChanges(sessionId, this.diffTracker.list(sessionId));
  }

  private emitDiffAndPersist(sessionId: string): void {
    const list = this.diffTracker.list(sessionId);
    this.emitDiff(sessionId, list);
    this.persistChanges(sessionId);
  }

  /** SDK skills / slash commands cached for a session (empty if none yet). */
  getSlashCommands(sessionId: string): SlashCommandItem[] {
    return [...(this.sessions.get(sessionId)?.slashCommands ?? [])];
  }

  abort(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    try {
      void entry.query?.interrupt?.();
    } catch {
      // ignore
    }
    if (entry.abortController) {
      try {
        entry.abortController.abort();
      } catch {
        // ignore
      }
    }
  }

  /** Close streaming input for a session (e.g. window quit). */
  closeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    try {
      entry.input?.end();
      entry.query?.close?.();
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
    const entry: SessionEntry = {
      summary,
      abortController: null,
      slashCommands: [],
      turnActive: true,
    };
    this.sessions.set(sessionId, entry);
    this.emitSession({ ...summary });
    this.persistSummary(entry);

    await this.openStreamingSession(sessionId, prompt, { resume: false });
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
    entry.turnActive = true;
    this.emitSession({ ...entry.summary });
    this.persistSummary(entry);

    // Live streaming session: just push the next user message.
    if (entry.input && !entry.input.isClosed && entry.consumer) {
      entry.input.push(prompt, entry.sdkSessionId);
      // Wait until this turn's result (or error) so IPC still "awaits the turn".
      await this.waitForTurnIdle(sessionId);
      return;
    }

    // Fallback: open a new streaming query with resume (uses sdkSessionId when known).
    await this.openStreamingSession(sessionId, prompt, { resume: true });
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

  private buildOptions(
    sessionId: string,
    entry: SessionEntry,
    abortController: AbortController,
  ): Record<string, unknown> {
    const settings = this.settings.get();
    const env = this.cpa.buildProcessEnv(settings.defaultModel);

    return {
      cwd: entry.summary.cwd,
      includePartialMessages: true,
      permissionMode: settings.permissionMode,
      model: settings.defaultModel,
      env,
      tools: [...SESSION_TOOLS],
      allowedTools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
      abortController,
      canUseTool: async (
        name: string,
        input: Record<string, unknown>,
        _sdkOpts: { signal: AbortSignal },
      ) => {
        const result = await this.permissionBroker.canUseTool(
          name,
          input,
          sessionId,
        );
        if (result.behavior === "allow") {
          return {
            behavior: "allow" as const,
            updatedInput: result.updatedInput,
          };
        }
        return {
          behavior: "deny" as const,
          message: result.message ?? "Denied by permission broker",
        };
      },
      ...(this.userPromptBroker
        ? {
            onElicitation: this.userPromptBroker.makeOnElicitation(sessionId),
            onUserDialog: this.userPromptBroker.makeOnUserDialog(sessionId),
          }
        : {}),
    };
  }

  /**
   * Start a streaming-input query, push the first prompt, and run a background
   * consumer until the stream ends. Resolves after the first turn's result.
   */
  private async openStreamingSession(
    sessionId: string,
    prompt: string,
    opts: { resume: boolean },
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    // Tear down any previous stream
    try {
      entry.input?.end();
      entry.query?.close?.();
    } catch {
      // ignore
    }

    const abortController = new AbortController();
    entry.abortController = abortController;
    entry.turnActive = true;

    const input = new MessageStream();
    entry.input = input;

    const options = this.buildOptions(sessionId, entry, abortController);
    if (opts.resume) {
      options.resume = entry.sdkSessionId ?? sessionId;
    }

    const settings = this.settings.get();

    try {
      const q = this.queryFn({
        prompt: input as AsyncIterable<unknown>,
        options,
      });
      entry.query = q as QueryHandle & QueryControl;

      // Kick off consumer before first push so we don't miss early messages.
      entry.consumer = this.consumeQuery(sessionId, q, settings.defaultModel);

      // Refresh slash/skills list (control request; streaming mode only).
      void this.refreshSlashCommands(sessionId);

      input.push(prompt, entry.sdkSessionId);
      await this.waitForTurnIdle(sessionId);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const message = humanizeAgentError(raw, settings.defaultModel);
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
      entry.turnActive = false;
      this.emitSession({ ...entry.summary });
      try {
        input.end();
      } catch {
        // ignore
      }
      throw err;
    }
  }

  private async consumeQuery(
    sessionId: string,
    stream: QueryHandle,
    model: string,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    try {
      for await (const msg of stream) {
        if (entry.abortController?.signal.aborted) break;

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
              usage: accumulateUsage(entry.summary.usage, event.usage),
            };
            entry.turnActive = false;
            this.emitSession({ ...entry.summary });
            this.persistSummary(entry);
          }
        }

        // Also mark idle on bare result messages if normalize missed fields
        if (isResultMessage(msg) && entry.turnActive) {
          entry.turnActive = false;
          if (entry.summary.status === "running") {
            entry.summary = {
              ...entry.summary,
              status: "idle",
              updatedAt: Date.now(),
            };
            this.emitSession({ ...entry.summary });
            this.persistSummary(entry);
          }
        }
      }

      // Stream ended (input closed or process exit)
      if (entry.summary.status === "running") {
        entry.summary = {
          ...entry.summary,
          status: "idle",
          updatedAt: Date.now(),
        };
        this.emitSession({ ...entry.summary });
        this.persistSummary(entry);
      }
      entry.turnActive = false;
    } catch (err) {
      if (entry.abortController?.signal.aborted) {
        entry.turnActive = false;
        entry.summary = {
          ...entry.summary,
          status: "idle",
          updatedAt: Date.now(),
        };
        this.emitSession({ ...entry.summary });
        return;
      }
      const raw = err instanceof Error ? err.message : String(err);
      const message = humanizeAgentError(raw, model);
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
      entry.turnActive = false;
      this.emitSession({ ...entry.summary });
    } finally {
      if (entry.abortController) {
        entry.abortController = null;
      }
    }
  }

  private waitForTurnIdle(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return Promise.resolve();
    if (!entry.turnActive) return Promise.resolve();

    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const e = this.sessions.get(sessionId);
        if (!e || !e.turnActive) {
          resolve();
          return;
        }
        // Safety: don't hang forever (30 min)
        if (Date.now() - start > 30 * 60 * 1000) {
          e.turnActive = false;
          resolve();
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  private async refreshSlashCommands(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.query?.supportedCommands) return;
    try {
      // Give initialize a brief moment on cold start
      await new Promise((r) => setTimeout(r, 100));
      const cmds = await entry.query.supportedCommands();
      entry.slashCommands = (cmds ?? []).map((c) => ({
        name: c.name,
        description: c.description || c.argumentHint || c.name,
        sendAsPrompt: true,
      }));
      this.emitSlashCommands?.(sessionId, entry.slashCommands);
    } catch {
      // Control request may fail if CLI not ready; non-fatal.
    }
  }

  private handleToolUseForDiff(sessionId: string, msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const rec = msg as Record<string, unknown>;

    // tool_result for Bash: refresh disk content for bash-written paths
    if (rec.type === "user") {
      const message = rec.message as Record<string, unknown> | undefined;
      const content = message && Array.isArray(message.content) ? message.content : [];
      let refreshed = false;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;
        // After any tool result, try to refresh bash-tracked files from disk
        // (cheap no-op if none tracked as Bash).
        refreshed = true;
      }
      if (refreshed) {
        this.diffTracker.refreshBashWritesFromDisk(sessionId);
        const list = this.diffTracker.list(sessionId);
        if (list.length) this.emitDiffAndPersist(sessionId);
      }
      return;
    }

    if (rec.type !== "assistant") return;
    const message = rec.message as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message.content)) return;

    for (const block of message.content) {
      if (!isToolUseBlock(block)) continue;
      if (
        block.name !== "Edit" &&
        block.name !== "Write" &&
        block.name !== "Bash"
      ) {
        continue;
      }

      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      this.diffTracker.onToolUse(sessionId, block.name, input);
      this.emitDiffAndPersist(sessionId);
    }
  }
}

/**
 * Map common upstream/CPA errors to actionable UI copy.
 * DeepSeek (and some OpenAI-compat proxies) reject Anthropic image blocks.
 */
export function humanizeAgentError(raw: string, model: string): string {
  if (
    /unknown variant\s*`?image_url`?/i.test(raw) ||
    /image_url.*expected\s*`?text`?/i.test(raw)
  ) {
    return (
      `Model "${model}" does not accept image content (image_url). ` +
      `Start a new chat without screenshots, or switch to a vision-capable model ` +
      `(e.g. kimi / grok), then retry. Original: ${raw}`
    );
  }
  return raw;
}

/** Merge one turn's usage into session totals. */
export function accumulateUsage(
  prev: SessionUsage | undefined,
  turn: TurnUsage | undefined,
): SessionUsage | undefined {
  if (!turn) return prev;
  const base: SessionUsage = prev ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    turns: 0,
  };
  return {
    inputTokens: base.inputTokens + (turn.inputTokens ?? 0),
    outputTokens: base.outputTokens + (turn.outputTokens ?? 0),
    cacheReadTokens: base.cacheReadTokens + (turn.cacheReadTokens ?? 0),
    cacheCreationTokens:
      base.cacheCreationTokens + (turn.cacheCreationTokens ?? 0),
    costUsd: base.costUsd + (turn.costUsd ?? 0),
    durationMs: base.durationMs + (turn.durationMs ?? 0),
    turns: base.turns + 1,
  };
}
