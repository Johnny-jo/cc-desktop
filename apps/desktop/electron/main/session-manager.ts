import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileEditRecovery } from "./file-edit-recovery";
import { roomSandboxSettings } from "./room-sandbox";
import type {
  ChatItem,
  FileChange,
  McpServersMap,
  McpSetServersResultDto,
  PermissionMode,
  ReasoningEffort,
  SdkNormalizedEvent,
  SessionMcpServerStatus,
  SessionSearchHit,
  SessionProgress,
  SessionSummary,
  SessionUsage,
  SlashCommandItem,
  TurnUsage,
  ToolCardState,
  TranscriptPageOptions,
} from "@claude-desktop/shared";
import type { PermissionBroker } from "./permission-broker";
import type { DiffTracker } from "./diff-tracker";
import type { ModelRuntime } from "./model-runtime";
import type { SettingsStore } from "./settings-store";
import type { UserPromptBroker } from "./user-prompt-broker";
import {
  mergeTranscriptItems,
  pageTranscriptItems,
  pageTranscriptTurns,
  type SessionArchive,
  type CompactIndex,
  type CompactHandoff,
  type CompactSnapshot,
  type StoredSession,
  type TranscriptPage,
} from "./session-archive";
import {
  applySdkEvent,
  appendUserItem,
  bindSdkUserMsgIds,
  computeContextUsage,
  resolveContextLimit,
  createIdFactory,
  shouldPersistTranscript,
  rebuildSessionProgress,
  restoreSessionProgress,
  taskListsEqual,
  updateSessionProgress,
  summarizeTurnFiles,
  type TranscriptState,
  type UserPrompt,
  type UserContentBlock,
} from "@claude-desktop/shared";
import { normalizeSdkEvent, sdkCostSnapshot, sdkContextEstimate, SdkTurnContext } from "./normalize-sdk-event";
import { MessageStream } from "./message-stream";
import { buildUserContent } from "./attachment-reader";
import {
  buildContinuationPrompt,
  contentContextBudget,
  type ContextCompressor,
} from "./context-compressor";
import { getClaudeExecutablePath } from "./runtime-paths";
import { resolveMcpServers } from "./playwright-mcp";
import { browserOutputSources, createToolOutputBinding, RESULT_SERVER, RESULT_TOOL, shellOutputBudget, type ToolOutputBinding } from "./tool-output-policy";
import { ToolOutputStore } from "./tool-output-store";
import path from "node:path";

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
  /**
   * 路径围栏（绝对路径）：设置后，文件类工具和 Bash 里的绝对路径 / `..` /
   * 重定向 / cd 都不能越出这个目录，越界直接拒绝，不进权限弹窗。
   * 同时为执行查询启用官方 Bash 沙箱；沙箱不可用时禁止无隔离回退。
   */
  pathJail?: string;
  /** Room turns only: enforce read-only tools in PreToolUse, regardless of SDK mode. */
  roomReadOnly?: boolean;
  /** Room task lifetime only; cancellation also fences asynchronous preparation. */
  roomAbortSignal?: AbortSignal;
  /** Approve leaving read-only for this turn; normal permissions/pathJail still apply. */
  requestRoomWriteAccess?: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<boolean>;
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
  /** Host-private SQLite location for recoverable personal-session tool results. */
  toolOutputDatabasePath?: string;
  /** Normalize outbound PDFs, including SDK resume history, before provider translation. */
  pdfCompatibility?: {
    environment: (env: Record<string, string>) => Promise<Record<string, string>>;
    dispose: () => void;
  };
  queryFn: QueryFn;
  permissionBroker: PermissionBroker;
  userPromptBroker?: UserPromptBroker;
  diffTracker: DiffTracker;
  cpa: ModelRuntime;
  settings: SettingsStore;
  /** Persist session index + transcripts across restarts */
  archive?: SessionArchive;
  readSdkMessages?: (id: string, cwd: string) => Promise<import("@anthropic-ai/claude-agent-sdk").SessionMessage[]>;
  emit: (event: SdkNormalizedEvent) => void;
  emitSession: (s: SessionSummary) => void;
  emitDiff: (sessionId: string, changes: FileChange[]) => void;
  /** Optional: notify UI when SDK slash/skills list is refreshed */
  emitSlashCommands?: (sessionId: string, commands: SlashCommandItem[]) => void;
  /** Optional: context compressor for /compact and idle fallback before the next turn. */
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
  /** Encrypted authorization store, read only by the local browser MCP process. */
  browserAuthStorePath?: string;
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
  getContextUsage?: (options: { detail: "summary" }) => Promise<unknown>;
  initializationResult?: () => Promise<{
    models?: Array<{
      value?: string;
      resolvedModel?: string;
      supportsEffort?: boolean;
      supportedEffortLevels?: string[];
    }>;
  }>;
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

type RoomAbortTurn = {
  signal: AbortSignal;
  cancelled: boolean;
  detach?: () => void;
};

type QueryExtras = {
  personalOutputs?: boolean;
  toolOutput?: ToolOutputBinding;
  tokenSavingsMode?: "standard" | "balanced";
  servers: Record<string, unknown>;
  allowedTools: string[];
  /** Root bound when the CLI was started; sandbox options cannot change live. */
  pathJail?: string;
};

type SessionEntry = {
  resetBoundaryId?: string;
  sdkCostBaseline?: StoredSession["sdkCostBaseline"];
  queryModel?: string;
  summary: SessionSummary;
  /** Progress before the retained transcript; never exposed in SessionSummary. */
  progressBaseline?: SessionProgress;
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
  desktopToolPrefixes?: string[];
  usedDesktopControl?: boolean;
  /** Last time this SDK query was opened or reused. */
  lastQueryUsedAt: number;
  /** Parks an idle SDK query so old sessions do not retain Claude children. */
  idleCloseTimer?: ReturnType<typeof setTimeout>;
  /**
   * Bumped whenever the live stream is replaced or aborted. consumeQuery
   * captures the value at start and ignores late events from a dead stream.
   */
  streamGen: number;
  /** SDK compaction owns the live query until its PostCompact hook or turn result. */
  nativeCompactQueryGen?: number;
  compactions?: CompactIndex[];
  pendingHandoff?: string;
  externalSummaryRoute?: boolean;
  syntheticHandoffUser?: boolean;
  compressing?: AbortController;
  autoCompactTimer?: ReturnType<typeof setTimeout>;
  rewindPending?: boolean;
  /** Changes at the start of a new prompt or an explicit lifecycle operation. */
  promptRevision?: number;
  /** SDK uuids of real user turns (persisted user messages, in order) */
  sdkUserMsgIds?: string[];
  /** After rewind: next fresh query resumes at this assistant message uuid */
  resumeAtAnchor?: string;
  /** Timestamp of last auto-compression (for cooldown) */
  lastCompressedAt?: number;
  /** In-memory transcript authority (hydrated from disk on demand). */
  items: ChatItem[];
  itemsHydrated: boolean;
  /** LRU timestamp for full transcript hydration (page reads do not hydrate). */
  lastTranscriptAccessAt: number;
  /** File changes are restored independently from transcript data. */
  changesHydrated: boolean;
  /** Monotonic LRU access order for hydrated file changes. */
  lastChangesAccessAt: number;
  nextId: (prefix: string) => string;
  extraMcpServers?: Record<string, unknown>;
  extraAllowedTools?: string[];
  /** Snapshot actually attached to the live query, not staged next-turn extras. */
  queryExtras?: QueryExtras;
  /** Resolved effort actually attached to the live SDK query. */
  queryEffort?: ReasoningEffort;
  model?: string;
  permissionMode?: PermissionMode;
  /** Room turns only: confine file tools to this root (see SessionRunOpts). */
  pathJail?: string;
  /** Replaced on every start/continue, even when the SDK query stays open. */
  roomReadOnlyTurn?: {
    requestWriteAccess: SessionRunOpts["requestRoomWriteAccess"];
    writeApproved: boolean;
  };
  /** Replaced before each room turn's preparation; old continuations lose ownership. */
  roomAbortTurn?: RoomAbortTurn;
  extraEnv?: Record<string, string>;
  skipCpa?: boolean;
};

function desktopToolPrefixes(servers: McpServersMap): string[] {
  // Attached browsers also hold an input lease; release their MCP transport at
  // the end of a turn. Isolated browser contexts can remain warm independently.
  return Object.entries(servers).filter(([, config]) => config.type === "windows-computer" ||
    (config.type === "playwright" && config.connection !== "isolated"))
    .map(([name]) => `mcp__${name}__`);
}

function isPersonalOutputSession(entry: SessionEntry): boolean {
  return !entry.summary.hiddenFromList && !entry.pathJail && !entry.roomAbortTurn && !entry.roomReadOnlyTurn;
}

/** Keep only a very small warm-query set; resume reopens parked sessions. */
const MAX_LIVE_QUERIES = 2;
export const MAX_HYDRATED_TRANSCRIPTS = 4;
export const MAX_HYDRATED_CHANGES = 2;
const IDLE_QUERY_TTL_MS = 60_000;
const STREAM_FLUSH_MS = 40;
const TOOL_PROGRESS_FLUSH_MS = 250;
const TRANSCRIPT_SAVE_DELAY_MS = 750;
const CHANGES_SAVE_DELAY_MS = 400;

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

function pathOutsideJail(rootResolved: string, raw: string): boolean {
  const trimmed = raw.replace(/^["']|["']$/g, "").trim();
  if (!trimmed) return false;
  if (
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("~\\") ||
    trimmed.startsWith("$HOME") ||
    trimmed.startsWith("$env:") ||
    /%USERPROFILE%/i.test(trimmed) ||
    /%HOMEDRIVE%/i.test(trimmed) ||
    /%HOMEPATH%/i.test(trimmed)
  ) {
    return true;
  }
  const resolved = path.resolve(rootResolved, trimmed);
  const rel = path.relative(rootResolved, resolved);
  // rel 以 ".." 开头说明逃出围栏；跨盘符时 relative 直接返回绝对路径。
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

function unquoteToken(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").trim();
}

/** 从 Bash/PowerShell 命令里抽出可能指向文件的片段。宁可误拦，不能放行越界写。 */
export function extractBashPathCandidates(command: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const t = unquoteToken(raw);
    if (t) out.push(t);
  };
  const text = command.replace(/[\r\n]+/g, " ");

  let m: RegExpExecArray | null;
  const winAbs = /[A-Za-z]:[\\/][^\s"'<>|&;]*/g;
  while ((m = winAbs.exec(text))) push(m[0]);

  const unixAbs = /(?:^|[\s"'=(])(\/(?!\/)[^\s"'<>|&;]*)/g;
  while ((m = unixAbs.exec(text))) push(m[1] ?? "");

  const redir = /(?:[\d]?)(?:>>?|<)\s*([^\s|&;]+)/g;
  while ((m = redir.exec(text))) push(m[1] ?? "");

  const cd =
    /(?:^|[\s;&|])(?:cd|chdir|pushd|Set-Location|Push-Location)\s+(?:-Path\s+|-LiteralPath\s+)?([^\s|&;]+)/gi;
  while ((m = cd.exec(text))) push(m[1] ?? "");

  const up = /(?:^|[\s"'=(])(\.\.(?:[\\/][^\s"'<>|&;]*)?)/g;
  while ((m = up.exec(text))) push(m[1] ?? "");

  // 中段逃逸：sub/../../x —— .. 前面贴着字符时上面的 up 抓不到。
  const mid = /(?:^|[\s"'=(])([^\s"'<>|&;]*[\\/]\.\.(?:[\\/][^\s"'<>|&;]*)?)/g;
  while ((m = mid.exec(text))) push(m[1] ?? "");

  return out;
}

/**
 * 路径围栏判定：返回越界原因（null = 放行）。
 * 文件类工具检查显式路径参数（file_path / path 都认）。
 * 不带路径的 Glob/Grep 默认落在 cwd（必在围栏内），直接放行。
 * Bash：从命令里抽出绝对路径、..、重定向、cd，越界直接拒，不进审批。
 */
export function pathJailViolation(
  root: string,
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const PATH_KEYS: Record<string, string[]> = {
    Read: ["file_path", "path"],
    Write: ["file_path", "path"],
    Edit: ["file_path", "path"],
    MultiEdit: ["file_path", "path"],
    NotebookEdit: ["notebook_path", "file_path", "path"],
    Glob: ["path"],
    Grep: ["path"],
    LS: ["path"],
  };
  const rootResolved = path.resolve(root);
  const deny = (raw: string) =>
    `已拒绝：${toolName} 试图访问工作区外的路径（${raw}）`;

  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    if (!command.trim()) return null;
    if (
      /(?:^|[;&|]\s*)(?:cd|chdir|pushd|Set-Location|Push-Location)(?:\s*(?:&&|\|\||;|$))/i.test(
        command,
      )
    ) {
      return deny("cd");
    }
    for (const raw of extractBashPathCandidates(command)) {
      if (pathOutsideJail(rootResolved, raw)) return deny(raw);
    }
    return null;
  }

  const keys = PATH_KEYS[toolName];
  if (!keys) return null;
  for (const key of keys) {
    const raw = input[key];
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (pathOutsideJail(rootResolved, raw)) return deny(raw);
  }
  return null;
}

function isSdkMcpServer(
  server: unknown,
): server is Record<string, unknown> & { type: "sdk" } {
  return (
    server != null && typeof server === "object" &&
    "type" in server && server.type === "sdk"
  );
}

function snapshotQueryExtras(entry: SessionEntry): QueryExtras {
  return {
    pathJail: entry.pathJail,
    servers: Object.fromEntries(
      Object.entries(entry.extraMcpServers ?? {}).map(([name, server]) => {
        // Transport configs are data, but SDK instances contain live task closures.
        // Copy their wrapper without cloning the instance or losing its identity.
        if (isSdkMcpServer(server)) {
          const { instance, ...config } = server;
          return [name, { ...structuredClone(config), instance }];
        }
        return [name, structuredClone(server)];
      }),
    ),
    allowedTools: [...(entry.extraAllowedTools ?? [])],
  };
}

function extrasChanged(
  prevServers: Record<string, unknown> | undefined,
  prevTools: string[] | undefined,
  nextServers: Record<string, unknown>,
  nextTools: string[],
): boolean {
  return (
    !sameKeySet(Object.keys(prevServers ?? {}), Object.keys(nextServers)) ||
    !sameKeySet(prevTools ?? [], nextTools) ||
    Object.entries(nextServers).some(([name, next]) => {
      const prev = prevServers?.[name];
      if (isSdkMcpServer(prev) || isSdkMcpServer(next)) {
        if (
          !isSdkMcpServer(prev) || !isSdkMcpServer(next) ||
          prev.instance !== next.instance
        ) return true;
      }
      return !isDeepStrictEqual(prev, next);
    })
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
  if (rec.parent_tool_use_id || rec.agent_id) return undefined;
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
  private readonly toolOutputStore: ToolOutputStore;
  private readonly queryFn: QueryFn;
  private readonly pdfCompatibility: SessionManagerDeps["pdfCompatibility"];
  private readonly permissionBroker: PermissionBroker;
  private readonly userPromptBroker: UserPromptBroker | undefined;
  private readonly diffTracker: DiffTracker;
  private readonly cpa: ModelRuntime;
  private readonly settings: SettingsStore;
  private readonly archive: SessionArchive | undefined;
  private readonly readSdkMessages: SessionManagerDeps["readSdkMessages"];
  private readonly emit: SessionManagerDeps["emit"];
  private readonly emitSession: SessionManagerDeps["emitSession"];
  private readonly emitDiff: SessionManagerDeps["emitDiff"];
  private readonly emitSlashCommands: SessionManagerDeps["emitSlashCommands"];
  private readonly onNotification: SessionManagerDeps["onNotification"];
  private readonly isPackaged: boolean;
  private readonly browserAuthStorePath: string | undefined;
  private readonly claudeExecutablePath: string | null | undefined;

  private readonly sessions = new Map<string, SessionEntry>();
  private readonly compressor: ContextCompressor | undefined;
  private readonly snapshots: SessionManagerDeps["snapshots"];
  private readonly pendingTranscriptSaves = new Map<string, ChatItem[]>();
  private readonly transcriptSaveTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly changesSaveTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Sessions whose current turn used a file-mutating tool. */
  private readonly pendingTurnDiffs = new Set<string>();
  /** Change-event ids and paths that already existed before this turn. */
  private readonly turnChangeBaselines = new Map<
    string,
    { eventIds: Set<string>; paths: Set<string> }
  >();
  private changesAccessSeq = 0;

  constructor(deps: SessionManagerDeps) {
    this.toolOutputStore = new ToolOutputStore(deps.toolOutputDatabasePath);
    this.queryFn = deps.queryFn;
    this.pdfCompatibility = deps.pdfCompatibility;
    this.permissionBroker = deps.permissionBroker;
    this.userPromptBroker = deps.userPromptBroker;
    this.diffTracker = deps.diffTracker;
    this.cpa = deps.cpa;
    this.settings = deps.settings;
    this.archive = deps.archive;
    this.readSdkMessages = deps.readSdkMessages;
    this.emit = deps.emit;
    this.emitSession = deps.emitSession;
    this.emitDiff = deps.emitDiff;
    this.emitSlashCommands = deps.emitSlashCommands;
    this.onNotification = deps.onNotification;
    this.compressor = deps.compressor;
    this.snapshots = deps.snapshots;
    this.isPackaged = Boolean(deps.isPackaged);
    this.browserAuthStorePath = deps.browserAuthStorePath;
    this.claudeExecutablePath = deps.claudeExecutablePath;

    // Restore only lightweight summaries. Transcripts and file changes hydrate
    // independently on demand so historical sessions do not dominate startup.
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
            ...(stored.contextCompression ? { contextCompression: stored.contextCompression.state === "running"
              ? { state: "failed" as const, updatedAt: Date.now(), message: "Compression was interrupted when the application closed" }
              : stored.contextCompression } : {}),
            ...(stored.hiddenFromList ? { hiddenFromList: true } : {}),
            ...(stored.pinned ? { pinned: true } : {}),
            ...(stored.progress ? { progress: stored.progress } : {}),
            ...(stored.taskPlan ? { taskPlan: stored.taskPlan } : {}),
          },
          abortController: null,
          sdkSessionId: stored.sdkSessionId,
          resetBoundaryId: stored.resetBoundaryId,
          model: stored.sessionModel,
          sdkCostBaseline: stored.sdkCostBaseline,
          progressBaseline: stored.progressBaseline,
          slashCommands: [],
          turnActive: false,
          lastQueryUsedAt: 0,
          streamGen: 0,
          compactions: stored.compactions,
          pendingHandoff: stored.pendingHandoff,
          externalSummaryRoute: stored.externalSummaryRoute,
          lastCompressedAt: stored.compactions?.at(-1)?.createdAt,
          items: [],
          itemsHydrated: false,
          lastTranscriptAccessAt: 0,
          changesHydrated: false,
          lastChangesAccessAt: 0,
          nextId: createIdFactory(),
        });
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

  /** Read-only access for the visible chat's local history viewer. */
  listCompactionHistory(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.summary.hiddenFromList) return [];
    return [...(session.compactions ?? [])].reverse();
  }

  getCompactionPage(sessionId: string, revision: string, offset: number) {
    const session = this.sessions.get(sessionId);
    if (!session || session.summary.hiddenFromList || !Number.isSafeInteger(offset) || offset < 0 ||
        typeof revision !== "string" || !this.archive) return { items: [], total: 0 };
    const snapshot = this.archive.loadCompaction(sessionId, revision);
    return { items: snapshot?.original.slice(offset, offset + 25) ?? [], total: snapshot?.original.length ?? 0 };
  }

  compactionSdkFile(sessionId: string, revision: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.summary.hiddenFromList || typeof revision !== "string") return;
    if (!session.compactions?.some(item => item.revision === revision && item.sdkMessageCount)) return;
    return this.archive?.compactionSdkFile(sessionId, revision);
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

  /** Close the displayed plan without changing execution or SDK task states. */
  setTaskPlanClosed(sessionId: string, closed: boolean): SessionSummary | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.summary.hiddenFromList) return undefined;
    this.restoreProgress(entry);
    if (Boolean(entry.summary.taskPlan) === closed) return { ...entry.summary };
    const previous = entry.summary;
    const next = { ...previous };
    if (closed) next.taskPlan = { closedAt: Date.now(), changedSinceClose: false };
    else delete next.taskPlan;
    entry.summary = next;
    try { this.persistSummary(entry); }
    catch (error) { entry.summary = previous; throw error; }
    this.emitSession({ ...entry.summary });
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

  private clearIdleCloseTimer(entry: SessionEntry): void {
    if (!entry.idleCloseTimer) return;
    clearTimeout(entry.idleCloseTimer);
    entry.idleCloseTimer = undefined;
  }

  /**
   * Close the warm SDK stream without changing conversation state. A later
   * continue() reopens it with resume=sdkSessionId.
   */
  private parkSession(entry: SessionEntry, force = false): void {
    if (!force && entry.turnActive) return;
    if (force) this.invalidateCompression(entry);
    clearTimeout(entry.autoCompactTimer);
    entry.autoCompactTimer = undefined;
    this.settleLiveAgents(entry, "unknown");
    entry.roomAbortTurn?.detach?.();
    this.clearIdleCloseTimer(entry);
    entry.streamGen += 1;
    try {
      entry.input?.end();
    } catch {
      // best effort
    }
    try {
      entry.query?.close?.();
    } catch {
      // best effort
    }
    entry.abortController = null;
    entry.input = undefined;
    entry.query = undefined;
    entry.queryExtras = undefined;
    entry.queryEffort = undefined;
    entry.consumer = undefined;
  }

  private scheduleIdleClose(entry: SessionEntry): void {
    this.clearIdleCloseTimer(entry);
    if (!entry.query || entry.turnActive) return;
    if (entry.usedDesktopControl) {
      // Closing this SDK stream closes the MCP's stdin and its native workers,
      // including elevated workers and attached browser leases. continue()
      // resumes the same SDK session without closing the user's browser.
      this.parkSession(entry);
      return;
    }
    const timer = setTimeout(() => {
      entry.idleCloseTimer = undefined;
      this.parkSession(entry);
    }, IDLE_QUERY_TTL_MS);
    timer.unref?.();
    entry.idleCloseTimer = timer;
    this.enforceLiveQueryCap(entry.summary.id);
    this.enforceTranscriptCacheCap(entry.summary.id);
  }

  private enforceLiveQueryCap(preferredSessionId?: string): void {
    const idle = [...this.sessions.values()]
      .filter(
        (entry) =>
          Boolean(entry.query) &&
          !entry.turnActive &&
          entry.summary.id !== preferredSessionId,
      )
      .sort((a, b) => a.lastQueryUsedAt - b.lastQueryUsedAt);
    const liveCount = [...this.sessions.values()].filter((entry) => entry.query).length;
    let excess = Math.max(0, liveCount - MAX_LIVE_QUERIES);
    for (const entry of idle) {
      if (excess <= 0) break;
      this.parkSession(entry);
      excess -= 1;
    }
  }

  private cancelPendingPersistence(sessionId: string): void {
    const transcriptTimer = this.transcriptSaveTimers.get(sessionId);
    if (transcriptTimer) clearTimeout(transcriptTimer);
    this.transcriptSaveTimers.delete(sessionId);
    this.pendingTranscriptSaves.delete(sessionId);
    const changesTimer = this.changesSaveTimers.get(sessionId);
    if (changesTimer) clearTimeout(changesTimer);
    this.changesSaveTimers.delete(sessionId);
  }

  /** Delete a session: abort any live turn, drop it, remove its files. */
  delete(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    // Hide first so abort()'s session:updated broadcast can't resurrect it
    // in renderer lists mid-delete.
    entry.summary = { ...entry.summary, hiddenFromList: true };
    if (entry.turnActive || entry.summary.status === "running") this.abort(sessionId);
    else this.parkSession(entry, true);
    this.cancelPendingPersistence(sessionId);
    this.sessions.delete(sessionId);
    this.toolOutputStore.remove(sessionId);
    this.diffTracker.clearSession(sessionId);
    this.snapshots?.dropAll(sessionId);
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
    opts?: TranscriptPageOptions & { beforeId?: string; afterId?: string },
  ): TranscriptPage {
    if (opts?.turnLimit && Number.isFinite(opts.turnLimit) && opts.turnLimit > 0) {
      return pageTranscriptTurns(cursor => this.getTranscriptPage(sessionId, cursor), opts);
    }
    const entry = this.sessions.get(sessionId);
    if (entry) {
      if (entry.itemsHydrated) {
        this.touchTranscript(entry);
        return pageChatItems(entry.items, opts);
      }
      // Renderer history restore should not pin the full conversation in the
      // main process. The archive reads only chunks intersecting this page.
      this.restoreProgress(entry);
      const page = this.archive?.loadItemsPage(sessionId, opts) ?? {
          items: [],
          total: 0,
          hasMore: false,
          hasNewer: false,
        };
      return { ...page, items: this.restoreTranscriptAgents(entry, page.items) };
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

  /** Sidebar search: full-text match over persisted transcript bodies. */
  searchTranscripts(query: string, limit?: number): SessionSearchHit[] {
    return this.archive?.database?.searchTranscripts(query, limit) ?? [];
  }

  saveTranscript(
    sessionId: string,
    items: ChatItem[],
    opts?: { replace?: boolean },
  ): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      if (entry.resetBoundaryId) {
        this.hydrateItems(entry);
        const start = this.activeTranscriptStart(entry);
        const boundary = items.findIndex(item => item.id === entry.resetBoundaryId);
        if (boundary >= 0) {
          items = opts?.replace ? [...entry.items.slice(0, start), ...items.slice(boundary + 1)] : items.slice(boundary + 1);
        } else {
          // A delayed renderer page cannot publish or replace history across a reset.
          if (opts?.replace) return;
          const activeIds = new Set(entry.items.slice(start).map(item => item.id));
          items = items.filter(item => activeIds.has(item.id));
        }
      }
      if (opts?.replace) {
        entry.items = items.slice();
        entry.itemsHydrated = true;
        entry.progressBaseline = undefined;
        this.setProgress(entry, rebuildSessionProgress(entry.items.slice(this.activeTranscriptStart(entry))) ?? { tasks: [], agents: [] });
      } else {
        this.hydrateItems(entry);
        entry.items = mergeTranscriptItems(entry.items, items);
      }
      this.touchTranscript(entry);
    }
    if (!this.archive) return;
    if (entry) this.scheduleTranscriptPersist(sessionId, entry.items);
    else if (opts?.replace) this.archive.saveItems(sessionId, items);
    else this.archive.mergeSaveItems(sessionId, items);
  }

  private transcriptOf(entry: SessionEntry): TranscriptState {
    return { items: entry.items, optimisticUserTexts: [] };
  }

  private hydrateItems(entry: SessionEntry): void {
    if (!entry.itemsHydrated) {
      const items = this.archive?.loadItems(entry.summary.id) ?? [];
      this.restoreProgress(entry, items);
      entry.items = this.restoreTranscriptAgents(entry, items);
      if (!entry.sdkUserMsgIds && entry.resetBoundaryId) {
        entry.sdkUserMsgIds = items.slice(this.activeTranscriptStart(entry, items)).flatMap(item =>
          item.kind === "text" && item.role === "user" && !item.historicalTurn && item.sdkMsgId ? [item.sdkMsgId] : []);
      }
      entry.itemsHydrated = true;
    }
    this.touchTranscript(entry);
  }

  private touchTranscript(entry: SessionEntry): void {
    entry.lastTranscriptAccessAt = Date.now();
    this.enforceTranscriptCacheCap(entry.summary.id);
  }

  private activeTranscriptStart(entry: SessionEntry, items: ChatItem[] = entry.items): number {
    if (!entry.resetBoundaryId) return 0;
    const index = items.findIndex(item => item.id === entry.resetBoundaryId);
    return index < 0 ? items.length : index + 1;
  }

  private enforceTranscriptCacheCap(preferredSessionId?: string): void {
    const hydrated = [...this.sessions.values()].filter(
      (entry) => entry.itemsHydrated,
    );
    let excess = hydrated.length - MAX_HYDRATED_TRANSCRIPTS;
    if (excess <= 0) return;
    const candidates = hydrated
      .filter(
        (entry) =>
          entry.summary.id !== preferredSessionId &&
          !entry.turnActive &&
          entry.summary.status !== "running",
      )
      .sort((a, b) => a.lastTranscriptAccessAt - b.lastTranscriptAccessAt);
    for (const entry of candidates) {
      if (excess <= 0) break;
      const sessionId = entry.summary.id;
      const timer = this.transcriptSaveTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this.transcriptSaveTimers.delete(sessionId);
      this.flushTranscriptPersist(sessionId);
      entry.items = [];
      entry.itemsHydrated = false;
      entry.lastTranscriptAccessAt = 0;
      this.archive?.releaseItems(sessionId);
      excess -= 1;
    }
  }

  private hydrateChanges(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (!entry.changesHydrated) {
      this.diffTracker.hydrate(
        sessionId,
        this.archive?.loadChanges(sessionId) ?? [],
      );
      entry.changesHydrated = true;
    }
    this.touchChanges(entry);
  }

  private touchChanges(entry: SessionEntry): void {
    this.changesAccessSeq += 1;
    entry.lastChangesAccessAt = this.changesAccessSeq;
    this.enforceChangesCacheCap(entry.summary.id);
  }

  private enforceChangesCacheCap(preferredSessionId?: string): void {
    const hydrated = [...this.sessions.values()].filter(
      (entry) => entry.changesHydrated,
    );
    let excess = hydrated.length - MAX_HYDRATED_CHANGES;
    if (excess <= 0) return;
    const candidates = hydrated
      .filter(
        (entry) =>
          entry.summary.id !== preferredSessionId &&
          !entry.turnActive &&
          entry.summary.status !== "running",
      )
      .sort((a, b) => a.lastChangesAccessAt - b.lastChangesAccessAt);
    for (const entry of candidates) {
      if (excess <= 0) break;
      const sessionId = entry.summary.id;
      const timer = this.changesSaveTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.changesSaveTimers.delete(sessionId);
        this.archive?.saveChanges(sessionId, this.diffTracker.list(sessionId));
      }
      this.diffTracker.clearSession(sessionId);
      entry.changesHydrated = false;
      entry.lastChangesAccessAt = 0;
      excess -= 1;
    }
  }

  private replaceTranscript(
    entry: SessionEntry,
    items: ChatItem[],
    opts: { persist: boolean; replace?: boolean },
  ): void {
    entry.items = items;
    entry.itemsHydrated = true;
    this.touchTranscript(entry);
    if (!opts.persist || !this.archive) return;
    // Main holds the full transcript. Delay and collapse writes so tool-heavy
    // turns do not repeatedly stringify the same 100+ turn history.
    this.scheduleTranscriptPersist(entry.summary.id, items);
  }

  private scheduleTranscriptPersist(sessionId: string, items: ChatItem[]): void {
    if (!this.archive) return;
    this.pendingTranscriptSaves.set(sessionId, items);
    const previous = this.transcriptSaveTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.transcriptSaveTimers.delete(sessionId);
      this.flushTranscriptPersist(sessionId);
    }, TRANSCRIPT_SAVE_DELAY_MS);
    timer.unref?.();
    this.transcriptSaveTimers.set(sessionId, timer);
  }

  private flushTranscriptPersist(sessionId: string): void {
    const items = this.pendingTranscriptSaves.get(sessionId);
    this.pendingTranscriptSaves.delete(sessionId);
    if (!items || !this.archive) return;
    this.archive.saveItems(sessionId, items);
  }

  private applyAndMaybePersist(
    entry: SessionEntry,
    event: SdkNormalizedEvent,
    nextId = entry.nextId,
  ): void {
    this.hydrateItems(entry);
    const toolId = event.type === "tool_start" || event.type === "tool_end"
      ? event.tool.id
      : event.type === "tool_progress" ? event.toolUseId : undefined;
    const previousTool = toolId ? this.resolveTool(entry, toolId) : undefined;
    this.setProgress(entry, updateSessionProgress(entry.summary.progress, event, previousTool));
    const next = applySdkEvent(this.transcriptOf(entry), event, {
      nextId,
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
    this.archive?.upsertSummary(this.storedSummary(entry));
  }

  private storedSummary(entry: SessionEntry): StoredSession {
    return {
      ...entry.summary,
      // Legacy JSON archives merge summaries; explicitly clear a reopened plan.
      taskPlan: entry.summary.taskPlan,
      sessionModel: entry.model,
      sdkCostBaseline: entry.sdkCostBaseline,
      resetBoundaryId: entry.resetBoundaryId,
      contextUsage: entry.summary.contextUsage,
      progressBaseline: entry.progressBaseline,
      sdkSessionId: entry.pendingHandoff ? undefined : entry.sdkSessionId,
      externalSummaryRoute: entry.externalSummaryRoute || Boolean(entry.skipCpa || entry.extraEnv?.ANTHROPIC_BASE_URL),
      pendingHandoff: entry.pendingHandoff,
      compactions: entry.compactions,
    };
  }

  /** Cache even an empty backfill; subsequent pages must not rescan history. */
  private restoreProgress(entry: SessionEntry, items?: ChatItem[]): void {
    if (entry.summary.hiddenFromList || entry.summary.progress) return;
    const progress = items
      ? restoreSessionProgress(rebuildSessionProgress(items, entry.progressBaseline))
      : this.archive?.loadProgress(entry.summary.id, entry.progressBaseline);
    this.setProgress(entry, progress ?? { tasks: [], agents: [] }, false);
  }

  /** Progress is session-wide, independent of the renderer's transcript page. */
  private setProgress(entry: SessionEntry, progress: SessionProgress | undefined, trackChanges = true): void {
    if (entry.summary.hiddenFromList || progress === entry.summary.progress) return;
    if (trackChanges && entry.summary.taskPlan && !entry.summary.taskPlan.changedSinceClose &&
        !taskListsEqual(entry.summary.progress?.tasks, progress?.tasks)) {
      entry.summary = { ...entry.summary, taskPlan: { ...entry.summary.taskPlan, changedSinceClose: true } };
    }
    entry.summary = { ...entry.summary, progress };
    this.persistSummary(entry);
    this.emitSession({ ...entry.summary });
  }

  private resolveTool(entry: SessionEntry, id: string): ToolCardState | undefined {
    for (let index = entry.items.length - 1; index >= 0; index -= 1) {
      const item = entry.items[index];
      if (item.kind === "tool" && (item.tool.id === id || item.tool.agent?.id === id)) return item.tool;
    }
    return undefined;
  }

  private restoreTranscriptAgents(entry: SessionEntry, items: ChatItem[]): ChatItem[] {
    if (entry.summary.hiddenFromList) return items;
    return items.map(item => {
      if (item.kind !== "tool" || !item.tool.agent) return item;
      const agent = item.tool.agent;
      const snapshot = entry.summary.progress?.agents.find(value => value.id === agent.id || value.toolUseId === item.tool.id);
      const restored = snapshot ?? (!entry.query && (agent.status === "running" || agent.status === "paused")
        ? { ...agent, status: "unknown" as const } : agent);
      return restored === agent ? item : { ...item, tool: { ...item.tool, agent: restored } };
    });
  }

  /** Losing the SDK stream is not proof of completion. Only explicit abort is a stop. */
  private settleLiveAgents(entry: SessionEntry, status: "unknown" | "stopped"): void {
    if (entry.summary.hiddenFromList) return;
    for (const agent of entry.summary.progress?.agents ?? []) {
      if (agent.status !== "running" && agent.status !== "paused") continue;
      const event: SdkNormalizedEvent = { type: "agent_progress", sessionId: entry.summary.id, agent: { id: agent.id, toolUseId: agent.toolUseId, status } };
      this.applyAndMaybePersist(entry, event);
      this.emit(event);
    }
  }

  private scheduleChangesPersist(sessionId: string): void {
    if (!this.archive) return;
    const previous = this.changesSaveTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.changesSaveTimers.delete(sessionId);
      this.archive?.saveChanges(sessionId, this.diffTracker.list(sessionId));
    }, CHANGES_SAVE_DELAY_MS);
    timer.unref?.();
    this.changesSaveTimers.set(sessionId, timer);
  }

  /** Flush delayed transcript/diff writes before shutdown or deterministic tests. */
  flushPendingPersistence(): void {
    for (const timer of this.transcriptSaveTimers.values()) clearTimeout(timer);
    this.transcriptSaveTimers.clear();
    for (const sessionId of [...this.pendingTranscriptSaves.keys()]) {
      this.flushTranscriptPersist(sessionId);
    }
    for (const [sessionId, timer] of this.changesSaveTimers) {
      clearTimeout(timer);
      this.archive?.saveChanges(sessionId, this.diffTracker.list(sessionId));
    }
    this.changesSaveTimers.clear();
  }

  /** Lightweight diagnostics for regression tests and future memory telemetry. */
  getMemoryStats(): {
    hydratedTranscripts: number;
    hydratedItems: number;
    hydratedChanges: number;
    trackedChangeFiles: number;
    liveQueries: number;
  } {
    let hydratedTranscripts = 0;
    let hydratedItems = 0;
    let hydratedChanges = 0;
    let trackedChangeFiles = 0;
    let liveQueries = 0;
    for (const entry of this.sessions.values()) {
      if (entry.itemsHydrated) {
        hydratedTranscripts += 1;
        hydratedItems += entry.items.length;
      }
      if (entry.changesHydrated) {
        hydratedChanges += 1;
        trackedChangeFiles += this.diffTracker.list(entry.summary.id).length;
      }
      if (entry.query) liveQueries += 1;
    }
    return {
      hydratedTranscripts,
      hydratedItems,
      hydratedChanges,
      trackedChangeFiles,
      liveQueries,
    };
  }

  /** Transcript + changes for IPC session:select (with canRestore flags). */
  getChangesForSelect(sessionId: string): FileChange[] {
    this.hydrateChanges(sessionId);
    const cwd = this.sessions.get(sessionId)?.summary.cwd;
    this.diffTracker.markDeleted(sessionId, cwd);
    return this.listChanges(sessionId);
  }

  /** DiffTracker list + per-event canRestore flags from the snapshot store. */
  listChanges(sessionId: string): FileChange[] {
    this.hydrateChanges(sessionId);
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
    this.hydrateChanges(sessionId);
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
    this.hydrateChanges(sessionId);
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
    this.hydrateChanges(sessionId);
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

  /**
   * Roll back exactly one task card. Every target must still be the latest
   * contiguous suffix for its file; otherwise nothing is changed. This guard
   * prevents an older card from silently erasing edits made by later tasks.
   */
  restoreTurnChanges(
    sessionId: string,
    files: import("@claude-desktop/shared").TurnChangeRestoreTarget[],
  ): { restored: string[]; failed: string[]; error?: string } {
    this.hydrateChanges(sessionId);
    if (!this.snapshots || files.length === 0) {
      return {
        restored: [],
        failed: files.map((file) => file.path),
        error: "Task snapshots are unavailable",
      };
    }

    const changes = this.diffTracker.list(sessionId);
    const plans: Array<{
      path: string;
      firstEventId: string;
      suffixEventIds: string[];
    }> = [];

    for (const file of files) {
      const targetIds = [...new Set(file.eventIds)].filter(Boolean);
      const change = changes.find((item) => item.path === file.path);
      const firstIndex = change
        ? change.events.findIndex((event) => event.id === targetIds[0])
        : -1;
      const suffix =
        change && firstIndex >= 0 ? change.events.slice(firstIndex) : [];
      const isExactLatestSuffix =
        targetIds.length > 0 &&
        suffix.length === targetIds.length &&
        suffix.every((event, index) => event.id === targetIds[index]);
      const firstEventId = targetIds[0];

      if (
        !change ||
        !firstEventId ||
        !isExactLatestSuffix ||
        !this.snapshots.has(sessionId, firstEventId)
      ) {
        return {
          restored: [],
          failed: files.map((item) => item.path),
          error:
            "This task is no longer the latest edit; no files were changed",
        };
      }

      plans.push({
        path: change.path,
        firstEventId,
        suffixEventIds: suffix.map((event) => event.id),
      });
    }

    const restored: string[] = [];
    const failed: string[] = [];
    for (const plan of plans) {
      if (!this.snapshots.restore(sessionId, plan.firstEventId)) {
        failed.push(plan.path);
        continue;
      }
      for (const eventId of plan.suffixEventIds) {
        this.snapshots.drop(sessionId, eventId);
      }
      this.diffTracker.truncateAt(
        sessionId,
        plan.path,
        plan.firstEventId,
      );
      restored.push(plan.path);
    }
    this.emitDiffAndPersist(sessionId);
    return { restored, failed };
  }

  private emitDiffAndPersist(sessionId: string): void {
    this.hydrateChanges(sessionId);
    // Sync deleted/reappeared files before pushing to the renderer.
    const cwd = this.sessions.get(sessionId)?.summary.cwd;
    this.diffTracker.markDeleted(sessionId, cwd);
    const list = this.listChanges(sessionId);
    this.emitDiff(sessionId, list);
    this.scheduleChangesPersist(sessionId);
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
      if (name === RESULT_SERVER && !enabled) entry.queryExtras?.toolOutput?.sources.clear();
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
      const resolved: Record<string, unknown> = resolveMcpServers(servers, this.isPackaged, !entry.pathJail && !entry.roomReadOnlyTurn, entry.summary.title, this.browserAuthStorePath);
      const extras = entry.queryExtras;
      const binding = extras?.toolOutput;
      // Stop classifying results while live transports are changing. A replacement
      // server with an old browser name cannot inherit the old output policy.
      binding?.sources.clear();
      if (binding) {
        if (RESULT_SERVER in resolved) binding.revoke();
        else resolved[RESULT_SERVER] = binding.server;
      }
      const result = await entry.query.setMcpServers(resolved);
      if (extras) extras.tokenSavingsMode = undefined; // rebuild host bindings on the next turn
      entry.desktopToolPrefixes = desktopToolPrefixes(servers);
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
    const claudePath = this.resolveClaudePath();
    const q = this.queryFn({
      prompt: "Reply with exactly: ok",
      options: {
        cwd: process.cwd(),
        model: settings.defaultModel,
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        env,
        // Bypass tool permission prompts — the probe prompt needs no tools.
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        tools: [],
        strictMcpConfig: true,
        mcpServers: resolveMcpServers(target, this.isPackaged, true, "浏览器连接测试", this.browserAuthStorePath),
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
        const pending = Object.keys(target).some((name) => {
          const server = statuses.find((s) => s.name === name);
          return !server || server.status === "pending";
        });
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
    if (!opts?.dryRun) this.invalidateCompression(entry);
    if (!entry.sdkSessionId) {
      return { ok: false, error: "Session has no SDK state to rewind" };
    }
    if (entry.turnActive) {
      return { ok: false, error: "Wait for the current turn to finish" };
    }

    if (entry.resetBoundaryId) {
      this.hydrateItems(entry);
      const active = entry.items.slice(this.activeTranscriptStart(entry));
      if (!active.some(item => item.kind === "text" && !item.historicalTurn && item.sdkMsgId === userMessageId)) {
        return { ok: false, error: "This checkpoint is outside the current SDK conversation" };
      }
    }

    if (entry.rewindPending) return { ok: false, error: "A rewind is already pending" };
    entry.rewindPending = true;
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
        entry.queryExtras = undefined;
        entry.queryEffort = undefined;
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
        const { taskPlan: _closedPlan, ...openSummary } = entry.summary;
        entry.summary = openSummary;
        const retained = entry.items.slice(0, itemIdx + 1);
        const target = retained[itemIdx];
        if (target.kind === "text") {
          const { turnOutcome: _discardedOutcome, ...pendingUser } = target;
          retained[itemIdx] = pendingUser;
        }
        this.replaceTranscript(entry, retained, {
          persist: true,
          replace: true,
        });
        this.setProgress(entry, rebuildSessionProgress(entry.items.slice(this.activeTranscriptStart(entry)), entry.progressBaseline));
      } else this.toolOutputStore.remove(sessionId); // No verified local anchor can authorize an older result.
      return {
        ok: true,
        canRewind: true,
        filesChanged: result.filesChanged ?? [],
        ...(result.insertions != null ? { insertions: result.insertions } : {}),
        ...(result.deletions != null ? { deletions: result.deletions } : {}),
      };
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    } finally {
      entry.rewindPending = false;
    }
  }

  syncExtras(sessionId: string, extras: SessionRunOpts): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const nextServers = extras.extraMcpServers ?? {};
    const nextTools = extras.extraAllowedTools ?? [];
    const changed = extrasChanged(
      entry.queryExtras?.servers ?? entry.extraMcpServers,
      entry.queryExtras?.allowedTools ?? entry.extraAllowedTools,
      nextServers,
      nextTools,
    );
    entry.extraMcpServers = nextServers;
    entry.extraAllowedTools = nextTools;
    if (changed) this.abort(sessionId);
  }

  private roomTurnCancelled(entry: SessionEntry, turn = entry.roomAbortTurn): boolean {
    return Boolean(turn && (
      entry.roomAbortTurn !== turn || turn.cancelled || turn.signal.aborted
    ));
  }

  private throwIfRoomTurnCancelled(entry: SessionEntry, turn = entry.roomAbortTurn): void {
    if (this.roomTurnCancelled(entry, turn)) {
      throw new DOMException("Room turn cancelled or superseded", "AbortError");
    }
  }

  private listenForRoomAbort(entry: SessionEntry): void {
    const turn = entry.roomAbortTurn;
    if (!turn) return;
    turn.detach?.();
    const onAbort = () => {
      if (entry.roomAbortTurn === turn) this.abort(entry.summary.id);
    };
    turn.signal.addEventListener("abort", onAbort, { once: true });
    turn.detach = () => turn.signal.removeEventListener("abort", onAbort);
    if (turn.signal.aborted) onAbort();
  }

  private setRoomAbortSignal(entry: SessionEntry, signal?: AbortSignal): RoomAbortTurn | undefined {
    entry.roomAbortTurn?.detach?.();
    entry.roomAbortTurn = signal ? { signal, cancelled: false } : undefined;
    this.listenForRoomAbort(entry);
    return entry.roomAbortTurn;
  }

  abort(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.invalidateCompression(entry);
    const wasRunning = entry.turnActive || entry.summary.status === "running";
    this.settleLiveAgents(entry, "stopped");
    if (entry.roomAbortTurn) {
      entry.roomAbortTurn.cancelled = true;
      entry.roomAbortTurn.detach?.();
    }
    this.clearIdleCloseTimer(entry);

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
    const resultEvent: SdkNormalizedEvent = {
      type: "result",
      sessionId,
      ok: false,
      outcome: "interrupted",
    };
    if (wasRunning) {
      this.applyAndMaybePersist(entry, resultEvent);
      this.emit(resultEvent);
    }

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
    entry.queryExtras = undefined;
    entry.queryEffort = undefined;
    entry.consumer = undefined;
    this.enforceTranscriptCacheCap();
  }

  /** Close streaming input for a session (e.g. window quit). */
  closeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.parkSession(entry, true);
  }

  /** Release every SDK child and flush delayed writes, including hidden room sessions. */
  disposeAll(): void {
    for (const entry of this.sessions.values()) this.parkSession(entry, true);
    this.flushPendingPersistence();
    this.pdfCompatibility?.dispose();
    this.toolOutputStore.close();
  }

  /** Publish an idle session's summary and retained turns for the next fresh SDK query. */
  async compressSession(
    sessionId: string,
    items?: import("@claude-desktop/shared").ChatItem[],
    opts?: { autoContinue?: boolean },
  ): Promise<{ ok: boolean; message?: string; cancelled?: boolean }> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: false, message: "Session not found" };
    const roomTurn = entry.roomAbortTurn;
    if (this.roomTurnCancelled(entry, roomTurn)) {
      return { ok: false, message: "Room turn cancelled" };
    }
    if (!this.compressor || !this.archive) {
      return { ok: false, message: "Compression not available" };
    }

    if (entry.externalSummaryRoute || entry.skipCpa || entry.extraEnv?.ANTHROPIC_BASE_URL) {
      return { ok: false, message: "This session uses another resource owner's model route" };
    }
    if (entry.turnActive || entry.rewindPending || entry.resumeAtAnchor || entry.summary.status === "running" || entry.nativeCompactQueryGen === entry.streamGen) {
      return { ok: false, message: "Session is still running; compress after the turn finishes" };
    }
    if (entry.compressing || entry.pendingHandoff) return { ok: false, message: "Compression already pending" };
    if (entry.lastCompressedAt && Date.now() - entry.lastCompressedAt < 5 * 60 * 1000) {
      return { ok: false, message: "Compression cooldown — try again shortly" };
    }

    this.hydrateItems(entry);
    const originalItems = entry.items;
    const visible = originalItems.length ? originalItems : items ?? [];
    const start = this.activeTranscriptStart(entry, visible);
    const current = visible.slice(start);
    const settings = this.settings.get();
    const model = entry.model || settings.defaultModel;
    const summaryModel = this.summaryModel(entry);
    const catalog = this.cpa.getModelCatalog();
    const mainLimit = resolveContextLimit(model, settings, catalog).limitTokens;
    const controller = new AbortController();
    entry.compressing = controller;
    const gen = entry.streamGen;
    const signal = roomTurn ? AbortSignal.any([controller.signal, roomTurn.signal]) : controller.signal;
    let failure = "Compression did not complete";
    let committed = false;
    const fail = (message: string) => { failure = message; return { ok: false, message, cancelled: signal.aborted || gen !== entry.streamGen }; };
    this.publishCompression(entry, { state: "running", updatedAt: Date.now() }, false);
    try {
      const result = await this.compressor.compress(current, {
        signal, force: true, model: summaryModel, contextLimit: resolveContextLimit(summaryModel, settings, catalog).limitTokens,
        recentBudget: Math.min(16_000, Math.floor(mainLimit / 4)), handoffBudget: Math.floor(mainLimit * 0.75),
        loadAttachments: turnId => this.archive!.loadPromptAttachments(sessionId, turnId),
        onProgress: ({ batch }) => {
          if (entry.compressing === controller && !signal.aborted && entry.streamGen === gen) {
            this.publishCompression(entry, { state: "running", updatedAt: Date.now(), batch }, false);
          }
        },
      });
      signal.throwIfAborted();
      // The SDK journal retains content blocks and tool pairs that compact UI cards omit.
      // Hidden seat transcripts can contain private views intentionally omitted from ChatItems.
      const sourceSdkSessionId = entry.sdkSessionId;
      const sdkMessages = this.readSdkMessages && sourceSdkSessionId && !entry.summary.hiddenFromList && result.compressedCount
        ? await this.readSdkMessages(sourceSdkSessionId, entry.summary.cwd) : undefined;
      signal.throwIfAborted();
      if (sdkMessages && !sdkMessages.length) {
        return fail("The SDK transcript is unavailable for this conversation");
      }
      this.throwIfRoomTurnCancelled(entry, roomTurn);
      if (gen !== entry.streamGen || sourceSdkSessionId !== entry.sdkSessionId || originalItems !== entry.items || this.sessions.get(sessionId) !== entry ||
          model !== (entry.model || this.settings.get().defaultModel) || summaryModel !== this.summaryModel(entry)) {
        return fail("Session changed during compression");
      }
      if (!result.compressedCount || !result.summaryText.trim()) return fail("Nothing to compress");

      const index: CompactIndex = {
        revision: randomUUID(), createdAt: Date.now(), model, compressedCount: result.compressedCount,
        ...(sdkMessages ? { sdkMessageCount: sdkMessages.length } : {}),
      };
      const snapshot: CompactSnapshot = { ...index, summaryText: result.summaryText, original: current, sourceSdkSessionId: entry.sdkSessionId };
      // Verify every retained attachment before switching lineages. Historic
      // sessions without the sent bytes can still resume their original SDK.
      const handoff = this.handoffContent(sessionId, {
        summaryText: snapshot.summaryText, recentTurns: current.slice(result.compressedCount),
      }, opts?.autoContinue);
      if (contentContextBudget(handoff) > mainLimit * 0.75) {
        return fail("Retained turns and attachments exceed the handoff budget");
      }
      const progressBaseline = entry.summary.hiddenFromList ? entry.progressBaseline : restoreSessionProgress(
        rebuildSessionProgress(current.slice(0, result.compressedCount), entry.progressBaseline),
      ) ?? { tasks: [], agents: [] };
      const compactions = [...(entry.compactions ?? []), index];
      const summary: SessionSummary = { ...entry.summary, contextUsage: undefined, updatedAt: index.createdAt,
        contextCompression: { state: "completed", updatedAt: index.createdAt } };
      const compacted = [...visible.slice(0, start), ...result.items.map(item => item.kind === "text" && item.role === "user"
        ? { ...item, sdkMsgId: undefined, historicalTurn: true as const } : item)];
      this.archive.commitCompaction({
        ...this.storedSummary(entry), ...summary, compactions, pendingHandoff: index.revision,
        sdkSessionId: undefined, progressBaseline,
      }, snapshot, compacted, sdkMessages);

      this.pendingTranscriptSaves.delete(sessionId);
      entry.compactions = compactions;
      entry.pendingHandoff = index.revision;
      entry.lastCompressedAt = index.createdAt;
      entry.summary = summary;
      committed = true;
      entry.progressBaseline = progressBaseline;
      entry.sdkSessionId = undefined;
      entry.sdkUserMsgIds = [];
      entry.resumeAtAnchor = undefined;
      this.replaceTranscript(entry, compacted, { persist: false });
      this.parkSession(entry);
      this.emit({ type: "items_replaced", sessionId, items: entry.items });
      if (!entry.summary.hiddenFromList) this.emitSession({ ...summary });
      if (opts?.autoContinue) {
        entry.syntheticHandoffUser = true;
        entry.summary = { ...summary, status: "running" };
        this.emitSession({ ...entry.summary });
        void this.openStreamingSession(sessionId, handoff, { resume: false }).catch(() => {
          // The stream reports its own error; a failed launch keeps the handoff available.
        });
      }
      return { ok: true, message: `Compressed ${result.compressedCount} items` };
    } catch (error) {
      return fail(`Compression failed: ${errMessage(error)}`);
    } finally {
      if (entry.compressing === controller) {
        entry.compressing = undefined;
        if (!committed) this.publishCompression(entry, signal.aborted || gen !== entry.streamGen
          ? undefined : { state: "failed", updatedAt: Date.now(), message: failure });
      }
    }
  }

  private invalidateCompression(entry: SessionEntry): void {
    entry.promptRevision = (entry.promptRevision ?? 0) + 1;
    clearTimeout(entry.autoCompactTimer);
    entry.autoCompactTimer = undefined;
    entry.compressing?.abort();
  }

  private publishCompression(entry: SessionEntry, status: SessionSummary["contextCompression"], persist = true): void {
    entry.summary = { ...entry.summary, contextCompression: status };
    if (!entry.summary.hiddenFromList) this.emitSession({ ...entry.summary });
    if (persist) {
      try { this.persistSummary(entry); }
      catch (error) {
        entry.summary = { ...entry.summary, contextCompression: { state: "failed", updatedAt: Date.now(),
          message: `${status?.message ?? "Compression status could not be saved"}: ${errMessage(error)}` } };
        if (!entry.summary.hiddenFromList) this.emitSession({ ...entry.summary });
      }
    }
  }

  private shouldAutoCompress(entry: SessionEntry): boolean {
    const occupancy = entry.summary.contextUsage;
    const settings = this.settings.get();
    return Boolean(occupancy && (occupancy.selectedModelId ?? occupancy.modelId) === (entry.model || settings.defaultModel) &&
      occupancy.ratio >= (settings.tokenSavings?.autoCompactRatio ?? 0.75) && !entry.summary.hiddenFromList &&
      !entry.externalSummaryRoute && !entry.skipCpa && !entry.extraEnv?.ANTHROPIC_BASE_URL &&
      !entry.turnActive && entry.summary.status !== "running" && !entry.pendingHandoff && !entry.compressing &&
      !entry.rewindPending && !entry.resumeAtAnchor && entry.nativeCompactQueryGen !== entry.streamGen &&
      (!entry.lastCompressedAt || Date.now() - entry.lastCompressedAt >= 5 * 60 * 1000));
  }

  private async autoCompress(entry: SessionEntry): Promise<void> {
    if (!this.shouldAutoCompress(entry)) return;
    const revision = entry.promptRevision;
    try {
      const result = await this.compressSession(entry.summary.id);
      if (!result.ok && !result.cancelled && entry.promptRevision === revision && !entry.turnActive &&
          entry.summary.contextCompression?.state !== "failed") {
        this.publishCompression(entry, { state: "failed", updatedAt: Date.now(), message: result.message });
      }
    } catch (error) {
      if (entry.promptRevision === revision && !entry.turnActive) {
        this.publishCompression(entry, { state: "failed", updatedAt: Date.now(), message: errMessage(error) });
      }
    }
  }

  private scheduleAutoCompression(entry: SessionEntry): void {
    if (!this.compressor || !this.archive || !this.shouldAutoCompress(entry)) return;
    clearTimeout(entry.autoCompactTimer);
    const revision = entry.promptRevision;
    const generation = entry.streamGen;
    entry.autoCompactTimer = setTimeout(() => {
      entry.autoCompactTimer = undefined;
      if (this.sessions.get(entry.summary.id) === entry && entry.promptRevision === revision && entry.streamGen === generation) {
        void this.autoCompress(entry);
      }
    }, 0);
    entry.autoCompactTimer.unref?.();
  }

  private resetSdkConversation(entry: SessionEntry, newId: string): void {
    this.invalidateCompression(entry);
    this.hydrateItems(entry);
    entry.queryExtras?.toolOutput?.revoke();
    // A warm SDK stream has closures bound to the old reader. Reopen on next input.
    entry.queryModel = undefined;
    entry.sdkSessionId = newId;
    entry.sdkCostBaseline = { lineage: newId, total: 0 };
    entry.sdkUserMsgIds = [];
    entry.resumeAtAnchor = undefined;
    entry.syntheticHandoffUser = false;
    entry.pendingHandoff = undefined;
    entry.lastCompressedAt = undefined;
    entry.nativeCompactQueryGen = undefined;
    entry.progressBaseline = undefined;
    entry.summary = { ...entry.summary, contextUsage: undefined, contextCompression: undefined, progress: { tasks: [], agents: [] }, taskPlan: undefined };
    entry.resetBoundaryId = "sdk-reset-" + newId;
    const items: ChatItem[] = entry.items.map(item =>
      item.kind === "text" && item.role === "user" ? { ...item, sdkMsgId: undefined, historicalTurn: true } : item);
    items.push({ kind: "text", id: entry.resetBoundaryId, role: "system", text: "已开始新的 SDK 对话，此前的记录仅供回看。" });
    this.pendingTranscriptSaves.delete(entry.summary.id);
    this.replaceTranscript(entry, items, { persist: false });
    this.archive?.commitTranscriptRevision(this.storedSummary(entry), items, randomUUID());
    this.toolOutputStore.remove(entry.summary.id);
    this.emit({ type: "items_replaced", sessionId: entry.summary.id, items });
    this.emitSession({ ...entry.summary });
  }

  cancelPendingCompressions(): void {
    for (const entry of this.sessions.values()) {
      entry.compressing?.abort();
    }
  }

  private summaryModel(entry: SessionEntry): string {
    const settings = this.settings.get();
    const model = entry.model || settings.defaultModel;
    if (entry.summary.hiddenFromList || entry.roomAbortTurn) return model;
    return settings.tokenSavings?.summaryModel?.trim() || model;
  }

  private handoffContent(sessionId: string, handoff: CompactHandoff, autoContinue = false, attempts: ChatItem[] = []): UserContentBlock[] {
    const recent = [...handoff.recentTurns, ...attempts];
    const outputHandles = this.toolOutputStore.retained(sessionId, recent);
    const blocks: UserContentBlock[] = [{ type: "text", text: buildContinuationPrompt(handoff.summaryText, { recent, autoContinue, outputHandles }) }];
    for (const item of recent) {
      if (item.kind === "text" && item.role === "user" && item.attachments?.length) {
        blocks.push({ type: "text", text: `Historical attachments for turn ${item.id}: ${item.attachments.map(a => a.name).join(", ")}` },
          ...this.archive!.loadPromptAttachments(sessionId, item.id));
      }
    }
    return blocks;
  }

  async start(
    prompt: UserPrompt,
    cwd: string,
    opts?: SessionRunOpts,
  ): Promise<string> {
    opts?.roomAbortSignal?.throwIfAborted();
    if (!opts?.skipCpa) await this.ensureCpaOrThrow();
    opts?.roomAbortSignal?.throwIfAborted();

    const { content, errors } = buildUserContent(prompt);
    if (errors.length) {
      throw new Error(errors.join("; "));
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
      lastQueryUsedAt: now,
      streamGen: 0,
      items: [],
      itemsHydrated: true,
      lastTranscriptAccessAt: now,
      changesHydrated: false,
      lastChangesAccessAt: 0,
      nextId: createIdFactory(),
      extraMcpServers: opts?.extraMcpServers,
      extraAllowedTools: opts?.extraAllowedTools,
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(opts?.pathJail ? { pathJail: opts.pathJail } : {}),
      roomReadOnlyTurn: opts?.roomReadOnly
        ? { requestWriteAccess: opts.requestRoomWriteAccess, writeApproved: false }
        : undefined,
      ...(opts?.extraEnv ? { extraEnv: opts.extraEnv } : {}),
      ...(opts?.skipCpa ? { skipCpa: true } : {}),
    };
    this.sessions.set(sessionId, entry);
    this.setRoomAbortSignal(entry, opts?.roomAbortSignal);
    opts?.onSessionId?.(sessionId);
    this.throwIfRoomTurnCancelled(entry);
    this.persistSummary(entry);
    const first = this.recordUserPrompt(entry, prompt, content, opts?.persistText);
    if (!summary.hiddenFromList) this.emitSession({ ...summary });
    this.emit(first);

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
    opts?.roomAbortSignal?.throwIfAborted();
    const wasCompressing = Boolean(entry.compressing);
    this.invalidateCompression(entry);
    const promptRevision = entry.promptRevision;
    if (entry.turnActive && entry.queryEffort !== this.resolveEffort(entry)) {
      await this.waitForTurnIdle(sessionId, opts?.roomAbortSignal);
      opts?.roomAbortSignal?.throwIfAborted();
    }
    const roomTurn = this.setRoomAbortSignal(entry, opts?.roomAbortSignal);
    this.clearIdleCloseTimer(entry);
    entry.lastQueryUsedAt = Date.now();
    let reopenForExtras = false;
    if (opts?.model && opts.model !== entry.model) {
      entry.model = opts.model;
      reopenForExtras = true;
    }
    if (opts?.replaceExtras) {
      entry.extraMcpServers = opts.extraMcpServers ?? {};
      entry.extraAllowedTools = opts.extraAllowedTools ?? [];
    } else {
      if (opts?.extraMcpServers) {
        entry.extraMcpServers = {
          ...(entry.extraMcpServers ?? {}),
          ...opts.extraMcpServers,
        };
      }
      if (opts?.extraAllowedTools?.length) {
        const have = new Set(entry.extraAllowedTools ?? []);
        for (const t of opts.extraAllowedTools) {
          have.add(t);
        }
        entry.extraAllowedTools = [...have];
      }
    }
    if (opts?.hiddenFromList) entry.summary.hiddenFromList = true;
    if (opts?.title) entry.summary.title = opts.title;
    if (opts?.permissionMode) entry.permissionMode = opts.permissionMode;
    if (opts?.pathJail) entry.pathJail = opts.pathJail;
    if (opts?.extraEnv) entry.extraEnv = opts.extraEnv;
    if (opts?.skipCpa) entry.skipCpa = true;

    try {
      if (!entry.skipCpa && !opts?.skipCpa) await this.ensureCpaOrThrow(sessionId);
    } catch (err) {
      roomTurn?.detach?.();
      throw err;
    }
    this.throwIfRoomTurnCancelled(entry, roomTurn);

    // Never retain a prior room approval/callback in a reused query. Omitting
    // roomReadOnly returns this turn to ordinary session behavior.
    entry.roomReadOnlyTurn = opts?.roomReadOnly
      ? { requestWriteAccess: opts.requestRoomWriteAccess, writeApproved: false }
      : undefined;
    if (entry.queryExtras?.toolOutput && entry.queryExtras.personalOutputs !== isPersonalOutputSession(entry)) {
      entry.queryExtras.toolOutput.revoke();
      reopenForExtras = true;
    }

    const { content, errors } = buildUserContent(prompt);
    if (errors.length) {
      this.emit({ type: "result", sessionId, ok: false, error: errors.join("; ") });
      throw new Error(errors.join("; "));
    }

    this.hydrateItems(entry);
    if (!wasCompressing && this.shouldAutoCompress(entry)) {
      // The user already requested this turn. A failed optional compaction falls
      // back to the existing SDK lineage. A superseded prompt must never launch.
      await this.autoCompress(entry);
      if (entry.promptRevision !== promptRevision) throw new DOMException("Prompt superseded", "AbortError");
      this.throwIfRoomTurnCancelled(entry, roomTurn);
    }
    // Settings can change while CPA or the optional summary request is pending.
    // Compare the live query's binding only after both asynchronous steps.
    const launchSettings = this.settings.get();
    reopenForExtras ||= entry.queryExtras?.tokenSavingsMode !== (launchSettings.tokenSavings?.mode ?? "balanced");
    reopenForExtras ||= entry.queryModel !== (entry.model || launchSettings.defaultModel) ||
      entry.queryEffort !== this.resolveEffort(entry, launchSettings) || entry.queryExtras?.pathJail !== entry.pathJail ||
      extrasChanged(entry.queryExtras?.servers, entry.queryExtras?.allowedTools, entry.extraMcpServers ?? {}, entry.extraAllowedTools ?? []);
    let handoff: UserContentBlock[] | undefined;
    if (entry.pendingHandoff) {
      const seed = this.archive?.loadHandoff(sessionId, entry.pendingHandoff);
      if (!seed) throw new Error("Compact handoff is missing");
      const active = entry.items.slice(this.activeTranscriptStart(entry));
      const attemptStart = active.findIndex(item => item.kind === "text" && item.role === "user" && !item.historicalTurn);
      handoff = this.handoffContent(sessionId, seed, false, attemptStart < 0 ? [] : active.slice(attemptStart));
      handoff.push({ type: "text", text: "Current user message:" },
        ...(typeof content === "string" ? [{ type: "text" as const, text: content }] : content));
    }
    const submitted = this.recordUserPrompt(entry, prompt, content, opts?.persistText);

    entry.summary = {
      ...entry.summary,
      status: "running",
      updatedAt: Date.now(),
    };
    entry.turnActive = true;
    if (!entry.summary.hiddenFromList) this.emitSession({ ...entry.summary });
    this.persistSummary(entry);

    // Live streaming session: just push the next user message.
    this.emit(submitted);
    if (handoff) {
      entry.syntheticHandoffUser = false;
      entry.sdkSessionId = undefined;
      await this.openStreamingSession(sessionId, handoff, { resume: false });
      return;
    }
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
      this.throwIfRoomTurnCancelled(entry, roomTurn);
      try {
        entry.input.push(content, entry.sdkSessionId);
      } catch {
        // Stream closed between the check and push (e.g. concurrent abort) —
        // fall through to open a fresh resumed query.
        entry.input = undefined;
        entry.query = undefined;
        entry.queryExtras = undefined;
        entry.queryEffort = undefined;
        entry.consumer = undefined;
        await this.openStreamingSession(sessionId, content, { resume: true });
        return;
      }
      // Wait until this turn's result (or error) so IPC still "awaits the turn".
      await this.waitForTurnIdle(sessionId);
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
            : `Provider 服务尚未就绪 (state=${status.state})`;

    const sid = sessionId ?? "unknown";
    this.emit({
      type: "result",
      sessionId: sid,
      ok: false,
          error: `Provider: ${message}`,
    });
      throw new Error(`Provider: ${message}`);
  }

  private resolveClaudePath() {
    return this.claudeExecutablePath ?? getClaudeExecutablePath({
      isPackaged: this.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataDir: "",
    });
  }

  private resolveEffort(entry: SessionEntry, settings = this.settings.get()): ReasoningEffort | undefined {
    const model = entry.model || settings.defaultModel;
    return settings.modelEfforts?.[model] ?? this.cpa.getModelCatalog().find(item => item.id === model)?.defaultReasoningEffort ?? settings.effort;
  }

  private buildOptions(
    sessionId: string,
    entry: SessionEntry,
    abortController: AbortController,
    queryExtras: QueryExtras,
  ): Record<string, unknown> {
    const queryGen = entry.streamGen;
    const settings = this.settings.get();
    entry.desktopToolPrefixes = desktopToolPrefixes(settings.mcpServers ?? {});
    entry.usedDesktopControl = false;
    const env = {
      ...this.cpa.buildProcessEnv(entry.model || settings.defaultModel),
      ...(entry.extraEnv ?? {}),
    };
    const cwd = queryExtras.pathJail ?? entry.summary.cwd;
    queryExtras.tokenSavingsMode = settings.tokenSavings?.mode ?? "balanced";
    const balanced = queryExtras.tokenSavingsMode === "balanced";
    // SDK shell overflow is stored outside cwd. A jailed Read cannot recover a
    // newly shortened result there, so let the SDK keep the room's existing limit.
    const bashOutputMaxChars = balanced && !queryExtras.pathJail ? shellOutputBudget(cwd, env) : undefined;
    const servers: Record<string, unknown> = {
      ...resolveMcpServers(settings.mcpServers ?? {}, this.isPackaged, !entry.pathJail && !entry.roomReadOnlyTurn, entry.summary.title, this.browserAuthStorePath),
      ...queryExtras.servers,
    };
    queryExtras.personalOutputs = isPersonalOutputSession(entry);
    const sources = balanced ? browserOutputSources(settings.mcpServers ?? {}, queryExtras.servers) : new Set<string>();
    // A room task does not expose a durable room/seat authorization identity to
    // this layer. Keep its output exact. Parked personal queries can reauthorize
    // the same session's unexpired handles, including after restarting the app.
    if (queryExtras.personalOutputs && !(RESULT_SERVER in servers)) {
      try {
        const retained = this.toolOutputStore.retained(sessionId, entry.items.slice(this.activeTranscriptStart(entry)));
        if (sources.size || retained.size) {
          queryExtras.toolOutput = createToolOutputBinding({
            store: this.toolOutputStore, sessionId, sources, retained, isActive: () =>
              this.sessions.get(sessionId) === entry && isPersonalOutputSession(entry) && entry.turnActive &&
              entry.streamGen === queryGen && entry.abortController === abortController && !abortController.signal.aborted,
          });
          servers[RESULT_SERVER] = queryExtras.toolOutput.server;
        }
      } catch { /* Without a usable reader, pass the original tool result through. */ }
    }
    const binding = queryExtras.toolOutput;
    const cacheHeader = !entry.skipCpa && this.cpa.cacheSessionHeader?.(sessionId, env);
    if (cacheHeader) env.ANTHROPIC_CUSTOM_HEADERS = [env.ANTHROPIC_CUSTOM_HEADERS, cacheHeader].filter(Boolean).join("\n");
    // Prefer the bundled / vendor Claude Code binary so the app does not
    // require a global `claude` on PATH (packaged installs ship claude.exe).
    const claudePath = this.resolveClaudePath();

    return {
      // The official sandbox derives its default writable workspace from cwd.
      cwd,
      ...(bashOutputMaxChars ? { settings: { bashOutputMaxChars } } : {}),
      ...(queryExtras.pathJail ? { sandbox: roomSandboxSettings() } : {}),
      includePartialMessages: true,
      permissionMode: entry.permissionMode ?? settings.permissionMode,
      model: entry.model || settings.defaultModel,
      ...(() => {
        const effort = this.resolveEffort(entry, settings);
        return effort ? { effort } : {};
      })(),
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
        ...queryExtras.allowedTools,
      ],
      // Load CLAUDE.md hierarchy (user → project → local) into the system
      // prompt, matching Claude Code. Must include 'project' for project CLAUDE.md.
      settingSources: ["user", "project", "local"],
      // Configured MCP servers (stdio/sse/http). Passed through as-is; the
      // config shape matches the SDK. Kept out of `env` so the CPA token is
      // never leaked into MCP server subprocesses.
      // Per-session extras (in-process room_mod_act) merge on top.
      ...(Object.keys(servers).length ? { mcpServers: servers } : {}),
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
        ...(binding && sources.size ? { PostToolUse: [{ hooks: [binding.post] }] } : {}),
        PreCompact: [{ hooks: [async () => {
          if (!abortController.signal.aborted && entry.streamGen === queryGen) entry.nativeCompactQueryGen = queryGen;
          return {};
        }] }],
        PostCompact: [{ hooks: [async () => {
          if (!abortController.signal.aborted && entry.streamGen === queryGen) {
            entry.nativeCompactQueryGen = undefined;
            entry.lastCompressedAt = Date.now();
          }
          return {};
        }] }],
        PostToolUseFailure: [{ hooks: [fileEditRecovery] }],
        // 路径围栏必须挂在 PreToolUse：canUseTool 只管需要授权的工具，
        // Read/Glob/Grep 等只读工具在多数权限模式下根本不进 canUseTool，
        // 而 PreToolUse 对每一次工具调用都会触发（含只读、含 bypass 模式）。
        PreToolUse: [
          {
            hooks: [
              async (
                input: { tool_name?: string; tool_input?: unknown; agent_id?: string; mcp_server?: { name: string; source: string } },
                _toolUseId?: string,
                hookOptions?: { signal?: AbortSignal },
              ) => {
                const name = String(input.tool_name ?? "");
                if (entry.streamGen === queryGen && entry.desktopToolPrefixes?.some(prefix => name.startsWith(prefix))) {
                  entry.usedDesktopControl = true;
                }
                const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
                const deny = (reason: string) => ({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: reason,
                  },
                });
                const abortTurn = entry.roomAbortTurn;
                if (abortTurn && (
                  this.roomTurnCancelled(entry, abortTurn) || !entry.turnActive ||
                  entry.streamGen !== queryGen || abortController.signal.aborted ||
                  hookOptions?.signal?.aborted
                )) {
                  return deny("已拒绝：群聊轮次已取消或结束");
                }
                if (name === RESULT_TOOL && binding?.active() && input.mcp_server?.name === RESULT_SERVER &&
                    ["sdk", "dynamic"].includes(input.mcp_server.source)) {
                  if (input.agent_id || hookOptions?.signal?.aborted) return deny("此归档仅限当前主会话读取");
                  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
                }
                // Preserve the jail's immediate-deny behavior: an out-of-root
                // write cannot even request a room permission upgrade.
                if (entry.pathJail) {
                  const violation = pathJailViolation(entry.pathJail, name, toolInput);
                  if (violation) return deny(violation);
                }
                // Read the current turn at invocation time, not when building
                // options: one query can serve both room and ordinary turns.
                const roomTurn = entry.roomReadOnlyTurn;
                if (roomTurn) {
                  const isCurrentTurn = () =>
                    !this.roomTurnCancelled(entry, abortTurn) &&
                    entry.roomReadOnlyTurn === roomTurn &&
                    entry.turnActive &&
                    entry.streamGen === queryGen &&
                    !abortController.signal.aborted &&
                    !hookOptions?.signal?.aborted;
                  const cancelled = "已拒绝：群聊轮次已取消或结束";
                  if (!isCurrentTurn()) return deny(cancelled);

                  const roomChat = queryExtras.servers["room-chat"];
                  // Only our task-bound in-process room-chat tools are exempt.
                  // Use this query's binding even while continue stages new extras.
                  // RoomService controls their messaging/member permissions.
                  const isRoomChatTool =
                    (name === "mcp__room-chat__room_members" ||
                      name === "mcp__room-chat__room_message") &&
                    isSdkMcpServer(roomChat) &&
                    queryExtras.allowedTools.includes(name);
                  const isReadOnlyTool =
                    name === "Read" || name === "Glob" || name === "Grep";
                  if (!roomTurn.writeApproved && !isReadOnlyTool && !isRoomChatTool) {
                    const readOnlyReason = `已拒绝：群聊只读轮次尚未获准执行 ${name || "未知工具"}`;
                    if (!roomTurn.requestWriteAccess) return deny(readOnlyReason);
                    let approved = false;
                    try {
                      approved = (await roomTurn.requestWriteAccess(name, toolInput)) === true;
                    } catch {
                      // Missing, rejected, or failed approval must all fail closed.
                    }
                    // The callback may settle after abort, a new turn, or query
                    // replacement. It must never unlock that newer turn.
                    if (!isCurrentTurn()) return deny(cancelled);
                    if (!approved) return deny(readOnlyReason);
                    roomTurn.writeApproved = true;
                  }
                }

                // Recheck after awaiting approval in case the jail/input changed.
                if (!entry.pathJail) return {};
                const violation = pathJailViolation(
                  entry.pathJail,
                  name,
                  toolInput,
                );
                // Returning {} preserves the SDK/PermissionBroker decision;
                // a room write grant is never an unconditional tool allow.
                return violation ? deny(violation) : {};
              },
            ],
          },
        ],
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
        const roomTurn = entry.roomAbortTurn;
        const roomCancelled = () => roomTurn && (
          this.roomTurnCancelled(entry, roomTurn) || !entry.turnActive ||
          entry.streamGen !== queryGen || abortController.signal.aborted ||
          _sdkOpts.signal.aborted
        );
        if (roomCancelled()) {
          return { behavior: "deny" as const, message: "Room turn cancelled" };
        }
        // 路径围栏（群聊席位/远程执行）：越界文件操作直接拒，不进弹窗。
        if (entry.pathJail) {
          const violation = pathJailViolation(entry.pathJail, name, input);
          if (violation) {
            return { behavior: "deny" as const, message: violation };
          }
        }
        const result = await this.permissionBroker.canUseTool(
          name,
          input,
          sessionId,
          AbortSignal.any([abortController.signal, _sdkOpts.signal]),
        );
        if (roomCancelled()) {
          return { behavior: "deny" as const, message: "Room turn cancelled" };
        }
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
    const roomTurn = entry.roomAbortTurn;
    this.throwIfRoomTurnCancelled(entry, roomTurn);
    this.listenForRoomAbort(entry);
    this.clearIdleCloseTimer(entry);
    entry.lastQueryUsedAt = Date.now();

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

    const queryExtras = snapshotQueryExtras(entry);
    const options = this.buildOptions(sessionId, entry, abortController, queryExtras);
    const startingCost = opts.resume ? this.costAtTip(entry) : 0;
    if (opts.resume) {
      options.resume = entry.sdkSessionId ?? sessionId;
      // After a rewind: resume the SDK session truncated at the anchor
      // (the rewound user message becomes the conversation tip).
      if (entry.resumeAtAnchor) {
        options.resumeSessionAt = entry.resumeAtAnchor;
        entry.resumeAtAnchor = undefined;
      }
    }

    try {
      this.throwIfRoomTurnCancelled(entry, roomTurn);
      if (this.pdfCompatibility) {
        options.env = await this.pdfCompatibility.environment(options.env as Record<string, string>);
        this.throwIfRoomTurnCancelled(entry, roomTurn);
      }
      if (entry.streamGen !== myGen || abortController.signal.aborted) {
        throw new DOMException("Session superseded", "AbortError");
      }
      const q = this.queryFn({
        prompt: input as AsyncIterable<unknown>,
        options,
      });
      entry.query = q as QueryHandle & QueryControl;
      entry.queryModel = String(options.model);
      entry.queryExtras = queryExtras;
      entry.queryEffort = options.effort as ReasoningEffort | undefined;
      this.enforceLiveQueryCap(sessionId);

      // Kick off consumer before first push so we don't miss early messages.
      entry.consumer = this.consumeQuery(sessionId, q, entry.queryModel, startingCost);

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
      if (entry.streamGen !== myGen || this.roomTurnCancelled(entry, roomTurn)) {
        input.end();
        throw err;
      }
      const raw = err instanceof Error ? err.message : String(err);
      const message = humanizeAgentError(raw, String(options.model));
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

  private costAtTip(entry: SessionEntry): number | undefined {
    if (entry.pendingHandoff) return 0;
    if (entry.resumeAtAnchor) {
      const anchor = entry.items.find(item => item.kind === "text" && item.sdkMsgId === entry.resumeAtAnchor);
      return anchor?.kind === "text" ? anchor.sdkCostAtSubmission : undefined;
    }
    if (entry.sdkCostBaseline?.lineage === (entry.sdkSessionId ?? entry.summary.id)) return entry.sdkCostBaseline.total;
    return entry.sdkSessionId || entry.summary.usage ? undefined : 0;
  }

  private recordUserPrompt(entry: SessionEntry, prompt: UserPrompt, content: string | UserContentBlock[], persistText?: string): SdkNormalizedEvent {
    if (entry.summary.contextCompression?.state === "completed") entry.summary = { ...entry.summary, contextCompression: undefined };
    const text = persistText ?? displayPrompt(prompt);
    const next = appendUserItem(this.transcriptOf(entry), text, {
      nextId: entry.nextId, attachments: prompt.attachments, sdkCostAtSubmission: this.costAtTip(entry),
    });
    const submittedItem = next.items[next.items.length - 1];
    if (submittedItem.kind !== "text" || submittedItem.role !== "user") throw new Error("Missing submitted user message");
    if (prompt.attachments.length && Array.isArray(content) && persistText === undefined) {
      try {
        this.archive?.savePromptAttachments(entry.summary.id, submittedItem.id, content.slice(-prompt.attachments.length));
      } catch {
        // The live query already owns the supplied bytes. Compaction will decline
        // if this attachment is still needed and no durable copy was available.
      }
    }
    this.replaceTranscript(entry, next.items, { persist: true });
    return { type: "user_message", sessionId: entry.summary.id, text, submittedItem };
  }

  private dispatchNormalizedEvent(
    entry: SessionEntry,
    event: SdkNormalizedEvent,
    model: string,
    context?: SdkTurnContext,
  ): void {
    if (event.type === "result" && !event.ok && event.error) {
      event = { ...event, error: humanizeAgentError(event.error, model) };
    }
    const transcriptIds: string[] = [];
    this.applyAndMaybePersist(entry, event, prefix => {
      const id = entry.nextId(prefix);
      transcriptIds.push(id);
      return id;
    });
    this.emit(transcriptIds.length ? { ...event, transcriptIds } : event);
    if (event.type !== "result") return;
    entry.nativeCompactQueryGen = undefined;

    const settings = this.settings.get();
    const catalog = this.cpa.getModelCatalog();
    const usage = accumulateUsage(entry.summary.usage, event.usage);
    const reportedModel = context?.sdk?.model ?? context?.model;
    const modelId = !reportedModel || model.endsWith("/" + reportedModel) ? model : reportedModel;
    const contextUsage = computeContextUsage({
      request: context?.request,
      sdk: context?.sdk,
      modelId,
      selectedModelId: model,
      settings,
      catalog,
    });

    entry.summary = {
      ...entry.summary,
      status: event.ok ? "idle" : "error",
      updatedAt: Date.now(),
      usage,
      contextUsage,
    };
    entry.turnActive = false;
    entry.roomAbortTurn?.detach?.();
    this.emitSession({ ...entry.summary });
    this.persistSummary(entry);
    this.scheduleIdleClose(entry);
    if (event.ok && event.outcome !== "interrupted" && event.outcome !== "cancelled") this.scheduleAutoCompression(entry);
  }

  private async consumeQuery(
    sessionId: string,
    stream: QueryHandle,
    model: string,
    startingCost: number | undefined,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // Capture generation so a later abort/reopen can make us stop mutating state.
    const myGen = entry.streamGen;
    let context = new SdkTurnContext();
    let canReadSummary = typeof entry.query?.getContextUsage === "function";
    // Imported histories and truncated transcripts may lack a comparable baseline.
    let lastCost = startingCost;
    let costLineage: string | undefined;
    const retiredLineages = new Set<string>();
    let resetCommandUuid: unknown;
    let pendingText = "";
    let textTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingToolProgress = new Map<string, SdkNormalizedEvent>();
    let toolProgressTimer: ReturnType<typeof setTimeout> | undefined;

    const canDispatch = () =>
      entry.streamGen === myGen && !entry.abortController?.signal.aborted;
    const flushText = () => {
      if (textTimer) clearTimeout(textTimer);
      textTimer = undefined;
      const text = pendingText;
      pendingText = "";
      if (!text || !canDispatch()) return;
      this.dispatchNormalizedEvent(
        entry,
        { type: "text_delta", sessionId, text },
        model,
      );
    };
    const flushToolProgress = () => {
      if (toolProgressTimer) clearTimeout(toolProgressTimer);
      toolProgressTimer = undefined;
      if (!canDispatch()) {
        pendingToolProgress.clear();
        return;
      }
      const events = [...pendingToolProgress.values()];
      pendingToolProgress.clear();
      for (const event of events) {
        this.dispatchNormalizedEvent(entry, event, model);
      }
    };
    const queueEvent = (event: SdkNormalizedEvent) => {
      if (event.type === "text_delta") {
        pendingText += event.text;
        if (!textTimer) {
          textTimer = setTimeout(flushText, STREAM_FLUSH_MS);
          textTimer.unref?.();
        }
        return;
      }
      if (event.type === "tool_progress") {
        pendingToolProgress.set(event.toolUseId, event);
        if (!toolProgressTimer) {
          toolProgressTimer = setTimeout(
            flushToolProgress,
            TOOL_PROGRESS_FLUSH_MS,
          );
          toolProgressTimer.unref?.();
        }
        return;
      }
      // Preserve stream ordering around settled text and tool completion.
      flushText();
      if (event.type === "tool_end" || event.type === "result") {
        flushToolProgress();
      }
      this.dispatchNormalizedEvent(entry, event, model, context);
    };

    try {
      for await (const msg of stream) {
        if (entry.streamGen !== myGen) break;
        if (entry.abortController?.signal.aborted) break;

        const sdkId = extractSdkSessionId(msg);
        if (typeof msg === "object" && msg !== null && "type" in msg && msg.type === "conversation_reset" &&
            "new_conversation_id" in msg && typeof msg.new_conversation_id === "string" && msg.new_conversation_id) {
          if (entry.resetBoundaryId === "sdk-reset-" + msg.new_conversation_id) continue;
          flushText();
          flushToolProgress();
          if (entry.sdkSessionId && entry.sdkSessionId !== msg.new_conversation_id) retiredLineages.add(entry.sdkSessionId);
          if (sdkId && sdkId !== msg.new_conversation_id) retiredLineages.add(sdkId);
          resetCommandUuid = "user_message_uuid" in msg ? msg.user_message_uuid : undefined;
          this.resetSdkConversation(entry, msg.new_conversation_id);
          costLineage = msg.new_conversation_id;
          lastCost = 0;
          context = new SdkTurnContext();
          continue;
        }
        // Some CLIs echo /clear or its terminal result with the discarded ID.
        const retired = Boolean(sdkId && retiredLineages.has(sdkId));
        if (retired && !isResultMessage(msg)) continue;
        if (resetCommandUuid && typeof msg === "object" && msg && "uuid" in msg && msg.uuid === resetCommandUuid) continue;
        if (sdkId && !retired) entry.sdkSessionId = sdkId;
        context.observe(msg);
        if (entry.pendingHandoff && entry.sdkSessionId && typeof msg === "object" && msg !== null && isResultMessage(msg) &&
            "subtype" in msg && msg.subtype === "success" && !("is_error" in msg && msg.is_error)) {
          // The fresh SDK accepted the seed. Persist its new lineage and consume
          // the handoff together. Init and failed launches leave it retryable.
          entry.pendingHandoff = undefined;
          this.persistSummary(entry);
        }

        // Track SDK-persisted user message uuids (real user turns only) for
        // message-level rewind. Apply + emit so main-process items stay bound.
        if (isSdkPersistedUserTurn(msg)) {
          if (entry.syntheticHandoffUser) { entry.syntheticHandoffUser = false; continue; }
          const uuid = (msg as { uuid?: unknown }).uuid;
          if (typeof uuid === "string" && uuid && !entry.sdkUserMsgIds?.includes(uuid)) {
            entry.sdkUserMsgIds = [...(entry.sdkUserMsgIds ?? []), uuid];
            const idsEvent: SdkNormalizedEvent = {
              type: "user_msg_ids",
              sessionId,
              uuids: [...entry.sdkUserMsgIds],
            };
            queueEvent(idsEvent);
          }
        }

        this.handleToolUseForDiff(sessionId, msg);

        const events = normalizeSdkEvent(msg, sessionId, (id) => this.resolveTool(entry, id));
        for (let event of events) {
          if (event.type === "tool_end") {
            const handle = entry.queryExtras?.toolOutput?.takeOutputHandle(event.tool.id);
            if (handle && event.tool.status === "done") event = { ...event, tool: { ...event.tool, outputHandle: handle } };
          }
          // File mutation snapshots are captured at tool_use time for rewind,
          // but workspace/Git scanning and renderer updates happen once here,
          // at the turn boundary.
          if (event.type === "result") {
            await this.finalizeTurnDiff(sessionId, myGen);
            if (!retired && !context.sdk && canReadSummary && event.ok && canDispatch()) {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                const summary = await Promise.race([
                  entry.query!.getContextUsage!({ detail: "summary" }),
                  new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500); }),
                ]);
                context.sdk = sdkContextEstimate(summary);
                if (!context.sdk) canReadSummary = false;
              } catch { canReadSummary = false; }
              finally { clearTimeout(timer); }
            }
            if (!canDispatch()) break;
            const snapshot = retired ? undefined : sdkCostSnapshot(msg);
            if (snapshot !== undefined && (event.ok || snapshot > 0)) {
              const lineage = entry.sdkSessionId ?? sessionId;
              if (costLineage !== undefined && lineage !== costLineage) lastCost = 0;
              const delta = lastCost === undefined ? undefined : snapshot < lastCost ? snapshot : snapshot - lastCost;
              lastCost = snapshot;
              costLineage = lineage;
              entry.sdkCostBaseline = { lineage, total: snapshot };
              if (delta !== undefined) event = { ...event, costUsd: delta, usage: { ...event.usage, costUsd: delta } };
            }
          }
          queueEvent(event);
          if (event.type === "result") context = new SdkTurnContext();
        }

        // Also mark idle on bare result messages if normalize missed fields
        if (canDispatch() && isResultMessage(msg) && entry.turnActive) {
          entry.turnActive = false;
          entry.roomAbortTurn?.detach?.();
          if (entry.summary.status === "running") {
            entry.summary = {
              ...entry.summary,
              status: "idle",
              updatedAt: Date.now(),
            };
            this.emitSession({ ...entry.summary });
            this.persistSummary(entry);
            this.scheduleIdleClose(entry);
          }
        }
      }

      flushText();
      flushToolProgress();

      // Stream ended (input closed or process exit). Only touch state if we still
      // own this stream generation — abort() may already have opened a new one.
      if (entry.streamGen === myGen) {
        await this.finalizeTurnDiff(sessionId, myGen);
        if (entry.summary.status === "running") {
          entry.summary = {
            ...entry.summary,
            status: "idle",
            updatedAt: Date.now(),
          };
          this.emitSession({ ...entry.summary });
          this.persistSummary(entry);
          this.scheduleIdleClose(entry);
        }
        entry.turnActive = false;
      }
    } catch (err) {
      flushText();
      flushToolProgress();
      if (entry.streamGen !== myGen) return;
      if (entry.abortController?.signal.aborted) {
        await this.finalizeTurnDiff(sessionId, myGen);
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
      await this.finalizeTurnDiff(sessionId, myGen);
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
      this.scheduleIdleClose(entry);
    } finally {
      if (textTimer) clearTimeout(textTimer);
      if (toolProgressTimer) clearTimeout(toolProgressTimer);
      pendingText = "";
      pendingToolProgress.clear();
      // Only clear abortController if this consumer still owns the stream.
      if (entry.streamGen === myGen && entry.abortController) {
        entry.abortController = null;
      }
      if (entry.streamGen === myGen) {
        this.settleLiveAgents(entry, "unknown");
        entry.roomAbortTurn?.detach?.();
        if (entry.usedDesktopControl && !entry.turnActive) this.parkSession(entry);
      }
    }
  }

  private waitForTurnIdle(sessionId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const entry = this.sessions.get(sessionId);
    if (!entry) return Promise.resolve();
    if (!entry.turnActive) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const start = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
      const onAbort = () => { cleanup(); reject(signal?.reason); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      const tick = () => {
        const e = this.sessions.get(sessionId);
        if (!e || !e.turnActive) {
          cleanup();
          resolve();
          return;
        }
        // Safety: don't hang forever (30 min)
        if (Date.now() - start > 30 * 60 * 1000) {
          e.turnActive = false;
          cleanup();
          resolve();
          return;
        }
        timer = setTimeout(tick, 50);
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

  /** Merge effort levels reported by a live SDK initialization into the catalog. */
  async refreshModelCatalog(): Promise<void> {
    const live = [...this.sessions.values()]
      .filter((entry) => entry.query?.initializationResult)
      .sort((a, b) => b.lastQueryUsedAt - a.lastQueryUsedAt);
    for (const entry of live) {
      try {
        const initialized = await entry.query!.initializationResult!();
        if (Array.isArray(initialized.models)) {
          this.cpa.mergeSdkModelCapabilities(initialized.models);
          return;
        }
      } catch {
        // A cold or closing query can reject control calls; try another one.
      }
    }
  }

  /** Snapshot change-event ids/paths before this turn's writes start. */
  private snapshotTurnChangeBaseline(sessionId: string): void {
    this.hydrateChanges(sessionId);
    const changes = this.diffTracker.list(sessionId);
    this.turnChangeBaselines.set(sessionId, {
      eventIds: new Set(
        changes.flatMap((change) => change.events.map((event) => event.id)),
      ),
      paths: new Set(changes.map((change) => change.path)),
    });
  }

  private handleToolUseForDiff(sessionId: string, msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const rec = msg as Record<string, unknown>;
    const cwd = this.sessions.get(sessionId)?.summary.cwd;

    // Results no longer trigger live scans. A single refresh is performed when
    // this turn's result event arrives.
    if (rec.type === "user") {
      return;
    }

    if (rec.type !== "assistant") return;
    const message = rec.message as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message.content)) return;

    let changesReady = false;
    for (const block of message.content) {
      if (!isToolUseBlock(block)) continue;
      if (
        block.name !== "Edit" &&
        block.name !== "Write" &&
        block.name !== "Bash"
      ) {
        continue;
      }

      if (!changesReady) {
        this.hydrateChanges(sessionId);
        changesReady = true;
      }

      if (!this.turnChangeBaselines.has(sessionId)) {
        this.snapshotTurnChangeBaseline(sessionId);
      }

      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      this.diffTracker.onToolUse(sessionId, block.name, input, {
        cwd,
        toolUseId: typeof block.id === "string" ? block.id : undefined,
      });
      this.pendingTurnDiffs.add(sessionId);
    }
  }

  /** Scan the workspace and publish accumulated changes once per completed turn. */
  private async finalizeTurnDiff(
    sessionId: string,
    streamGen: number,
  ): Promise<void> {
    if (!this.pendingTurnDiffs.delete(sessionId)) return;
    const baseline = this.turnChangeBaselines.get(sessionId) ?? {
      eventIds: new Set<string>(),
      paths: new Set<string>(),
    };
    this.turnChangeBaselines.delete(sessionId);
    const cwd = this.sessions.get(sessionId)?.summary.cwd;
    this.hydrateChanges(sessionId);
    try {
      await this.diffTracker.refreshBashWritesFromDisk(sessionId, cwd);
    } catch {
      // Edit/Write snapshots are still useful even if the workspace scan fails.
    }
    const current = this.sessions.get(sessionId);
    if (!current || current.streamGen !== streamGen) return;
    const changes = this.diffTracker.list(sessionId);
    if (changes.length > 0) {
      this.emitDiffAndPersist(sessionId);
    }
    const files = summarizeTurnFiles(changes, baseline.eventIds, {
      baselinePaths: baseline.paths,
    });
    if (files.length > 0) {
      const entry = this.sessions.get(sessionId);
      if (!entry || entry.streamGen !== streamGen) return;
      const event: SdkNormalizedEvent = {
        type: "turn_changes",
        sessionId,
        item: {
          kind: "changes",
          id: entry.nextId("changes"),
          files,
        },
      };
      this.applyAndMaybePersist(entry, event);
      this.emit(event);
    }
  }
}

/**
 * Map common upstream/CPA errors to actionable UI copy.
 * DeepSeek (and some OpenAI-compat proxies) reject Anthropic image blocks.
 */
export function humanizeAgentError(raw: string, model: string): string {
  if (/sandbox (?:required but unavailable|enabled but .*not available)/i.test(raw)) {
    return "官方内置沙箱不可用，已停止执行，不会回退到无沙箱模式。" +
      (/windows/i.test(raw)
        ? "当前 Windows 会话未启用官方沙箱；请在支持官方沙箱的执行环境中重试。"
        : "请检查执行环境是否支持官方沙箱，并安装所需依赖后重试。");
  }
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
