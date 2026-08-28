import { randomUUID } from "node:crypto";
import type {
  ChatItem,
  FileChange,
  McpServersMap,
  McpSetServersResultDto,
  PermissionMode,
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
import {
  mergeTranscriptItems,
  pageTranscriptItems,
  type SessionArchive,
  type StoredSession,
  type TranscriptPage,
} from "./session-archive";
import {
  applySdkEvent,
  appendUserItem,
  bindSdkUserMsgIds,
  computeContextUsage,
  createIdFactory,
  shouldPersistTranscript,
  type TranscriptState,
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
import { getClaudeExecutablePath } from "./runtime-paths";

/**
 * Production query may receive a string (legacy/tests) or AsyncIterable (streaming).
 * When the result is a Query-like object it may expose supportedCommands / interrupt / close.
 */
export type QueryHandle = AsyncGenerator<unknown> | AsyncIterable<unknown>;

export type QueryFn = (args: {
  prompt: string | AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => QueryHandle;

/** Extra MCP / tools attached to one session (room-mod agent seats). */
export type SessionRunOpts = {
  extraMcpServers?: Record<string, unknown>;
  extraAllowedTools?: string[];
  /** Per-session model override (room agent seats). */
  model?: string;
  /** Per-session permission override (room filePolicy allow → auto). */
  permissionMode?: PermissionMode;
  /** Merge over CPA env (borrowed AI proxy sets ANTHROPIC_BASE_URL here). */
  extraEnv?: Record<string, string>;
  /** Skip local CPA ready check (borrowed AI talks to a loopback proxy). */
  skipCpa?: boolean;
  /**
   * When true, extraMcpServers / extraAllowedTools replace the session extras
   * instead of merging. Room seats always pass this.
   */
  replaceExtras?: boolean;
  /** Omit from SessionManager.list / session sidebar */
  hiddenFromList?: boolean;
  /** start() 里会话条目一建好就同步回调（远程执行节点映射事件流用）。 */
  onSessionId?: (sessionId: string) => void;
  title?: string;
  /** Persist this instead of the raw prompt (avoid dumping private views). */
  persistText?: string;
};

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
  /** Optional: surface SDK Notification hook events (desktop notifications) */
  onNotification?: (n: {
    sessionId: string;
    title?: string;
    message: string;
    notificationType?: string;
  }) => void;
  /** Packaged Electron app? Controls bundled claude.exe resolution. */
  isPackaged?: boolean;
  /** Explicit Claude Code CLI path (overrides auto-detect). */
  claudeExecutablePath?: string | null;  /**
   * Optional: per-operation content snapshots for change rollback.
   * When present, FileChangeEvent payloads carry canRestore flags.
   */
  snapshots?: {
    has(sessionId: string, eventId: string): boolean;
    pathOf(sessionId: string, eventId: string): string | null;
    restore(sessionId: string, eventId: string): boolean;
    list(sessionId: string): string[];
    drop(sessionId: string, eventId: string): void;
    dropAll(sessionId: string): void;
  };
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
  /** SDK control request: reload skills from disk */
  reloadSkills?: () => Promise<unknown>;
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
  /** SDK control request: rewind tracked files to a user message checkpoint */
  rewindFiles?: (
    userMessageId: string,
    options?: { dryRun?: boolean },
  ) => Promise<{
    canRewind: boolean;
    error?: string;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
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
  /**
   * Bumped whenever the live stream is replaced or aborted. consumeQuery
   * captures the value at start and ignores late events from a dead stream.
   */
  streamGen: number;
  /** True if context has already been auto-compressed this session */
  compressed: boolean;
  /** SDK uuids of real user turns (persisted user messages, in order) */
  sdkUserMsgIds?: string[];
  /** After rewind: next fresh query resumes at this assistant message uuid */
  resumeAtAnchor?: string;
  /** Timestamp of last auto-compression (for cooldown) */
  lastCompressedAt?: number;
  /**
   * Pending context to prepend on the next fresh query after compression.
   * When set, the next continue() starts a NEW SDK session (no resume) and
   * prepends this summary so the model retains continuity without full history.
   */
  pendingSummaryPrefix?: string;
  /** In-memory transcript authority (hydrated from disk on demand). */
  items: ChatItem[];
  itemsHydrated: boolean;
  nextId: (prefix: string) => string;
  extraMcpServers?: Record<string, unknown>;
  extraAllowedTools?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  extraEnv?: Record<string, string>;
  skipCpa?: boolean;
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

function sameKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((k) => left.has(k));
}

function extrasChanged(
  prevServers: Record<string, unknown> | undefined,
  prevTools: string[] | undefined,
  nextServers: Record<string, unknown>,
  nextTools: string[],
): boolean {
  return (
    !sameKeySet(Object.keys(prevServers ?? {}), Object.keys(nextServers)) ||
    !sameKeySet(prevTools ?? [], nextTools)
  );
}

function titleFromPrompt(prompt: UserPrompt): string {
  const t = prompt.text.trim().replace(/\s+/g, " ");
  if (!t) {
    const names = prompt.attachments.map((a) => a.name).join(", ");
    return names ? `Files: ${names.slice(0, 40)}` : "New session";
  }
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
}

/** Display text for a user prompt (matches renderer bubble formatting). */
function displayPrompt(prompt: UserPrompt): string {
  const t = prompt.text.trim();
  if (prompt.attachments.length === 0) return t;
  return `${t}\n\n[Attached: ${prompt.attachments.map((a) => a.name).join(", ")}]`;
}

/** Page slice matching SessionArchive.loadItemsPage (no disk I/O). */
function pageChatItems(
  all: ChatItem[],
  opts?: { beforeId?: string; afterId?: string; limit?: number },
): TranscriptPage {
  const page = pageTranscriptItems(all, opts);
  // Shallow-copy items (same as getTranscript) so callers cannot mutate entry.items.
  return {
    ...page,
    items: page.items.map((i) => ({ ...i })),
  };
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
): block is {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
  id?: string;
} {
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

/**
 * True for SDK user messages that represent real user turns (not tool_result
 * frames or synthetic injections). These get checkpoints and rewind anchors.
 * In streaming-input mode the SDK does NOT replay pushed user messages back
 * into the message stream, so observed ones come from the CLI's persisted
 * transcript (e.g. after resume) — they match user turns by ordinal.
 */
function isSdkPersistedUserTurn(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const rec = msg as Record<string, unknown>;
  if (rec.type !== "user") return false;
  if (rec.isSynthetic === true || rec.isReplay === true) return false;
  const message = rec.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return true;
  if (Array.isArray(content)) {
    return !content.some(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: string }).type === "tool_result",
    );
  }
  return false;
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
  private readonly onNotification: SessionManagerDeps["onNotification"];
  private readonly isPackaged: boolean;
  private readonly claudeExecutablePath: string | null | undefined;

  private readonly sessions = new Map<string, SessionEntry>();
  private readonly compressor: ContextCompressor | undefined;
  private readonly snapshots: SessionManagerDeps["snapshots"];

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
    this.onNotification = deps.onNotification;
    this.compressor = deps.compressor;
    this.snapshots = deps.snapshots;
    this.isPackaged = Boolean(deps.isPackaged);
    this.claudeExecutablePath = deps.claudeExecutablePath;

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
            ...(stored.hiddenFromList ? { hiddenFromList: true } : {}),
            ...(stored.pinned ? { pinned: true } : {}),
          },
          abortController: null,
          sdkSessionId: stored.sdkSessionId,
          slashCommands: [],
          turnActive: false,
          streamGen: 0,
          compressed: false,
          items: [],
          itemsHydrated: false,
          nextId: createIdFactory(),
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
      .filter((e) => !e.summary.hiddenFromList)
      .map((e) => ({ ...e.summary }))
      .sort(
        (a, b) =>
          Number(b.pinned ?? 0) - Number(a.pinned ?? 0) ||
          b.updatedAt - a.updatedAt,
      );
  }

  getSummary(sessionId: string): SessionSummary | undefined {
    const e = this.sessions.get(sessionId);
    return e ? { ...e.summary } : undefined;
  }

  /** Pin / unpin a session to the top of the sidebar list. */
  setPinned(sessionId: string, pinned: boolean): SessionSummary | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    const next = { ...entry.summary };
    if (pinned) next.pinned = true;
    else delete next.pinned;
    entry.summary = next;
    this.persistSummary(entry);
    if (!entry.summary.hiddenFromList) this.emitSession({ ...entry.summary });
    return { ...entry.summary };
  }

  /** Rename a session title. */
  rename(sessionId: string, title: string): SessionSummary | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    entry.summary = { ...entry.summary, title: trimmed };
    this.persistSummary(entry);
    if (!entry.summary.hiddenFromList) this.emitSession({ ...entry.summary });
    return { ...entry.summary };
  }

  /** Delete a session: abort any live turn, drop it, remove its files. */
  delete(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    // Hide first so abort()'s session:updated broadcast can't resurrect it
    // in renderer lists mid-delete.
    entry.summary = { ...entry.summary, hiddenFromList: true };
    if (entry.turnActive || entry.summary.status === "running") {
      this.abort(sessionId);
    }
    this.sessions.delete(sessionId);
    this.archive?.remove(sessionId);
    return true;
  }

  /**
   * Snapshot for spawning a real `claude` TUI in a PTY.
   * Tears down the desktop SDK stream so the CLI can resume the same session.
   */
  releaseForCli(sessionId: string | null | undefined): {
    cwd: string;
    sdkSessionId?: string;
    model: string;
    env: Record<string, string>;
    claudePath: string | null;
  } {
    const settings = this.settings.get();
    const entry = sessionId ? this.sessions.get(sessionId) : undefined;
    if (entry) {
      this.abort(sessionId!);
    }
    const cwd =
      entry?.summary.cwd ||
      settings.lastProjectPath ||
      process.cwd();
    const claudePath =
      this.claudeExecutablePath ??
      getClaudeExecutablePath({
        isPackaged: this.isPackaged,
        resourcesPath: process.resourcesPath,
        userDataDir: "",
      });
    return {
      cwd,
      sdkSessionId: entry?.sdkSessionId,
      model: settings.defaultModel,
      env: this.cpa.buildProcessEnv(settings.defaultModel),
      claudePath,
    };
  }

  /** Full transcript (compress / rewind). Prefer memory once hydrated. */
  getTranscript(sessionId: string) {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.hydrateItems(entry);
      return entry.items.map((i) => ({ ...i }));
    }
    return this.archive?.loadItems(sessionId) ?? [];
  }

  /** Incremental UI restore — tail, before `beforeId`, or after `afterId`. */
  getTranscriptPage(
    sessionId: string,
    opts?: { beforeId?: string; afterId?: string; limit?: number },
  ) {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.hydrateItems(entry);
      return pageChatItems(entry.items, opts);
    }
    return (
      this.archive?.loadItemsPage(sessionId, opts) ?? {
        items: [],
        total: 0,
        hasMore: false,
        hasNewer: false,
      }
    );
  }

  saveTranscript(
    sessionId: string,
    items: ChatItem[],
    opts?: { replace?: boolean },
  ): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      if (opts?.replace) entry.items = items.slice();
      else {
        this.hydrateItems(entry);
        entry.items = mergeTranscriptItems(entry.items, items);
      }
      entry.itemsHydrated = true;
    }
    if (!this.archive) return;
    if (opts?.replace) this.archive.saveItems(sessionId, items);
    else this.archive.mergeSaveItems(sessionId, items);
  }

  private transcriptOf(entry: SessionEntry): TranscriptState {
    return { items: entry.items, optimisticUserTexts: [] };
  }

  private hydrateItems(entry: SessionEntry): void {
    if (entry.itemsHydrated) return;
    entry.items = this.archive?.loadItems(entry.summary.id) ?? [];
    entry.itemsHydrated = true;
  }

  private replaceTranscript(
    entry: SessionEntry,
    items: ChatItem[],
    opts: { persist: boolean; replace?: boolean },
  ): void {
    entry.items = items;
    entry.itemsHydrated = true;
    if (!opts.persist || !this.archive) return;
    // Main holds the full transcript — write it directly. mergeSaveItems
    // re-parses the whole file and was freezing 100+ turn sessions.
    this.archive.saveItems(entry.summary.id, items);
  }

  private applyAndMaybePersist(
    entry: SessionEntry,
    event: SdkNormalizedEvent,
  ): void {
    this.hydrateItems(entry);
    const next = applySdkEvent(this.transcriptOf(entry), event, {
      nextId: entry.nextId,
    });
    if (event.type === "user_msg_ids") {
      const bound = bindSdkUserMsgIds(next.items, event.uuids);
      if (bound !== next.items) {
        this.replaceTranscript(entry, bound, { persist: true });
      }
      return;
    }
    this.replaceTranscript(entry, next.items, {
      persist: shouldPersistTranscript(event),
      replace: event.type === "items_replaced",
    });
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

  /** Transcript + changes for IPC session:select (with canRestore flags). */
  getChangesForSelect(sessionId: string): FileChange[] {
    const cwd = this.sessions.get(sessionId)?.summary.cwd;
    this.diffTracker.markDeleted(sessionId, cwd);
    return this.listChanges(sessionId);
  }

  /** DiffTracker list + per-event canRestore flags from the snapshot store. */
  listChanges(sessionId: string): FileChange[] {
    const list = this.diffTracker.list(sessionId);
    if (!this.snapshots) return list;
    const snaps = this.snapshots;
    return list.map((c) => {
      const events = c.events.map((e) => ({
        ...e,
        canRestore: snaps.has(sessionId, e.id),
      }));
      return {
        ...c,
        events,
        canRestore: events.some((e) => e.canRestore),
      };
    });
  }

  /**
   * Roll back ONE write operation: restore the file to its content captured
   * just before eventId ran (i.e. after the previous operation on the file),
   * then drop eventId and all later events of the same file. Later
   * operations on OTHER files are untouched.
   */
  restoreChangeEvent(
    sessionId: string,
    eventId: string,
  ): { ok: boolean; error?: string } {
    if (!this.snapshots) return { ok: false, error: "Snapshots unavailable" };
    if (!this.snapshots.has(sessionId, eventId)) {
      return { ok: false, error: "No snapshot for this operation" };
    }
    const found = this.diffTracker.findByEvent(sessionId, eventId);
    if (!found) {
      return { ok: false, error: "No tracked change for this operation" };
    }
    const ok = this.snapshots.restore(sessionId, eventId);
    if (!ok) return { ok: false, error: "Failed to write restored content" };
    // Drop snapshots for the restored event and all later events of the file.
    const idx = found.change.events.findIndex((e) => e.id === eventId);
    for (const e of found.change.events.slice(idx)) {
      this.snapshots.drop(sessionId, e.id);
    }
    this.diffTracker.truncateAt(sessionId, found.path, eventId);
    this.emitDiffAndPersist(sessionId);
    return { ok: true };
  }

  /**
   * Legacy file-level rollback: restore the file to its pre-session content
   * (snapshot of its EARLIEST tracked operation).
   */
  restoreChange(
    sessionId: string,
    path: string,
  ): { ok: boolean; error?: string } {
    if (!this.snapshots) return { ok: false, error: "Snapshots unavailable" };
    const change = this.diffTracker.list(sessionId).find((c) => c.path === path);
    const first = change?.events[0];
    if (!first || !this.snapshots.has(sessionId, first.id)) {
      return { ok: false, error: "No snapshot for this file" };
    }
    return this.restoreChangeEvent(sessionId, first.id);
  }

  /**
   * Roll back every snapshotted operation of the session (each file returns
   * to its pre-session content). Failures stay tracked so the user can retry.
   */
  restoreAllChanges(sessionId: string): {
    restored: string[];
    failed: string[];
  } {
    const restored: string[] = [];
    const failed: string[] = [];
    if (!this.snapshots) {
      return {
        restored,
        failed: this.diffTracker.list(sessionId).map((c) => c.path),
      };
    }
    // Earliest event per file = pre-session content for that file.
    for (const change of this.diffTracker.list(sessionId)) {
      const first = change.events[0];
      if (!first || !this.snapshots.has(sessionId, first.id)) continue;
      if (this.snapshots.restore(sessionId, first.id)) {
        for (const e of change.events) this.snapshots.drop(sessionId, e.id);
        this.diffTracker.remove(sessionId, change.path);
        restored.push(change.path);
      } else {
        failed.push(change.path);
      }
    }
    this.emitDiffAndPersist(sessionId);
    return { restored, failed };
  }

  private emitDiffAndPersist(sessionId: string): void {
    // Sync deleted/reappeared files before pushing to the renderer.
    const cwd = this.sessions.get(sessionId)?.summary.cwd;
    this.diffTracker.markDeleted(sessionId, cwd);
    const list = this.listChanges(sessionId);
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

  /** Reload skills from disk for a running session + refresh slash list. */
  async reloadSkills(
    sessionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const entry = this.sessions.get(sessionId);
    if (!entry?.query?.reloadSkills) {
      return { ok: false, error: "No live session query" };
    }
    try {
      await entry.query.reloadSkills();
      await this.refreshSlashCommands(sessionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
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

  /**
   * Message-level rewind: restore tracked files to the checkpoint taken at
   * the given user message AND truncate the conversation so the next turn
   * resumes at that point (Claude Code "Esc Esc" semantics).
   *
   * Implementation: rewindFiles() needs the LIVE query's checkpoint table,
   * so the current stream is torn down and a throwaway resumed query is
   * opened to perform the rewind. The next continue() starts a fresh query
   * with resume + resumeSessionAt so the conversation continues from the
   * rewound point.
   */
  async rewindToUserMessage(
    sessionId: string,
    userMessageId: string,
    opts?: { dryRun?: boolean },
  ): Promise<{
    ok: boolean;
    canRewind?: boolean;
    filesChanged?: string[];
    insertions?: number;
    deletions?: number;
    error?: string;
  }> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: false, error: `Unknown session: ${sessionId}` };
    if (!entry.sdkSessionId) {
      return { ok: false, error: "Session has no SDK state to rewind" };
    }
    if (entry.turnActive) {
      return { ok: false, error: "Wait for the current turn to finish" };
    }

    try {
      // Prefer the live query (has checkpoints in memory); otherwise open a
      // throwaway resumed query purely to run the rewind.
      let q = entry.query;
      let ownQuery = false;
      if (!q?.rewindFiles) {
        const settings = this.settings.get();
        const env = this.cpa.buildProcessEnv(settings.defaultModel);
        const input = new MessageStream();
        q = this.queryFn({
          prompt: input as AsyncIterable<unknown>,
          options: {
            cwd: entry.summary.cwd,
            model: settings.defaultModel,
            env,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            maxTurns: 1,
            tools: [],
            strictMcpConfig: true,
            enableFileCheckpointing: true,
            settingSources: [],
            resume: entry.sdkSessionId,
          },
        }) as QueryHandle & QueryControl;
        ownQuery = true;
        // Drain in background so the CLI process can exit cleanly later.
        void (async () => {
          try {
            for await (const _ of q as QueryHandle) {
              // discard
            }
          } catch {
            // ignore
          }
        })();
        input.end();
      }

      const result = await q.rewindFiles!(userMessageId, {
        dryRun: Boolean(opts?.dryRun),
      });

      if (ownQuery) {
        try {
          (q as QueryHandle & QueryControl).close?.();
        } catch {
          // ignore
        }
      }

      if (opts?.dryRun) {
        return {
          ok: true,
          canRewind: result.canRewind,
          filesChanged: result.filesChanged ?? [],
          ...(result.insertions != null ? { insertions: result.insertions } : {}),
          ...(result.deletions != null ? { deletions: result.deletions } : {}),
          ...(result.error ? { error: result.error } : {}),
        };
      }

      if (!result.canRewind) {
        return {
          ok: false,
          canRewind: false,
          error: result.error ?? "Cannot rewind to this message",
        };
      }

      // Real rewind: tear down the live stream so the next continue() opens
      // a fresh query resuming AT the rewound user message.
      if (!ownQuery) {
        try {
          entry.input?.end();
          entry.query?.close?.();
        } catch {
          // ignore
        }
        try {
          await entry.consumer;
        } catch {
          // ignore
        }
        entry.input = undefined;
        entry.query = undefined;
        entry.consumer = undefined;
      }
      entry.resumeAtAnchor = userMessageId;
      // Truncate the tracked uuid list at the anchor.
      const idx = (entry.sdkUserMsgIds ?? []).indexOf(userMessageId);
      if (idx >= 0) {
        entry.sdkUserMsgIds = entry.sdkUserMsgIds!.slice(0, idx + 1);
      }
      // Truncate in-memory transcript at the rewound user bubble (inclusive).
      this.hydrateItems(entry);
      const itemIdx = entry.items.findIndex(
        (i) =>
          i.kind === "text" &&
          i.role === "user" &&
          i.sdkMsgId === userMessageId,
      );
      if (itemIdx >= 0) {
        this.replaceTranscript(entry, entry.items.slice(0, itemIdx + 1), {
          persist: true,
          replace: true,
        });
      }
      return {
        ok: true,
        canRewind: true,
        filesChanged: result.filesChanged ?? [],
        ...(result.insertions != null ? { insertions: result.insertions } : {}),
        ...(result.deletions != null ? { deletions: result.deletions } : {}),
      };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
  }

  syncExtras(sessionId: string, extras: SessionRunOpts): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const nextServers = extras.extraMcpServers ?? {};
    const nextTools = extras.extraAllowedTools ?? [];
    const changed = extrasChanged(
      entry.extraMcpServers,
      entry.extraAllowedTools,
      nextServers,
      nextTools,
    );
    entry.extraMcpServers = nextServers;
    entry.extraAllowedTools = nextTools;
    if (changed) this.abort(sessionId);
  }

  abort(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    // Mark the turn done immediately so waitForTurnIdle / UI unlock.
    // Without this, a hung interrupt leaves turnActive=true forever and
    // every subsequent continue() pushes into a dead stream then waits.
    entry.turnActive = false;
    if (entry.summary.status === "running") {
      entry.summary = {
        ...entry.summary,
        status: "idle",
        updatedAt: Date.now(),
      };
      if (!entry.summary.hiddenFromList) this.emitSession({ ...entry.summary });
      this.persistSummary(entry);
    }

    // Tell the renderer the turn ended (clears optimistic running / stop btn).
    this.emit({
      type: "result",
      sessionId,
      ok: true,
    });

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
      entry.abortController = null;
    }

    // Tear down the streaming session so the next continue() opens a fresh
    // resumed query instead of pushing into a closed/orphaned MessageStream.
    entry.streamGen += 1;
    try {
      entry.input?.end();
    } catch {
      // ignore
    }
    try {
      entry.query?.close?.();
    } catch {
      // ignore
    }
    entry.input = undefined;
    entry.query = undefined;
    entry.consumer = undefined;
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
   * Prefer in-memory items once hydrated; fall back to renderer items / disk
   * only when memory is empty.
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

    this.hydrateItems(entry);
    const current =
      entry.items.length > 0
        ? entry.items
        : Array.isArray(items)
          ? items
          : this.archive.loadItems(sessionId);

    if (current.length <= KEEP_RECENT_ITEMS) {
      return { ok: false, message: "Not enough history to compress" };
    }

    try {
      const result = await this.compressor.compress(current);
      if (result.compressedCount === 0) {
        return { ok: false, message: "Nothing to compress" };
      }
      this.replaceTranscript(entry, result.items, {
        persist: true,
        replace: true,
      });
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
        this.replaceTranscript(entry, withNote, {
          persist: true,
          replace: true,
        });
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
        // Compaction starts a fresh SDK session — rewind anchors/uuids reset.
        entry.resumeAtAnchor = undefined;
        entry.sdkUserMsgIds = [];
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
      // Compaction starts a fresh SDK session — rewind anchors/uuids no longer apply.
      entry.resumeAtAnchor = undefined;
      entry.sdkUserMsgIds = [];
      return { ok: true, message: `Compressed ${result.compressedCount} items` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Compression failed: ${message}` };
    }
  }

  async start(
    prompt: UserPrompt,
    cwd: string,
    opts?: SessionRunOpts,
  ): Promise<string> {
    if (!opts?.skipCpa) await this.ensureCpaOrThrow();

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
      title: opts?.title ?? titleFromPrompt(prompt),
      cwd,
      updatedAt: now,
      status: "running",
      ...(opts?.hiddenFromList ? { hiddenFromList: true } : {}),
    };
    const entry: SessionEntry = {
      summary,
      abortController: null,
      slashCommands: [],
      turnActive: true,
      streamGen: 0,
      compressed: false,
      items: [],
      itemsHydrated: true,
      nextId: createIdFactory(),
      extraMcpServers: opts?.extraMcpServers,
      extraAllowedTools: opts?.extraAllowedTools,
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(opts?.extraEnv ? { extraEnv: opts.extraEnv } : {}),
      ...(opts?.skipCpa ? { skipCpa: true } : {}),
    };
    this.sessions.set(sessionId, entry);
    opts?.onSessionId?.(sessionId);
    if (!summary.hiddenFromList) this.emitSession({ ...summary });
    this.persistSummary(entry);
    this.replaceTranscript(
      entry,
      appendUserItem(
        { items: entry.items, optimisticUserTexts: [] },
        opts?.persistText ?? displayPrompt(prompt),
        { nextId: entry.nextId, attachments: prompt.attachments },
      ).items,
      { persist: true },
    );

    await this.openStreamingSession(sessionId, content, { resume: false });
    return sessionId;
  }

  async continue(
    sessionId: string,
    prompt: UserPrompt,
    opts?: SessionRunOpts,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    let reopenForExtras = false;
    if (opts?.model && opts.model !== entry.model) {
      entry.model = opts.model;
      reopenForExtras = true;
    }
    if (opts?.replaceExtras) {
      const nextServers = opts.extraMcpServers ?? {};
      const nextTools = opts.extraAllowedTools ?? [];
      reopenForExtras = extrasChanged(
        entry.extraMcpServers,
        entry.extraAllowedTools,
        nextServers,
        nextTools,
      );
      entry.extraMcpServers = nextServers;
      entry.extraAllowedTools = nextTools;
    } else {
      if (opts?.extraMcpServers) {
        const incoming = Object.keys(opts.extraMcpServers);
        reopenForExtras = incoming.some((k) => !entry.extraMcpServers?.[k]);
        entry.extraMcpServers = {
          ...(entry.extraMcpServers ?? {}),
          ...opts.extraMcpServers,
        };
      }
      if (opts?.extraAllowedTools?.length) {
        const have = new Set(entry.extraAllowedTools ?? []);
        for (const t of opts.extraAllowedTools) {
          if (!have.has(t)) reopenForExtras = true;
          have.add(t);
        }
        entry.extraAllowedTools = [...have];
      }
    }
    if (opts?.hiddenFromList) entry.summary.hiddenFromList = true;
    if (opts?.title) entry.summary.title = opts.title;
    if (opts?.permissionMode) entry.permissionMode = opts.permissionMode;
    if (opts?.extraEnv) entry.extraEnv = opts.extraEnv;
    if (opts?.skipCpa) entry.skipCpa = true;

    if (!entry.skipCpa && !opts?.skipCpa) await this.ensureCpaOrThrow(sessionId);

    const { content, errors } = buildUserContent(prompt);
    if (errors.length) {
      this.emit({
        type: "result",
        sessionId,
        ok: false,
        error: errors.join("; "),
      });
    }

    this.hydrateItems(entry);
    const next = appendUserItem(
      { items: entry.items, optimisticUserTexts: [] },
      opts?.persistText ?? displayPrompt(prompt),
      { nextId: entry.nextId, attachments: prompt.attachments },
    );
    this.replaceTranscript(entry, next.items, { persist: true });

    entry.summary = {
      ...entry.summary,
      status: "running",
      updatedAt: Date.now(),
    };
    entry.turnActive = true;
    if (!entry.summary.hiddenFromList) this.emitSession({ ...entry.summary });
    this.persistSummary(entry);

    // Live streaming session: just push the next user message.
    // Skipped when a rewind anchor is pending — the conversation must be
    // re-opened truncated at the anchor, so force the resume path below.
    // Also skip if the stream was torn down by abort() (input closed / cleared).
    // Reopen when extra MCP/tools just changed so they attach to the query.
    if (
      entry.input &&
      !entry.input.isClosed &&
      entry.consumer &&
      !entry.resumeAtAnchor &&
      !reopenForExtras
    ) {
      try {
        entry.input.push(content, entry.sdkSessionId);
      } catch {
        // Stream closed between the check and push (e.g. concurrent abort) —
        // fall through to open a fresh resumed query.
        entry.input = undefined;
        entry.query = undefined;
        entry.consumer = undefined;
        await this.openStreamingSession(sessionId, content, { resume: true });
        return;
      }
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
    const env = {
      ...this.cpa.buildProcessEnv(entry.model || settings.defaultModel),
      ...(entry.extraEnv ?? {}),
    };
    // Prefer the bundled / vendor Claude Code binary so the app does not
    // require a global `claude` on PATH (packaged installs ship claude.exe).
    const claudePath =
      this.claudeExecutablePath ??
      getClaudeExecutablePath({
        isPackaged: this.isPackaged,
        resourcesPath: process.resourcesPath,
        userDataDir: "",
      });

    return {
      cwd: entry.summary.cwd,
      includePartialMessages: true,
      permissionMode: entry.permissionMode ?? settings.permissionMode,
      model: entry.model || settings.defaultModel,
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
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
        ...(entry.extraAllowedTools ?? []),
      ],
      // Load CLAUDE.md hierarchy (user → project → local) into the system
      // prompt, matching Claude Code. Must include 'project' for project CLAUDE.md.
      settingSources: ["user", "project", "local"],
      // Configured MCP servers (stdio/sse/http). Passed through as-is; the
      // config shape matches the SDK. Kept out of `env` so the CPA token is
      // never leaked into MCP server subprocesses.
      // Per-session extras (in-process room_mod_act) merge on top.
      ...(Object.keys(settings.mcpServers ?? {}).length ||
      Object.keys(entry.extraMcpServers ?? {}).length
        ? {
            mcpServers: {
              ...(settings.mcpServers ?? {}),
              ...(entry.extraMcpServers ?? {}),
            },
          }
        : {}),
      // Only use the MCP servers this app passes in — ignore project
      // .mcp.json, user settings, and plugin-declared servers so desktop
      // sessions have a single, explicit MCP surface (Settings → MCP servers).
      strictMcpConfig: true,
      // Track file checkpoints per user message so the UI can rewind
      // files (Query.rewindFiles) to any user turn.
      enableFileCheckpointing: true,
      // Custom subagents (Task/Agent tool picks them up by name).
      ...(settings.agents?.length
        ? {
            agents: Object.fromEntries(
              settings.agents.map((a) => [
                a.name,
                {
                  description: a.description,
                  prompt: a.prompt,
                  ...(a.tools?.length ? { tools: a.tools } : {}),
                  ...(a.model && a.model !== "inherit"
                    ? { model: a.model }
                    : {}),
                },
              ]),
            ),
          }
        : {}),
      // Local plugins (skills/hooks/agents/commands). skipMcpDiscovery keeps
      // app-configured MCP the single MCP surface (strictMcpConfig).
      ...(settings.pluginPaths?.length
        ? {
            plugins: settings.pluginPaths.map((p) => ({
              type: "local" as const,
              path: p,
              skipMcpDiscovery: true,
            })),
          }
        : {}),
      // Surface SDK Notification events (permission needed, idle, task done)
      // for desktop notifications.
      hooks: {
        Notification: [
          {
            hooks: [
              async (input: {
                message?: string;
                title?: string;
                notification_type?: string;
              }) => {
                this.onNotification?.({
                  sessionId,
                  message: String(input.message ?? ""),
                  ...(input.title ? { title: String(input.title) } : {}),
                  ...(input.notification_type
                    ? { notificationType: String(input.notification_type) }
                    : {}),
                });
                return {};
              },
            ],
          },
        ],
      },
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

    // Tear down any previous stream and invalidate its consumer via streamGen.
    entry.streamGen += 1;
    try {
      entry.input?.end();
      entry.query?.close?.();
    } catch {
      // ignore
    }

    const abortController = new AbortController();
    entry.abortController = abortController;
    entry.turnActive = true;
    const myGen = entry.streamGen;

    const input = new MessageStream();
    entry.input = input;

    const options = this.buildOptions(sessionId, entry, abortController);
    if (opts.resume) {
      options.resume = entry.sdkSessionId ?? sessionId;
      // After a rewind: resume the SDK session truncated at the anchor
      // (the rewound user message becomes the conversation tip).
      if (entry.resumeAtAnchor) {
        options.resumeSessionAt = entry.resumeAtAnchor;
        entry.resumeAtAnchor = undefined;
      }
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

      input.push(content, entry.sdkSessionId);

      // Control request on the same CLI competes with the first model call
      // on cold start — wait until after first-byte activity.
      const gen = myGen;
      setTimeout(() => {
        const cur = this.sessions.get(sessionId);
        if (!cur || cur.streamGen !== gen) return;
        void this.refreshSlashCommands(sessionId);
      }, 2500);
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
    // Capture generation so a later abort/reopen can make us stop mutating state.
    const myGen = entry.streamGen;

    try {
      for await (const msg of stream) {
        if (entry.streamGen !== myGen) break;
        if (entry.abortController?.signal.aborted) break;

        const sdkId = extractSdkSessionId(msg);
        if (sdkId) {
          entry.sdkSessionId = sdkId;
        }

        // Track SDK-persisted user message uuids (real user turns only) for
        // message-level rewind. Apply + emit so main-process items stay bound.
        if (isSdkPersistedUserTurn(msg)) {
          const uuid = (msg as { uuid?: unknown }).uuid;
          if (typeof uuid === "string" && uuid) {
            entry.sdkUserMsgIds = [...(entry.sdkUserMsgIds ?? []), uuid];
            const idsEvent: SdkNormalizedEvent = {
              type: "user_msg_ids",
              sessionId,
              uuids: [...entry.sdkUserMsgIds],
            };
            this.applyAndMaybePersist(entry, idsEvent);
            this.emit(idsEvent);
          }
        }

        this.handleToolUseForDiff(sessionId, msg);

        const events = normalizeSdkEvent(msg, sessionId);
        for (const event of events) {
          this.applyAndMaybePersist(entry, event);
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

      // Stream ended (input closed or process exit). Only touch state if we still
      // own this stream generation — abort() may already have opened a new one.
      if (entry.streamGen === myGen) {
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
      }
    } catch (err) {
      if (entry.streamGen !== myGen) return;
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
      // Only clear abortController if this consumer still owns the stream.
      if (entry.streamGen === myGen && entry.abortController) {
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
    const cwd = this.sessions.get(sessionId)?.summary.cwd;

    // tool_result: after Bash (or any tool), refresh known Bash paths + scan
    // the workspace for files scripts created that Edit/Write never saw.
    // Run off the consumeQuery loop so sync/async IO cannot stall tokens.
    if (rec.type === "user") {
      const message = rec.message as Record<string, unknown> | undefined;
      const content = message && Array.isArray(message.content) ? message.content : [];
      let hasToolResult = false;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;
        hasToolResult = true;
      }
      if (hasToolResult) {
        const entry = this.sessions.get(sessionId);
        const gen = entry?.streamGen;
        void this.diffTracker
          .refreshBashWritesFromDisk(sessionId, cwd)
          .then(() => {
            const cur = this.sessions.get(sessionId);
            if (!cur || (gen != null && cur.streamGen !== gen)) return;
            if (this.diffTracker.list(sessionId).length > 0) {
              this.emitDiffAndPersist(sessionId);
            }
          })
          .catch(() => undefined);
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
      this.diffTracker.onToolUse(sessionId, block.name, input, {
        cwd,
        toolUseId: typeof block.id === "string" ? block.id : undefined,
      });
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
