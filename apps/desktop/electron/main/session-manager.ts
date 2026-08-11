import { randomUUID } from "node:crypto";
import type {
  FileChange,
  McpServersMap,
  McpSetServersResultDto,
  SdkNormalizedEvent,
  SessionMcpServerStatus,
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
import {
  computeContextUsage,
  type UserPrompt,
  type UserContentBlock,
} from "@claude-desktop/shared";
import { normalizeSdkEvent } from "./normalize-sdk-event";
import { MessageStream } from "./message-stream";
import { buildUserContent } from "./attachment-reader";
import {
  buildContinuationPrompt,
  KEEP_RECENT_ITEMS,
  type ContextCompressor,
} from "./context-compressor";

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
  /** Optional: context compressor for /compact and renderer-driven auto-compress */
  compressor?: ContextCompressor;
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
  /** SDK control request: live MCP server connection status + tool list */
  mcpServerStatus?: () => Promise<
    Array<{
      name: string;
      status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
      error?: string;
      serverInfo?: { name: string; version: string };
      scope?: string;
      tools?: Array<{
        name: string;
        description?: string;
        annotations?: {
          readOnly?: boolean;
          destructive?: boolean;
          openWorld?: boolean;
        };
      }>;
    }>
  >;
  /** SDK control request: reconnect a failed/disconnected MCP server */
  reconnectMcpServer?: (serverName: string) => Promise<void>;
  /** SDK control request: enable/disable an MCP server */
  toggleMcpServer?: (serverName: string, enabled: boolean) => Promise<void>;
  /** SDK control request: replace the session's dynamic MCP servers */
  setMcpServers?: (
    servers: Record<string, unknown>,
  ) => Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  }>;
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
  /** True if context has already been auto-compressed this session */
  compressed: boolean;
  /** Timestamp of last auto-compression (for cooldown) */
  lastCompressedAt?: number;
  /**
   * Pending context to prepend on the next fresh query after compression.
   * When set, the next continue() starts a NEW SDK session (no resume) and
   * prepends this summary so the model retains continuity without full history.
   */
  pendingSummaryPrefix?: string;
};

/**
 * Base tool set: use the full Claude Code preset so the agent gets Task/Agent,
 * TodoWrite, NotebookEdit, etc. — not just the original 8-tool whitelist.
 * Prefer `tools` (availability) over bare `allowedTools` (auto-approve). Using
 * bare allowedTools shadows canUseTool and skips the permission modal — see
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED.
 */
const SESSION_TOOLS = { type: "preset", preset: "claude_code" } as const;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function titleFromPrompt(prompt: UserPrompt): string {
  const t = prompt.text.trim().replace(/\s+/g, " ");
  if (!t) {
    const names = prompt.attachments.map((a) => a.name).join(", ");
    return names ? `Files: ${names.slice(0, 40)}` : "New session";
  }
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
  private readonly compressor: ContextCompressor | undefined;

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
    this.compressor = deps.compressor;

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
            ...(stored.contextUsage
              ? { contextUsage: stored.contextUsage }
              : {}),
          },
          abortController: null,
          sdkSessionId: stored.sdkSessionId,
          slashCommands: [],
          turnActive: false,
          compressed: false,
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

  /**
   * Live MCP server status for a running session (connection state + tools).
   * Returns null when the session has no live query or the SDK doesn't support it.
   */
  async getMcpStatus(
    sessionId: string,
  ): Promise<SessionMcpServerStatus[] | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.query?.mcpServerStatus) return null;
    try {
      const statuses = await entry.query.mcpServerStatus();
      return (statuses ?? []).map((s) => ({
        name: s.name,
        status: s.status,
        ...(s.error ? { error: s.error } : {}),
        ...(s.serverInfo ? { serverInfo: s.serverInfo } : {}),
        ...(s.scope ? { scope: s.scope } : {}),
        ...(Array.isArray(s.tools) ? { tools: s.tools } : {}),
      }));
    } catch {
      return null;
    }
  }

  /** Reconnect a failed/disconnected MCP server in a running session. */
  async reconnectMcpServer(
    sessionId: string,
    name: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.query?.reconnectMcpServer) {
      return { ok: false, error: "No live session query" };
    }
    try {
      await entry.query.reconnectMcpServer(name);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  /** Enable/disable an MCP server in a running session (session-scoped). */
  async toggleMcpServer(
    sessionId: string,
    name: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.query?.toggleMcpServer) {
      return { ok: false, error: "No live session query" };
    }
    try {
      await entry.query.toggleMcpServer(name, enabled);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  /**
   * Replace the running session's dynamic MCP servers AND persist the new
   * set to settings so future sessions see the same config.
   */
  async setMcpServers(
    sessionId: string,
    servers: McpServersMap,
  ): Promise<{
    ok: boolean;
    result?: McpSetServersResultDto;
    error?: string;
  }> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.query?.setMcpServers) {
      return { ok: false, error: "No live session query" };
    }
    try {
      const result = await entry.query.setMcpServers(
        servers as Record<string, unknown>,
      );
      this.settings.update({ mcpServers: servers });
      return {
        ok: true,
        result: {
          added: result.added ?? [],
          removed: result.removed ?? [],
          errors: result.errors ?? {},
        },
      };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  /**
   * Probe MCP servers without a running session: spawns a throwaway SDK
   * query (bypass permissions, maxTurns 1, strict MCP config), reads live
   * mcpServerStatus(), then closes. Used by Settings to test connections.
   * `servers` overrides the settings map (e.g. an unsaved settings draft).
   */
  async probeMcpServers(
    servers?: McpServersMap,
  ): Promise<SessionMcpServerStatus[]> {
    const settings = this.settings.get();
    const target = servers ?? settings.mcpServers ?? {};
    if (!Object.keys(target).length) return [];

    const env = this.cpa.buildProcessEnv(settings.defaultModel);
    const q = this.queryFn({
      prompt: "Reply with exactly: ok",
      options: {
        cwd: process.cwd(),
        model: settings.defaultModel,
        env,
        // Bypass tool permission prompts — the probe prompt needs no tools.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        tools: [],
        strictMcpConfig: true,
        mcpServers: target,
        // Don't load CLAUDE.md / project settings into the probe.
        settingSources: [],
      },
    });
    const control = q as QueryHandle & QueryControl;
    try {
      const deadline = Date.now() + 30_000;
      // MCP servers connect asynchronously on startup; poll until every
      // server leaves "pending" or the deadline passes.
      let statuses: SessionMcpServerStatus[] = [];
      for (;;) {
        const raw = (await control.mcpServerStatus?.()) ?? [];
        statuses = raw.map((s) => ({
          name: s.name,
          status: s.status,
          ...(s.error ? { error: s.error } : {}),
          ...(s.serverInfo ? { serverInfo: s.serverInfo } : {}),
          ...(s.scope ? { scope: s.scope } : {}),
          ...(Array.isArray(s.tools) ? { tools: s.tools } : {}),
        }));
        const pending = statuses.some((s) => s.status === "pending");
        if (!pending || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      return statuses;
    } finally {
      try {
        control.close?.();
      } catch {
        // ignore
      }
      // Drain the generator so the CLI subprocess exits.
      try {
        for await (const _ of q) {
          break;
        }
      } catch {
        // ignore
      }
    }
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

  /**
   * Compress a session's transcript (user /compact or renderer auto-compress).
   * Prefer `items` from the renderer — the disk archive can lag the live UI
   * transcript, and compressing stale disk data would wipe newer messages.
   *
   * When `autoContinue` is true (auto-compact path), immediately starts a fresh
   * SDK turn with the summary + "continue last task" instruction — matching
   * Claude Code so work is not abandoned after compaction.
   */
  async compressSession(
    sessionId: string,
    items?: import("@claude-desktop/shared").ChatItem[],
    opts?: { autoContinue?: boolean },
  ): Promise<{ ok: boolean; message?: string }> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: false, message: "Session not found" };
    if (!this.compressor || !this.archive) {
      return { ok: false, message: "Compression not available" };
    }

    // Don't interrupt an active turn — wait until the agent is idle.
    if (entry.turnActive || entry.summary.status === "running") {
      return { ok: false, message: "Session is still running; compress after the turn finishes" };
    }

    // Cooldown shared with auto-compress path.
    const now = Date.now();
    if (
      entry.lastCompressedAt != null &&
      now - entry.lastCompressedAt < 5 * 60 * 1000
    ) {
      return { ok: false, message: "Compression cooldown — try again shortly" };
    }

    const fromRenderer = Array.isArray(items) ? items : null;
    const fromDisk = this.archive.loadItems(sessionId);
    // Prefer the longer transcript so we never compress a stale short snapshot
    // over a fuller one (disk lag vs. concurrent save).
    const current =
      fromRenderer && fromRenderer.length >= fromDisk.length
        ? fromRenderer
        : fromDisk.length > 0
          ? fromDisk
          : (fromRenderer ?? []);

    if (current.length <= KEEP_RECENT_ITEMS) {
      return { ok: false, message: "Not enough history to compress" };
    }

    try {
      const result = await this.compressor.compress(current);
      if (result.compressedCount === 0) {
        return { ok: false, message: "Nothing to compress" };
      }
      this.archive.saveItems(sessionId, result.items);
      entry.compressed = true;
      entry.lastCompressedAt = now;
      // Close the live stream so the next turn starts a fresh SDK session
      // without the old (now compressed) history.
      this.closeSession(sessionId);
      entry.sdkSessionId = undefined;

      this.emit({
        type: "items_replaced",
        sessionId,
        items: result.items,
      });

      if (opts?.autoContinue) {
        // Claude Code style: after auto-compact, immediately resume the last task
        // with the structured summary as context — don't leave the agent idle.
        entry.pendingSummaryPrefix = undefined;
        const continueText = buildContinuationPrompt(result.summaryText, {
          autoContinue: true,
        });
        // Show a system note so the user sees why work is continuing.
        const continueNote: import("@claude-desktop/shared").ChatItem = {
          kind: "text",
          id: `ctx-continue-${Date.now()}`,
          role: "system",
          text: "Context compacted — continuing previous task…",
        };
        const withNote = [...result.items, continueNote];
        this.archive.saveItems(sessionId, withNote);
        this.emit({
          type: "items_replaced",
          sessionId,
          items: withNote,
        });

        entry.summary = {
          ...entry.summary,
          status: "running",
          updatedAt: Date.now(),
        };
        entry.turnActive = true;
        this.emitSession({ ...entry.summary });
        this.persistSummary(entry);

        // Fire-and-forget the continuation turn so IPC can return promptly.
        void this.openStreamingSession(
          sessionId,
          [{ type: "text", text: continueText }],
          { resume: false },
        ).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.emit({
            type: "result",
            sessionId,
            ok: false,
            error: `Post-compact continue failed: ${message}`,
          });
        });

        return {
          ok: true,
          message: `Compressed ${result.compressedCount} items; continuing task`,
        };
      }

      // Manual /compact: stash summary for the *next* user message only.
      entry.pendingSummaryPrefix = result.summaryText;
      return { ok: true, message: `Compressed ${result.compressedCount} items` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Compression failed: ${message}` };
    }
  }

  async start(prompt: UserPrompt, cwd: string): Promise<string> {
    await this.ensureCpaOrThrow();

    const { content, errors } = buildUserContent(prompt);
    if (errors.length) {
      this.emit({
        type: "result",
        sessionId: "unknown",
        ok: false,
        error: errors.join("; "),
      });
    }

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
      compressed: false,
    };
    this.sessions.set(sessionId, entry);
    this.emitSession({ ...summary });
    this.persistSummary(entry);

    await this.openStreamingSession(sessionId, content, { resume: false });
    return sessionId;
  }

  async continue(sessionId: string, prompt: UserPrompt): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    await this.ensureCpaOrThrow(sessionId);

    const { content, errors } = buildUserContent(prompt);
    if (errors.length) {
      this.emit({
        type: "result",
        sessionId,
        ok: false,
        error: errors.join("; "),
      });
    }

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
      entry.input.push(content, entry.sdkSessionId);
      // Wait until this turn's result (or error) so IPC still "awaits the turn".
      await this.waitForTurnIdle(sessionId);
      return;
    }

    // After manual /compact, start a fresh SDK session (no resume) and prepend
    // the structured summary so continuity is preserved without full history.
    if (entry.pendingSummaryPrefix) {
      const prefix = entry.pendingSummaryPrefix;
      entry.pendingSummaryPrefix = undefined;
      const summaryBlock = buildContinuationPrompt(prefix, {
        autoContinue: false,
      });
      const userPart = Array.isArray(content)
        ? content
        : [{ type: "text" as const, text: String(content) }];
      const freshContent: UserContentBlock[] = [
        { type: "text", text: `${summaryBlock}\n\nCurrent user message:` },
        ...userPart,
      ];
      await this.openStreamingSession(sessionId, freshContent, {
        resume: false,
      });
      return;
    }

    // Fallback: open a new streaming query with resume (uses sdkSessionId when known).
    await this.openStreamingSession(sessionId, content, { resume: true });
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
      tools: SESSION_TOOLS,
      // Auto-approve read-only / harmless tools so they skip the permission
      // modal. Task/Todo tools are pure in-memory agent state (no file side
      // effects), matching Claude Code which never prompts for them.
      // PermissionBroker adds a second direct-allow layer for these.
      allowedTools: [
        "Read",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "TodoWrite",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "TaskGet",
      ],
      // Load CLAUDE.md hierarchy (user → project → local) into the system
      // prompt, matching Claude Code. Must include 'project' for project CLAUDE.md.
      settingSources: ["user", "project", "local"],
      // Configured MCP servers (stdio/sse/http). Passed through as-is; the
      // config shape matches the SDK. Kept out of `env` so the CPA token is
      // never leaked into MCP server subprocesses.
      ...(Object.keys(settings.mcpServers ?? {}).length
        ? { mcpServers: settings.mcpServers }
        : {}),
      // Only use the MCP servers this app passes in — ignore project
      // .mcp.json, user settings, and plugin-declared servers so desktop
      // sessions have a single, explicit MCP surface (Settings → MCP servers).
      strictMcpConfig: true,
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
    content: string | UserContentBlock[],
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

      input.push(content, entry.sdkSessionId);
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
            const settings = this.settings.get();
            const catalog = this.cpa.getModelCatalog();
            const usage = accumulateUsage(
              entry.summary.usage,
              event.usage,
            );
            const contextUsage =
              computeContextUsage({
                turn: event.usage,
                modelId: model || settings.defaultModel,
                settings: {
                  defaultContextLimit: settings.defaultContextLimit,
                  modelContextLimits: settings.modelContextLimits,
                },
                catalog,
              }) ?? entry.summary.contextUsage;

            entry.summary = {
              ...entry.summary,
              status: event.ok ? "idle" : "error",
              updatedAt: Date.now(),
              usage,
              ...(contextUsage ? { contextUsage } : {}),
            };
            entry.turnActive = false;
            this.emitSession({ ...entry.summary });
            this.persistSummary(entry);
            // Auto-compress is triggered by the renderer after it has the full
            // transcript in memory (main-side disk archive can lag and wipe history).
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
