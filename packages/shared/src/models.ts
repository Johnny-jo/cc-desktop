export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto";

export type CpaStatus =
  | { state: "unknown" }
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; port: number; managedByApp: boolean }
  | { state: "error"; message: string };

export type FileChangeStatus = "A" | "M";

/**
 * One tracked file-write operation (Edit / Write / Bash redirect).
 * Snapshots are per-event: `canRestore` means a pre-op content snapshot
 * exists, so the file can be rolled back to its state before this operation.
 */
export type FileChangeEvent = {
  id: string;
  tool: "Edit" | "Write" | "Bash";
  at: number;
  hunk: string;
  /**
   * True when a pre-op snapshot exists for this event (main-process only;
   * hydrated on IPC payloads).
   */
  canRestore?: boolean;
};

export type FileChange = {
  path: string;
  status: FileChangeStatus;
  /** unified diff text for display */
  hunks: string;
  updatedAt: number;
  /** event-level entries oldest → newest */
  events: FileChangeEvent[];
  /**
   * True when ANY event of this file has a snapshot (legacy compat for
   * UI that shows one restore affordance per file).
   */
  canRestore?: boolean;
};

export type ChatRole = "user" | "assistant" | "system";

export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
};

export type ToolCardState = {
  id: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
  resultPreview?: string;
  /** Elapsed seconds while running (from tool_progress heartbeats) */
  elapsedSeconds?: number;
  /** True when this tool call ran inside a Task/Agent subagent (parent_tool_use_id set) */
  isSubagent?: boolean;
  /** Structured todo list — populated only for TodoWrite tool calls */
  todos?: TodoItem[];
};

/** Per-turn token / cost / timing from SDK result message */
export type TurnUsage = {
  durationMs?: number;
  durationApiMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  numTurns?: number;
};

/** Accumulated usage for a whole desktop session */
export type SessionUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  turns: number;
};

export type ContextLimitSource = "cpa" | "builtin" | "override" | "default";

/** Latest context-window occupancy (not billing totals) */
export type ContextUsage = {
  usedTokens: number;
  limitTokens: number;
  ratio: number;
  source: ContextLimitSource;
  modelId: string;
  updatedAt: number;
};

export type ModelInfo = {
  id: string;
  /** Parsed context window from CPA /v1/models; undefined if unknown */
  contextLimit?: number;
};

export type AttachmentKind = "text" | "image" | "binary";

export type Attachment = {
  /** Original filename */
  name: string;
  /** Absolute file path (main process reads it) */
  path: string;
  /** File size in bytes */
  size: number;
  /** MIME type guess */
  mimeType: string;
  kind: AttachmentKind;
};

/** Supported media types for image content blocks. */
export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMimeType; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export type UserPrompt = {
  text: string;
  attachments: Attachment[];
};

export type ReadAttachmentResult =
  | { ok: true; block: UserContentBlock }
  | { ok: false; error: string };

export type ChatItem =
  | {
      kind: "text";
      id: string;
      role: ChatRole;
      text: string;
      streaming?: boolean;
      /**
       * SDK-persisted user message uuid (real user turns only). Bound by
       * ordinal matching against SDK user messages; enables message-level
       * rewind (code checkpoint + conversation truncation).
       */
      sdkMsgId?: string;
    }
  | { kind: "tool"; id: string; tool: ToolCardState }
  | { kind: "usage"; id: string; usage: TurnUsage };

/** App-local slash command (composer `/` menu) */
export type SlashCommandItem = {
  name: string;
  description: string;
  /** If true, insert as text and send; else handled by app */
  sendAsPrompt?: boolean;
};

/**
 * Blocking prompt from agent/SDK: MCP elicitation or user dialog.
 * Distinct from tool permission (PermissionRequest).
 */
export type UserPromptRequest = {
  requestId: string;
  sessionId: string;
  kind: "elicitation" | "dialog";
  title: string;
  message: string;
  /** form fields schema (elicitation form mode) */
  schema?: Record<string, unknown>;
  /** url mode */
  url?: string;
  dialogKind?: string;
  payload?: Record<string, unknown>;
};

export type UserPromptDecision =
  | { behavior: "accept"; content?: Record<string, unknown>; result?: unknown }
  | { behavior: "decline" | "cancel"; message?: string };

export type SessionSummary = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  status: "idle" | "running" | "error";
  /** Running totals for this session (tokens / cost / wall time) */
  usage?: SessionUsage;
  /** Latest context-window occupancy (not billing totals) */
  contextUsage?: ContextUsage;
};

export type PermissionRequest = {
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  inputPreview: unknown;
};

export type PermissionDecision =
  | { behavior: "allow"; scope: "once" | "session" }
  | { behavior: "deny"; message?: string };

export type AppSettings = {
  cpaExePath: string;
  cpaConfigPath: string;
  cpaPort: number;
  /** token never sent to renderer in getPublicSettings */
  defaultModel: string;
  models: string[];
  permissionMode: PermissionMode;
  shutdownCpaOnQuit: boolean;
  lastProjectPath?: string;
  /** Fallback window when model unknown (tokens) */
  defaultContextLimit: number;
  /** Per-model id overrides for context window */
  modelContextLimits: Record<string, number>;
  /** Configured MCP servers (JSON-safe), passed to the SDK on session start */
  mcpServers?: import("./mcp-servers").McpServersMap;
};

export type PublicSettings = Omit<AppSettings, never> & {
  hasToken: boolean;
};

export type SdkNormalizedEvent =
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "text_done"; sessionId: string; text: string }
  | { type: "tool_start"; sessionId: string; tool: ToolCardState }
  | { type: "tool_end"; sessionId: string; tool: ToolCardState }
  | {
      type: "tool_progress";
      sessionId: string;
      toolUseId: string;
      toolName: string;
      elapsedSeconds: number;
    }
  | { type: "user_message"; sessionId: string; text: string }
  | {
      type: "result";
      sessionId: string;
      ok: boolean;
      costUsd?: number;
      error?: string;
      usage?: TurnUsage;
    }
  | { type: "items_replaced"; sessionId: string; items: ChatItem[] }
  /**
   * SDK-persisted user message uuids in turn order (real user turns only,
   * tool_result frames excluded). Renderer binds them to user ChatItems by
   * ordinal for message-level rewind.
   */
  | { type: "user_msg_ids"; sessionId: string; uuids: string[] }
  | { type: "raw"; sessionId: string; payload: unknown };
