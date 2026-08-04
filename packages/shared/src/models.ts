export type PermissionMode = "default" | "acceptEdits" | "plan";

export type CpaStatus =
  | { state: "unknown" }
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "ready"; port: number; managedByApp: boolean }
  | { state: "error"; message: string };

export type FileChangeStatus = "A" | "M";

export type FileChange = {
  path: string;
  status: FileChangeStatus;
  /** unified diff text for display */
  hunks: string;
  updatedAt: number;
  /** event-level entries newest last */
  events: Array<{
    tool: "Edit" | "Write" | "Bash";
    at: number;
    hunk: string;
  }>;
};

export type ChatRole = "user" | "assistant" | "system";

export type ToolCardState = {
  id: string;
  name: string;
  summary: string;
  status: "running" | "done" | "error";
  resultPreview?: string;
  /** Elapsed seconds while running (from tool_progress heartbeats) */
  elapsedSeconds?: number;
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

export type ChatItem =
  | { kind: "text"; id: string; role: ChatRole; text: string; streaming?: boolean }
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
  | { type: "raw"; sessionId: string; payload: unknown };
